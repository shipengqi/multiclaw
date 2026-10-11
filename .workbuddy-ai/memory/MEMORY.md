# multiclaw 项目约定

## 构建 / 校验
- pnpm workspace:core / cli / dashboard + examples/dev-team。
- CI 顺序固定 **install → lint → build → typecheck → test**。cli、dashboard 的 typecheck 从
  `packages/*/dist/*.d.ts` 解析跨包类型,clean checkout 不先 build 会 TS2307 —— 不要改顺序。
- 根目录命令:`pnpm verify`(lint+build+typecheck+test,提交前跑)、`pnpm lint`(biome check .)、
  `pnpm lint:fix`、`pnpm format`、`pnpm typecheck`(=`-r typecheck`)、`pnpm test`、`pnpm test:coverage`(CI 用)。
- 发布:手动两步,无 changesets。① `bump-version.yml` → 推 `release/v<version>` → 开 release PR。
  ② `release.yml`(merged && head.ref 以 `release/v` 开头)→ build → publish → 推 tag → `gh release create`。
  - trusted publisher 匹配 **workflow 文件名 `release.yml`** → 发布步骤不能改名/拆分;job 需 `id-token: write`。
  - 文档:`RELEASING.md` / `RELEASING.zh-CN.md`;改流程要同步这两份 + `CONTRIBUTING.md` + README 入口。

## 工具链版本(互相约束)
- dashboard 无 Vite:web 客户端已移除,构建走根 `tsup` → `dist/tui.js` + `dist/tui.d.ts`。
  但 vite 仍以传递依赖存在:vitest 4 → vite 8(`engines.node ^20.19||>=22.12`)→ 这就是
  `devEngines.runtime.version` 下界 22.12 的来源;ink 8 要求 node >= 22。
- vitest 3 的 peer vite 不含 8,vitest 4 才是 `^6||^7||^8`;`@vitest/coverage-v8` peer 锁死 vitest 精确版本,
  所以三包 vitest 与根 coverage-v8 必须同版本。ink 8 peer:react >= 19.3.0(dashboard 装 19.3.0)。
- `pnpm-workspace.yaml` 设 `strictPeerDependencies: true` → peer 未满足时 install 直接失败。
- 改 `devEngines` 必须 `pnpm install --lockfile-only` 重生成 lockfile。

## Lint / Format
- Biome 2.5(单一工具管 lint+format+import 排序),根 `biome.json`。风格:2 空格、lineWidth 100、
  double quotes、asNeeded 分号、trailingCommas es5。pre-commit = husky + lint-staged。
- `noUnusedImports`/`useExhaustiveDependencies` 的修复被标 unsafe,`--write` 不自动应用,需人工判断。
- **`biome-ignore` 必须紧贴被标记行且理由写一行**;理由换行会报 `suppressions/unused` 并让原规则照旧报错。

## 测试
- vitest,测试与源码同目录(`src/**/*.test.ts`);时间用例用 `vi.useFakeTimers()`。
- 换运行时:向 `runtimeRegistry` 注册唯一 name 的 fake,不要覆盖内置 `acp`。
- 覆盖率门槛是**防倒退基线**不是目标:core 90/85/90/90,cli 50/45/40/50,dashboard 90/85/90/90。
- 事件类型:`MultiClawEvent` 含 `orchestration:warning` 与 `orchestration:stages`。消费方 switch 需 default 兜底。
- **新结果字段优先挂 `OrchestratorResult`,不新增事件**。
- **断言不变量,不要断言结果**。**写完回归测试先临时回退修复确认它变红**。

## Agent 定义(core)
- `AgentDefinition.description`(静态角色,恒定;12 个内置预设各一句 ≤24 字符小写动词短语,`agents/index.test.ts` 用 it.each 卡住)
  vs `taskTitle`(per-turn,由 Orchestrator 从 leader 的 `task-plan.json` 就地覆写)。首屏渲染 `taskTitle ?? description`。
- **leader 是三态路由器**:run / reply / ask。`run` 的 id 永远是配置子集,未知 id 丢弃,命中零个 → `finishEmpty`(失败)。
- reply/ask 轮次:`success:true`、`agentResults:[]`、有 `reply`,**不发 `orchestration:start`**。

## Runtime 抽象(core)
- `AgentRuntime` **是已发布导出 → 加宽是破坏性变更**。`describe(): Promise<RuntimeInfo>`;
  `RuntimeInfo.capabilities` 描述**适配器实际实现了什么**(没接的能力别声明 true)。
- `AgentTask.onEvent?: (e: RuntimeEvent) => void`;`RuntimeEvent` 是带 `runId`/`agentId`/`seq` 信封的 union。
- **唯一可用 runtime 是 `acp`**(ClaudeRuntime 已于 2026-10-11 退役)。默认值为 `"acp"`。
- **`AgentDefinition.models` 的键是 runtime 名**:`agent.models?.[agent.runtime ?? "acp"]`。
  12 个 preset 已改成 `models: { acp: ... }`(原为 `claude`,退役后静默解析成 undefined ——
  `agents/index.test.ts` 有 it.each 卡这个不变量)。改 runtime 名必须同步改 `models` 键。
- **CLI 可用性门禁只有一处**:`cli/src/lib.ts` 的 `assertRuntimesAvailable`/`availableRuntimes`;
  run/tui/init 都调它 —— **不要再各写一份**。

## ACP 接入
- SDK:`@agentclientprotocol/sdk@1.8.0`(peer `zod@4.6.5`,zod ≈8MB)。**必须懒加载**,否则拖垮 CLI 启动。
- **两个 ACP 桥(`claude-agent-acp` / `codex-acp`)是 multiclaw 自己的依赖,不是用户全局安装**:
  见 `packages/{core,cli}/package.json`(core + cli 都列)。`providers/bridge.ts` 的 `resolveExecutable()`
  优先用 PATH 上的二进制,否则从 multiclaw 自己的 `node_modules`(`require.resolve` 定位 bin)解析桥的绝对路径再 spawn。
  这样用户只需装自己的 agent(`claude`/`codex`/`opencode`),桥由 multiclaw 自带。`detect()`/`doctor` 也把 bundled
  桥算作"已安装"。`opencode` 不是桥(原生 ACP,用户自装)。版本:`claude-agent-acp@^0.89.1`、`codex-acp@^2.2.2`。
- 真实 agent:opencode 原生(`opencode acp`);codex 须经适配器 `@agentclientprotocol/codex-acp`;
  claude 没有原生 ACP,官方桥是 `@agentclientprotocol/claude-agent-acp`(bin `claude-agent-acp`)。
- **`BRIDGES` 表按 `basename` 分派 `_meta` 命名空间**(取代旧的 `META_CAPABLE_COMMANDS` Set + 二值
  `deliveryFor()`)。每个 bridge 一个 `meta(task)` 构造器 + `tools` 能力位;未登记的 bridge 无 `meta`
  → 角色提示词降级为 prompt 前缀。**投递互斥**:仅当 `meta === undefined` 才前缀(避免双份指令)。
- `_meta.claudeCode.options.tools` ≠ `--allowedTools`:前者是可用性,后者是预授权。映射略更严(fail-closed)。
- **`_meta` 命名空间因 bridge 而异**(2026-10-11 核实 codex-acp v2.2.2 源码,已按此实现):
  - `claude-agent-acp`:`_meta.systemPrompt`(string 替换预设)+ `_meta.claudeCode.options.tools`。`tools: true`。
  - `codex-acp`:`_meta.jetbrains.air.customInstructions`(string)→ `thread/start.developerInstructions`。
    `CodexAcpClient.ts:793` 无条件读取,**不要求客户端先声明 AIR**;非 string 静默忽略。
    **无工具限制落点**(全仓 grep `allowedTools` 零命中)→ `tools: false`,allowlist 直接丢弃。
  - 该能力来自 codex-acp #546,已实现但 `docs/air-extensions.md` 未文档化。
  - 刻意**不**声明 AIR(`initialize.clientCapabilities._meta.jetbrains.air`):那会把适配器输出整体
    切成 AIR 格式(diffPatch / subagent / asyncTasks),这些都没映射。只发我们真消费的那一个键。
- **`describe().capabilities.tools` 随 `command` 变化** —— 唯一 bridge 相关的能力位。
  `permissions` 恒 true(那是我们自己实现的 handler,与 bridge 无关)。
- `session/request_permission` 已接(2026-10-11):与 `task.tools` 对齐,name-first → kind 映射 → 拒绝。
- **`kind` 映射是启发式的**(fail-closed 的代价):`delete`/`move`/`think`/`switch_mode`/`other` 在
  Claude 工具集里无对应项 → 一律拒绝;MCP 工具和某些内置工具走 ACP 时仍可能被挡。已写进 `AcpRuntime.ts` 注释。
- `usage_update` 已映射为 `usage` + `cost` 事件(扩展了 `RuntimeEvent`/`AgentOutput` 类型支持 `contextTokens`/`contextSize`/`amount`/`currency`)。

## 工作区语义
- `run`(批处理)→ 每次一个 `workDir/.multiclaw/runs/run-<stamp>/`,agent cwd 在其中。
- 控制台(迭代)→ **每轮共用 `config.workDir`**,只日志按轮隔离。`App.startTurn` **不要**再覆盖 `runConfig.workDir`。
- `Orchestrator.run()` 开头必须 `clearStaleTaskPlan()`。
- **core 没有 session 概念**(`Orchestrator` 每轮新建)→ 跨轮状态只能由调用方带进来:
  `MultiClawConfig.history?: TurnRecord[]`({ requirement, reply? })→ `renderConversation()`
  → leader 提示词的 `{{conversation}}`。预算 **最近 6 轮 / 4000 字符 / 单条 600**,
  超预算**丢最旧**(最新的才是当前 requirement 要回答的),编号**绝对**不重排。
- **占位符必须无条件设值**:`renderPrompt` 只替换 context 里存在的键,缺键则 `{{conversation}}`
  之类以字面量进提示词。新增模板变量时 `Orchestrator` 构造里要 `set(key, "")` 兜底。

## TUI(`packages/dashboard`)
- Ink TUI,exports 只有 `"./tui"`;`startTui` 用 alternate screen,非 TTY 抛错。
- **状态两层**:`TurnView` 与 `TuiState extends TurnView { name; history: TurnView[]; view?: TurnView }`。
  所有面板组件只吃 `TurnView`,prop 叫 `turn` 不叫 `state`。
- `history` 只存被新一轮顶替的轮次;上限 20。`snapshot()` **逐字段写出**,不要 `...state`。
- `view` 是 detached copy;回看不动 live 焦点/滚动,回看不改写 history。
- 一轮以文字结束(reply/ask)时 `ReplyPanel` 接管 body,状态行写 `✓ answered`/`? needs your input`,**绝不写 done**。
- **keymap 地基:提示符永远持有焦点 → 裸键让位于打字**。只有 `?` 帮助、`/` 命令面板两个裸键。
- **运行中提交 = 入队**;**取消(ctrl+c / /cancel)连队列一起清**。
- 测试:渲染集成测试**不能轮询 stdout**→ 用 `onTurnStart` 拿 eventBus。按键**分块写入**。
- **`conversationTurns(state)` 从 `history` + 当前轮派生**(不另存转录本),只收 `phase === "complete"`
  的轮次(取消的轮次不发 complete → 丢弃),所以调用点在 `turn:start` 前后都无所谓。
  `App.startTurn` 经 `stateRef` 读它 —— `startTurn` 的 deps 不含 state,直接读 `state` 会拿到 stale。
- **dashboard 测的是 `dist`,不是 core 源码**:改了 core 要先 `pnpm build`,否则 dashboard
  集成测仍在跑旧 dist(症状:新断言红得莫名其妙,core 单测却全绿)。

## 环境坑(pnpm)
- 根目录**无** `.npmrc`/`.pnpmrc`,nodeLinker = 默认 isolated。新增依赖后 `.bin` 软链可能缺失报
  `vitest: command not found` —— **再跑一次 `pnpm install` 自愈**。
- 增量 install 可能把新平台二进制错写进 `node_modules/.modules.yaml` 的 `skipped`;
  `pnpm install --force` 修好;排查:`grep -n skipped node_modules/.modules.yaml`。

## 待真机验证(mock 覆盖不了,需真实 API 密钥 / 真实二进制)
- [ ] `session/request_permission`:同一份「默认 tools + 读 `secret.txt`」配置必须真返回文件内容,不再 `PERMISSION_DENIED`。
- [ ] codex-acp:角色提示词走 AIR 命名空间后的**实际指令遵从度**;工具限制缺失时的实际行为(用于拍板下方开放问题)。
- [ ] `multiclaw init`:在无 claude CLI 但装了 `claude-agent-acp` 的环境里的表现。

## 开放问题
- **codex 的工具限制**(命名空间分派已实现,此项待拍板):角色提示词已走 AIR 命名空间,但 codex
  **无工具限制落点**,当前是 `tools: false` + 丢弃 allowlist(**不报错**)。
  要改成「显式配置 `tools` 时硬报错」必须先给 `AgentTask` 加字段区分显式配置与默认值 ——
  `AgentRunner.ts:50` 恒给 `tools` 兜底 `["Read","Write","Bash"]`,运行时**分不出来**,
  直接报错会把 opencode/codex 全打死。
- **跑过流水线的轮次不记结果**:`TurnRecord` 只有 requirement + leader 的话,没有 success/失败摘要。
  「上一轮到底跑成了没」leader 得自己去 workspace 看。若发现它常判断错,再给 `TurnRecord` 加一行摘要。
