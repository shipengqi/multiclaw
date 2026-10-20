# 真实 Provider 验证清单（手动，非 CI）

> **为什么存在**：mock 测试覆盖不了真实 ACP bridge 的行为。权限协商、`_meta` 命名空间遵从度、
> session 续接这三类问题只有在真机（真实 bridge + 真实凭证）上才会暴露，而它们恰恰是
> multiclaw 作为编排器最核心的依赖。
>
> **为什么不在 CI**：需要真实 API key / 登录态 / 特定 PATH 环境，且会消耗真实额度。
>
> **怎么用**：按章节逐项验证，把结果记入文末[记录表](#8-结果记录表)。失败的项请带上
> 「代码落点」一栏的文件名开 issue——那一栏就是该项期望行为的定义处。

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| Node / pnpm | 与 `CONTRIBUTING.md` 一致（Node `^22.12 \|\| >=24`，pnpm 12） |
| 构建 | `pnpm install && pnpm build`（CLI/dashboard 从 `packages/*/dist` 解析跨包类型） |
| 至少一个真实 provider | `opencode`（原生 ACP）/ `claude`（走 bundled `claude-agent-acp`）/ `codex`（走 bundled `codex-acp`）/ `cursor-agent` |
| 工作区 | 一个一次性临时目录，**不要**用仓库本身当 `workDir` |

验证任何一项前，先跑 `multiclaw doctor` 确认 provider 状态符合预期（见 §1）。

## 1. 环境探测：`multiclaw doctor`

Provider 目录见 `packages/core/src/providers/catalog.ts`。native ACP：`opencode`、`cursor-agent`；
bridged：`claude-agent-acp`、`codex-acp`（两者由 multiclaw 自带，用户只需装并登录自己的 agent CLI）。

| # | 步骤 | 预期 | 代码落点 |
| --- | --- | --- | --- |
| 1.1 | PATH 上装有 `opencode`，跑 `multiclaw doctor` | OpenCode 行 `✓ present`，`source` 列 = `path`，无 `bundled bridge:` 明细行 | `providers/detect.ts` |
| 1.2 | 未安装 `claude` CLI（PATH 无 `claude`，也无 `claude-agent-acp`），重跑 doctor | Claude 行 `✓ present`，`source` = `bundled`，并在表格下打印 `bundled bridge: <绝对路径>` | `providers/bridge.ts`（`resolveExecutable` 优先 PATH、兜底 bundled）+ `providers/detect.ts` |
| 1.3 | 同 1.2 但安装了 `codex` CLI | Codex 行 `✓ present`，`source` = `bundled`（除非 PATH 上有 `codex-acp`） | 同上 |
| 1.4 | config 里 agent 显式配 `tools: ["Read"]` 且 provider 为 `codex` | Config 检查段出现黄色警告：`agent(s) use a provider that cannot enforce tool allowlists: ...` | `cli/src/commands/doctor.ts`（`tools: false` 的 provider 见 catalog） |
| 1.5 | config 里 agent 的 `provider` 指向一个未安装的 provider | Config 检查段列出该 agent，`runnable: false` | `cli/src/commands/doctor.ts` + `cli/src/lib.ts`（唯一可用性门禁） |

> 1.2/1.3 是「present ≠ 用户自己装了」的证明：显示 present 可能只是 multiclaw 自带的桥在兜底。

## 2. `multiclaw init` 在「无 claude CLI、有 bundled bridge」的环境

| # | 步骤 | 预期 | 代码落点 |
| --- | --- | --- | --- |
| 2.1 | 临时从 PATH 移除 `claude`（保留 bundled 桥可解析），在空目录跑 `multiclaw init`，provider 选 Claude | 选择列表里 Claude 显示为 present（`claude-agent-acp` 可解析）；生成的 `multiclaw.config.ts` 的 `defaults.provider` 为 `"claude"` | `cli/src/commands/init.ts` + `detectProviders` |
| 2.2 | 完成 init 后查看结尾输出 | 提示 `Before your first run: run \`claude\` to log in`（auth hint），并给出 `multiclaw` / `multiclaw run` 的下一步命令 | `cli/src/commands/init.ts` 收尾段 |
| 2.3 | provider 选一个**真的什么都没装**的（如 Cursor） | init 不报错、正常生成 config，但结尾打印 `⚠ Cursor is not installed.` + install hint | 同上 |
| 2.4 | 接着在**没有 `claude` CLI** 的环境跑 `multiclaw run "say hi"` | **记录实际行为**：config 能生成、桥能拉起，但鉴权走不通。关注点是报错是否可行动（指向 `run \`claude\` to log in` 或明确的缺失二进制），而不是 cryptic 的 spawn/JSON-RPC 错误 | `runtime/AcpRuntime.ts` 的 auth 错误加 hint 逻辑；`cli/src/lib.ts` 可用性门禁只看 bridge 可解析，**不**检查 `claude` CLI 本身 |

## 3. `session/request_permission` 真机（claude-agent-acp）

背景：权限应答是 **name-first + fail-closed**——工具名在 `task.tools` 里才批准，其余一律拒绝；
默认 `tools = ["Read", "Write", "Bash"]`（未显式配置时）。拒绝会以 `raw`/`acp` 事件
（payload `{ type: "permission_rejected", … }`）显式暴露，不是静默失败。

| # | 步骤 | 预期 | 代码落点 |
| --- | --- | --- | --- |
| 3.1 | agent 不配 `tools`（用默认三项），任务：「读取 `<workDir>/secret.txt` 并原样汇报内容」；事先放入 `secret.txt` | 运行成功，agent 输出**包含文件内容**；全程无 `PERMISSION_DENIED`、无 `permission_rejected` 事件 | `runtime/AcpRuntime.ts` `decidePermission`（name-first）；`orchestrator/AgentRunner.ts` 默认 tools |
| 3.2 | 同上配置，任务改为：「删除 `<workDir>/secret.txt`」 | 删除被拒；TUI/日志可见 `permission_rejected`（name 为删除类工具）；文件仍在 | 同上；kind 兜底表 `KIND_TO_TOOLS` |
| 3.3 | 任务包含需要 `Edit`/`Grep`/`WebFetch` 的步骤 | `Edit`/`Write` 在默认 tools 内被批准；`Grep`/`Glob`/`WebFetch` **不在**三项内 → 被拒（这是预期，fail-closed 的代价） | `KIND_TO_TOOLS`（`search`/`fetch` 仅作 kind 兜底） |

> 3.1 是历史遗留的专项：bridge 早期对某些内置工具的 `name` 传递有问题，曾被误杀成
> `PERMISSION_DENIED`。若复现，先记录 bridge 版本再开 issue。

## 4. codex-acp：AIR `customInstructions` 遵从度

背景：codex 没有 `_meta.systemPrompt` 落点，角色提示词走 `_meta.jetbrains.air.customInstructions`
（→ `thread/start.developerInstructions`）。刻意**不**声明 AIR 客户端能力（那会把输出切成
diffPatch/subagent 等未映射格式），只发这一个 key。

| # | 步骤 | 预期 | 代码落点 |
| --- | --- | --- | --- |
| 4.1 | 给 leader 或某 agent 一个**可观测**的系统提示，例如「每次回答必须以 `CODEX-OK` 开头」；用 codex provider 跑一轮 | 指令被真实遵从（输出带 `CODEX-OK`），而不是被忽略或只体现在思考段 | `providers/catalog.ts` codex `meta` + `runtime/AcpRuntime.ts` session 创建处 |
| 4.2 | 对比：同一配置改用 claude provider（走 `_meta.systemPrompt`） | 两者遵从度应同档；若 codex 明显更弱，记录现象——这决定 codex 的角色提示词策略 | 同上 |

## 5. codex：无工具限制落点时的实际行为

背景：catalog 中 codex `tools: false`（无 allowlist 落点），显式配置的 `tools` 被**静默丢弃**
（不报错），doctor 只给警告（§1.4）。开放问题：是否要改成「显式配置即硬报错」。

| # | 步骤 | 预期（记录**实际**行为） | 用途 |
| --- | --- | --- | --- |
| 5.1 | agent 显式 `tools: ["Read"]` + provider codex，任务需要写文件 | 记录：agent 是否仍能写文件？（预期能——没有落点） | 为「静默丢弃 vs 硬报错」的拍板提供事实依据（硬报错需先给 `AgentTask` 加显式配置标记） |

## 6. Session 续接：`/retry` 与 `multiclaw run --resume`

背景：`sessionId` 只在成功路径捕获；续接靠 `session/load`，且**仅在 agent 广告了
`loadSession` 能力时**发送——不满足时报错，绝不假装续上。

| # | 步骤 | 预期 | 代码落点 |
| --- | --- | --- | --- |
| 6.1 | 跑一轮让某 agent 成功（产生 sessionId），在 TUI 执行 `/retry <该 agent>` | notice 显示 `… continues its session`；该 agent 走 `session/load` 而非冷启动 | `dashboard/src/tui/App.tsx` `/retry` + `runtime/AcpRuntime.ts` session/load |
| 6.2 | 对失败 agent（无 sessionId）执行 `/retry` | notice 显示 `… starts fresh`；若其 `dependsOn` 指向未重跑的 agent，追加 `… runs without <dep>` | `core/src/utils/resumePlan.ts`（与 `selectAgents` 的裁剪规则一致） |
| 6.3 | `multiclaw run --resume`（默认最新 run） | 横幅形如 `Resuming <runDir> (N agents) — dev starts fresh; …`；workDir 落在原 run 目录，agent 在原有工作目录续写 | `cli/src/commands/run.ts` + `cli/src/commands/resume.ts` |
| 6.4 | 对一个**被取消**的 run 执行 `--resume` | resume 集合 = 报告里**全部** agentResults（含 `status: "cancelled"` 的——取消也会留下 result）；abort 时**尚未开始**的后续 stage 的 agent 不在报告里，因此不被 resume，其下游的依赖会被裁剪（横幅会说明） | 同上；`orchestrator/AgentRunner.ts`（abort 记为 `cancelled` 并返回 result）、`cli/src/commands/resume.ts` |

## 7. Cursor（可选，低优先级）

`cursor-agent` 的 `_meta` 支持**未经真实验证**，catalog 里 `meta: undefined` → 角色提示词降级为
prompt 前缀。若环境允许，验证 §4.1 的可观测指令在 cursor 上的遵从度，并确认 `agent --version`
的 confirm 逻辑（`/cursor/i`）不会把别的 `agent` 二进制误判成 Cursor。

## 8. 结果记录表

| 日期 | 环境（OS / Node / bridge 版本 / provider 版本） | 验证人 | 通过项 | 失败项 | 备注 / issue |
| --- | --- | --- | --- | --- | --- |
| _待填_ | | | | | |

**失败时**：先比对「代码落点」一栏确认期望行为是否仍如描述；若描述与行为一致但真机不符，
带 bridge 版本 + 最小复现 config 开 issue，并更新下表与对应章节的预期。
