# multiclaw 项目约定

> 细分主题见 `topics/`：`acp-and-steering.md`（ACP 桥/权限/steering）、`tui-internals.md`（TUI 组件与测试细节）、`upgrade-doctor.md`（upgrade/doctor/真机验证/开放问题）。改动这些领域前先读对应文件。

## 定位
- 不做看板/项目管理平台；核心是多 agent 编排，改进聚焦 TUI 的 agent 交互。

## 构建 / 工具链
- pnpm workspace：core / cli / dashboard + examples/dev-team。CI 固定 install→lint→build→typecheck→test（cli/dashboard 从 `packages/*/dist/*.d.ts` 取类型，不先 build 会 TS2307）。
- 根命令：`pnpm verify`(lint+build+typecheck+test)、`lint`、`lint:fix`、`format`、`typecheck`、`test`、`test:coverage`。
- `--filter` 用 package name：core=`@multiclawcli/core`、dashboard=`@multiclawcli/dashboard`，**cli 的 name 是 `multiclaw`**（`--filter @multiclawcli/cli` 静默 exit 0）。
- `verify` 不查覆盖率；新增未测 core 文件会让 CI 红 → 配测试或跑 `test:coverage`。
- 发布两步：`bump-version.yml` 推 `release/v<version>` 开 PR → `release.yml`（merged && head.ref 以 release/v 开头）build/publish/tag/`gh release create`。trusted publisher 认 workflow 文件名 `release.yml`（不能改名/拆分，job 需 `id-token: write`）；改流程同步 RELEASING*.md + CONTRIBUTING + README。
- 2026-10-31 实测：vitest 5.0.4、biome 2.6.2、ts 7.0.2、ink 8.0.0、react 19.3.1、`@agentclientprotocol/sdk` 2.0.2（以 node_modules 为准）。
- dashboard 无 Vite（web 客户端已移除，tsup→dist/tui.js）；node 下界 22.12（vitest→vite engines），ink 8 要 node>=22。
- `@vitest/coverage-v8` peer 锁死 vitest 精确版本 → 三包 vitest 与根 coverage-v8 同版本。`strictPeerDependencies: true`。改 `devEngines` 必须 `pnpm install --lockfile-only`。

## Lint / Format
- Biome（lint+format+import 排序），根 `biome.json`；pre-commit = husky + lint-staged。`noUnusedImports`/`useExhaustiveDependencies` 的修复是 unsafe，`--write` 不应用。
- `biome-ignore` 紧贴被标记行且理由写一行（换行报 suppressions/unused，原规则照旧报错）。

## 测试
- vitest，测试与源码同目录；时间用 `vi.useFakeTimers()`。换运行时向 `runtimeRegistry` 注册唯一 name 的 fake，别覆盖 `acp`。
- 覆盖率门槛（防倒退基线）：core 90/85/90/90、cli 50/45/40/50、dashboard 90/85/90/90。
- `MultiClawEvent` 含 `orchestration:warning`/`orchestration:stages`，消费方 switch 要有 default。**新结果字段优先挂 `OrchestratorResult`，不新增事件**。
- **断言不变量不断言结果**；回归测试写完先临时回退修复确认变红。
- 全量并发跑末尾 `fs.rmSync(tmpdir)` 偶发 ENOTEMPTY（safe-delete shim 竞争），单跑该文件绿 → 重跑即可。

## Agent 定义（core）
- `description` 静态角色（12 preset 各一句 ≤24 字符小写动词短语，`agents/index.test.ts` it.each 卡住）vs `taskTitle`（per-turn，leader 的 task-plan.json 就地覆写）；首屏 `taskTitle ?? description`。
- leader 三态 run/reply/ask。`run` 的 id 永远是配置子集，未知丢弃，命中零个 → `finishEmpty`（失败）。reply/ask 轮：`success:true`、`agentResults:[]`、有 `reply`，**不发 `orchestration:start`**。
- preset `tools` 是**审批白名单，不是能力上限**：默认含 Bash → `rm` 不经审批直接删文件；不含 `mcp__*` → MCP 工具一律被拒。`toolPermitted` 是 name 优先的**大小写不敏感通配**（`*`=任意串，`mcp__graft__*` 覆盖整个 server；其余字面量，无字符类），name 缺失才退回 kind（`KIND_TO_TOOLS`: read/edit/execute/search/fetch）。architect/code-reviewer/ui-designer/devops=`["Read","Write"]`、pm=`["Write"]`、leader=`["Read","Bash"]`、tester/frontend=`["Read","Write","Bash"]`。
- **权限模式（2026-10-31 用户拍板，反转旧规则）**：`auto`（默认）=白名单内放行、外拒绝；`ask`=白名单内**直接放行不问**、外**交给 `onPermission` 问人**（无 handler 时 fail-closed 选 `reject_once`）；`deny`=全拒。旧规则「ask 也为白名单内工具弹窗、人工同意不能超出白名单」已废弃；README 中英 + `docs/provider-verification.md` §3 已同步。

## Runtime（core）
- `AgentRuntime` 是已发布导出 → 加宽是破坏性变更。`describe(): Promise<RuntimeInfo>`；`capabilities` 只描述适配器真实现了什么。
- `AgentTask.onEvent?`；`RuntimeEvent` 带 runId/agentId/seq 信封。
- 唯一 runtime 是 `acp`（ClaudeRuntime 2026-10-11 退役）；`AgentDefinition.models` 的键是 **runtime 名**（`models: { acp: ... }`）。
- CLI 可用性门禁只有一处：`cli/src/lib.ts` 的 `assertRuntimesAvailable`/`availableRuntimes`（run/tui/init 都调）。用 `resolveCommand(agent, config)` 解析真实命令再 `describe({command})`；只读 `agent.command` 会把 `provider:"claude"` 误判成 opencode 默认。

## 工作区语义
- `run`（批处理）→ 每次 `workDir/.multiclaw/runs/run-<stamp>/`，agent cwd 在其中；控制台（迭代）→ 每轮共用 `config.workDir`，只日志按轮隔离，`App.startTurn` 不要覆盖 `runConfig.workDir`。
- `Orchestrator.run()` 开头必须 `clearStaleTaskPlan()`。
- core 无 session 概念 → 跨轮状态由调用方带：`MultiClawConfig.history?: TurnRecord[]` → `renderConversation()` → leader 的 `{{conversation}}`。预算最近 6 轮 / 4000 字符 / 单条 600，超预算丢最旧，编号绝不重排。
- **占位符必须无条件设值**（`renderPrompt` 只替换存在的键，缺键会把 `{{x}}` 字面量塞进提示词）。

## 失败后继续 / 恢复
- 同进程内 agent 会话跨轮复用（`AgentSessionManager` 由 `App.sessionsRef` 持有，fingerprint 不变就沿用同一 ACP session）→ turn 失败后直接再提一句即带上下文继续。
- `/retry [id]`（idle）：只重跑失败的 agent（或指定 id；acceptance 失败时整队减 reviewer）；**失败的 agent 没有 sessionId → 冷启动**；`dependsOn` 指向不在重试集合的已配置 agent 会被剪掉；notice 用 `describeResumePlan` 说明谁冷启动、谁少了依赖。leader 在重试集合里 → 退回 `startTurn(requirement)` 重路由。
- `/replay [turn]` 用旧 requirement 整轮重跑；`/fork [turn]` 只填输入框不跑；`/task` 会 reset 会话，别用它续任务。
- 重启只恢复边界不续会话：`console/session.json`(v1) 记 inFlight/queue/taskStart/pending；`restoreConsole` 把 inFlight 还原成 `phase:"complete"+interrupted:true`，未回报的 agent 标 `cancelled`，队列还原且**默认暂停**（`/continue`），pending 决策丢弃并报数。不变量：①挂载时不写日志；②去重靠 `inFlight.turn > last.turn`；③只有被杀才 interrupted；④interrupted 进 conversation（cancelled 不进）；⑤不代答、不 resume 本进程没有的 session。写盘走 `atomic.ts: writeJsonFile`，`cleanup()` 要 await `pendingWrite`。
- 重启后 `state.agents` 为空 → `/retry` 报 "nothing to retry yet"；要继续只能 `/replay` 或提新要求（产物仍在 workDir）。
- 真正续会话的是批处理：`multiclaw run --resume [path|latest]` 读 `logs/report.json` 的 `sessionId` → `AgentRunner` 传 `task.sessionId` → `AcpRuntime` 调 `session/load`；runtime 未广告 `loadSession` 抛 PermanentError。TUI 不落 report.json，用不上这条路。

## 环境坑
- 根目录无 `.npmrc`，nodeLinker=isolated。新增依赖后 `.bin` 软链可能缺失（`vitest: command not found`）→ 再 `pnpm install` 自愈；新平台二进制被写进 `.modules.yaml` 的 skipped → `pnpm install --force`。
- PATH 上有两个桥（`~/.workbuddy-ai/binaries/node/versions/22.22.2-6/bin/`）：`claude-agent-acp` 0.89.1、`codex-acp` 2.2.2。`resolveExecutable` 优先 PATH → 真机验证跑的是 PATH 那份，先 `which -a`。
- bundled `claude-agent-acp@0.95.0` 原生二进制（darwin-arm64，122MB）本机下载超时 → `session/new` 报 `Claude native binary not found`；doctor 报出版本不代表会话能跑。
- 本机全局 multiclaw 是 npm 装的 **0.6.3**，仓库 0.6.2 → 解释线上行为前先核对版本。
