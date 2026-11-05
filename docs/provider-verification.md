# 真实 Provider 验证清单（手动，非 CI）

> **为什么存在**：mock 测试覆盖不了真实 ACP bridge 的行为。权限协商、`_meta` 命名空间遵从度、
> session 续接这三类问题只有在真机（真实 bridge + 真实凭证）上才会暴露，而它们恰恰是
> multiclaw 作为编排器最核心的依赖。
>
> **为什么不在 CI**：需要真实 API key / 登录态 / 特定 PATH 环境，且会消耗真实额度。
>
> **怎么用**：按章节逐项验证，把结果记入文末[记录表](#9-结果记录表)。失败的项请带上
> 「代码落点」一栏的文件名开 issue——那一栏就是该项期望行为的定义处。

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| Node / pnpm | 与 `CONTRIBUTING.md` 一致（Node `^22.12 \|\| >=24`，pnpm 12） |
| 构建 | `pnpm install && pnpm build`（CLI/dashboard 从 `packages/*/dist` 解析跨包类型） |
| 至少一个真实 provider | `opencode`（原生 ACP）/ `claude`（走 bundled `claude-agent-acp`）/ `codex`（走 bundled `codex-acp`）/ `cursor-agent` |
| 工作区 | 一个一次性临时目录，**不要**用仓库本身当 `workDir` |

验证任何一项前，先跑 `multiclaw doctor` 确认 provider 状态符合预期（见 §1）。

> **先确认你跑的是哪个二进制。** `resolveExecutable` 优先用 PATH 上的桥，只有找不到才回落到
> multiclaw 自带的 bundled 版本。开发机上 PATH 里常常已经有一份（比如另一个工具装的
> `claude-agent-acp`），于是「我以为在验 0.95.0」实际验的是 PATH 上的 0.89.1。开始前先跑
> `which -a claude-agent-acp codex-acp`，把版本记进结果表。

## 1. 环境探测：`multiclaw doctor`

Provider 目录见 `packages/core/src/providers/catalog.ts`。native ACP：`opencode`、`cursor-agent`；
bridged：`claude-agent-acp`、`codex-acp`（两者由 multiclaw 自带，用户只需装并登录自己的 agent CLI）。

| # | 步骤 | 预期 | 代码落点 |
| --- | --- | --- | --- |
| 1.1 | PATH 上装有 `opencode`，跑 `multiclaw doctor` | OpenCode 行 `✓ present`，`source` 列 = `path`，无 `bundled bridge:` 明细行 | `providers/detect.ts` |
| 1.2 | 未安装 `claude` CLI（PATH 无 `claude`，也无 `claude-agent-acp`），重跑 doctor | Claude 行 `✓ present`，`source` = `bundled`，并在表格下打印 `bundled bridge: <绝对路径>` | `providers/bridge.ts`（`resolveExecutable` 优先 PATH、兜底 bundled）+ `providers/detect.ts` |
| 1.3 | 同 1.2 但安装了 `codex` CLI | Codex 行 `✓ present`，`source` = `bundled`（除非 PATH 上有 `codex-acp`） | 同上 |
| 1.4 | config 里 `permissions: { mode: "ask" }` 且未提供 `onRequest`，跑 `multiclaw run` | 开跑前打印 `Warning: permission mode is "ask" but no permissions.onRequest handler is configured — every tool call will be refused.`；实际每次工具调用都被拒 | `cli/src/commands/run.ts`（`resolvePermissionMode` + 警告）+ `runtime/AcpRuntime.ts` |
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

背景：权限应答由 `permissions.mode` 决定，没有白名单、没有按工具名的过滤：

| mode | 行为 |
| --- | --- |
| `auto`（`run` 默认） | 每个请求都选 `allow_once`，不弹任何提示 |
| `ask`（控制台默认） | 每个请求都交给 `onPermission`；没有 handler 时 fail-closed |
| `deny` | 每个请求都拒绝 |

每次拒绝都会以 `raw`/`acp` 事件（payload `{ type: "permission_rejected", … }`）显式暴露，带工具名，
`source` 区分拒绝来源：`mode`（deny）、`no-handler`（ask 但没有处理函数）、`user`（人工点了拒绝）。

> `auto` 不是沙箱：它批准的是 provider 发来的请求，`Bash` 仍能 `rm`、能 `grep`。README 里
> 「这不是沙箱，也不是细粒度的路径或命令授权」是准确表述。

| # | 步骤 | 预期 | 代码落点 |
| --- | --- | --- | --- |
| 3.1 | `auto`（默认），任务：「读取 `<workDir>/secret.txt` 并原样汇报内容」；事先放入 `secret.txt` | 运行成功，agent 输出**包含文件内容**；全程无 `PERMISSION_DENIED`、无 `permission_rejected` 事件 | `runtime/AcpRuntime.ts`（auto 分支） |
| 3.2 | 同上配置，任务改为：「用 shell 命令删除 `<workDir>/secret.txt`」 | **记录实际行为**：auto 下不会被拦——执行成功、文件被删、全程无审批请求 | 同上 |
| 3.3 | `ask` + 控制台，任务触发写文件 | 权限栏出现，展示 agent、工具输入与 provider 选项；选 allow 后继续；选 reject 后流里出现 `permission_rejected`，`source: "user"`，带工具名 | `runtime/AcpRuntime.ts`（ask 分支）+ `dashboard/src/tui/interaction.ts` |
| 3.4 | `deny`，任意需要工具的任务 | 每次调用都被拒；流里出现 `permission_rejected`，`source: "mode"`；warning 行点名被拒的工具 | `runtime/AcpRuntime.ts`（deny 分支） |
| 3.5 | `ask` 但未提供 `onRequest`（如 `multiclaw run`） | 每次调用都被拒；`permission_rejected` 的 `source` 为 `no-handler` | `runtime/AcpRuntime.ts` + `orchestrator/AgentRunner.ts` |

> 3.1 是历史遗留的专项：bridge 早期对某些内置工具的 `name` 传递有问题，曾被误杀成
> `PERMISSION_DENIED`。若复现，先记录 bridge 版本再开 issue。

## 4. codex-acp：AIR `customInstructions` 遵从度

背景：codex 没有 `_meta.systemPrompt` 落点，角色提示词走 `_meta.jetbrains.air.customInstructions`
（→ `thread/start.developerInstructions`）。刻意**不**声明 AIR 客户端能力（那会把输出切成
diffPatch/subagent 等未映射格式），只发这一个 key。

| # | 步骤 | 预期 | 代码落点 |
| --- | --- | --- | --- |
| 4.1 | 给某个 team agent 一个**可观测**的系统提示，例如「每次回答必须以 `CODEX-OK` 开头」；用 codex provider 跑一轮 | 指令被真实遵从（输出带 `CODEX-OK`），而不是被忽略或只体现在思考段 | `providers/catalog.ts` codex `meta` + `runtime/AcpRuntime.ts` session 创建处 |
| 4.2 | 对比：同一配置改用 claude provider（走 `_meta.systemPrompt`） | 两者遵从度应同档；若 codex 明显更弱，记录现象——这决定 codex 的角色提示词策略 | 同上 |

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

## 8. 中途纠偏（steering）

背景：`_session/steering` 不是 ACP 标准，是两个 bridge 各自实现的扩展，能力靠
`InitializeResponse._meta.steering.supported === true` 广告（见 `runtime/AcpRuntime.ts` 的
`advertisesSteering`）。所以「这个 provider 支持不支持」只能实测，不能从文档推。

| # | 步骤 | 预期（记录**实际**行为） | 代码落点 |
| --- | --- | --- | --- |
| 8.1 | 开一个会话，**空闲**时调 `session.supplement("…")` | 返回 `{status:"idle"}`，且会话随后仍能正常 `prompt` | `AgentSessionManager.supplement`（只投 `running` 会话）+ `AcpRuntime` 的 `idle` 分支 |
| 8.2 | 跑一个长任务（如「数到 200，一行一个」），在**第一块流式输出之后**调 `supplement`（例如「停止计数，只回 BANANA」） | 返回 `{status:"injected"}`，且后续输出真的改变 | `AcpRuntime.supplement`（`_session/steering` + `STEER_ACK_MS`） |
| 8.3 | 用裸 ACP client 绕过 runtime 的守卫，对**空闲**会话直接发 `_session/steering`，带 `_meta.steering.idleBehavior = "promptRequired"` | 记录 `outcome`：`promptRequired` 表示 bridge 没自起 turn；`startedNewTurn` 表示它起了，需要 `session/cancel` 清场 | 同 8.2；`startedNewTurn` 分支 |

> 2026-10-31 实测（claude-agent-acp **0.89.1 / 0.95.0** 加 haiku；codex-acp **2.2.2 / 2.5.0**；
> opencode 1.19.0）：两个 bridge 都广告 `supported: true`，opencode 不广告（`supplement: false`）。
> 8.1 三家都符合预期。支持 steering 的两家在 8.2 都返回 `injected`，但**送达≠照做**：
> claude 0.89.1 / 0.95.0 在数到 4 / 36 时停止计数并回 BANANA；codex 2.2.2 数满 200 才回，
> 2.5.0 数到 6 就回。这些是特定任务与版本的观测，不保证其他任务或后续版本的生效时机。
> 8.3 在 claude bridge 0.93.0 与 codex-acp 2.2.2 上结果相反：claude 回 `{"outcome":"promptRequired","reason":"noRunningTurn"}`（1ms、不起
> turn、不调模型），codex 回 `{"outcome":"startedNewTurn"}` 并且真的开跑——所以那条守卫是
> 必需的。清场时 `session/cancel` **必须以通知发出**（按 request 发会被 `-32601` 打回），
> 发出后流在两个 in-flight chunk 后停住。
>
> 版本覆盖说明：8.3 的裸 ACP 空闲请求与取消路径仅验证了 Claude **0.93.0** 和 Codex **2.2.2**，
> 没有在 0.95.0 / 2.5.0 上重跑。8.1/8.2 验证了 Claude 0.89.1（PATH）、0.95.0（`npx` 安装的
> multiclaw 0.6.1 所带 bridge）以及 Codex 2.2.2 / 2.5.0；Codex 2.5.0 steering 后的下一次 READY
> prompt 也成功。最新 probe 使用本地构建的 core 与 npm 安装的 bridge，**不是已发布 CLI 的完整
> 实任务端到端测试**。仓库 pnpm 安装的 Claude 原生二进制下载超时，但 `npx` 安装的副本可建会话；
> 复验时应明确选中实际使用的 bridge 路径与版本。
>
> **未验**：cursor-agent（catalog 里 `meta: undefined`）。

## 9. 结果记录表

| 日期 | 环境（OS / Node / bridge 版本 / provider 版本） | 验证人 | 通过项 | 失败项 | 备注 / issue |
| --- | --- | --- | --- | --- | --- |
| 2026-10-31 | macOS 27.0.1 arm64 / Node 22.22.2 / claude-agent-acp 0.89.1（PATH）、0.93.0（§8.3 裸 ACP）+ 0.95.0（npm 装出的 0.6.1）+ codex-acp 2.2.2 / 2.5.0 / claude 2.1.278、codex-cli 0.162.1、opencode 1.19.0 | multiclaw dev session（真实 API 额度） | §3.1、§4.1、§4.2、§6（`session/load` 跨会话续接）、§8.1/8.2（Claude 0.89.1 / 0.95.0、Codex 2.2.2 / 2.5.0）；§8.3（仅 Claude 0.93.0、Codex 2.2.2） | §3.2/§3.3 **原预期**（已按实测改正，非代码缺陷） | §1.x、§2.x、§5、§6.1–6.3（TUI/CLI 层）、§7 未跑；steering 的生效时机随 codex-acp 版本变（2.2.2 跑完再应用、2.5.0 当场打断） |
| _待填_ | | | | | |

**失败时**：先比对「代码落点」一栏确认期望行为是否仍如描述；若描述与行为一致但真机不符，
带 bridge 版本 + 最小复现 config 开 issue，并更新下表与对应章节的预期。
