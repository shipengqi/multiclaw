# multiclaw 项目约定

## 构建 / 校验
- pnpm workspace:core / cli / dashboard + examples/dev-team。
- CI 顺序固定 **install → lint → build → typecheck → test**。cli、dashboard 的 typecheck 从
  `packages/*/dist/*.d.ts` 解析跨包类型,clean checkout 不先 build 会 TS2307 —— 不要改顺序。
- 根目录命令:`pnpm verify`(lint+build+typecheck+test,提交前跑)、`pnpm lint`(biome check .)、
  `pnpm lint:fix`、`pnpm format`、`pnpm typecheck`(=`-r typecheck`)、`pnpm test`、`pnpm test:coverage`(CI 用)。
- 发布:手动两步,无 changesets。
  ① `bump-version.yml`(workflow_dispatch)→ 同步三包 version → 推 `release/v<version>` → 开 release PR。
  ② `release.yml`(pull_request closed && merged && 同仓 && head.ref 以 `release/v` 开头)→ build →
  `pnpm -r --filter "./packages/*" publish` → 推 `v<version>` tag → `gh release create`。
  - 鉴权:npm trusted publishing(OIDC),仓库无任何 secret。trusted publisher 匹配 **workflow 文件名 `release.yml`**
    → 发布步骤不能改名/拆分;job 需 `id-token: write`。pnpm 原生支持 OIDC。
  - 两个 workflow 都不推 main,所以不需要规则集 bypass。代价:`GITHUB_TOKEN` 开的 release PR 不触发任何
    workflow(无 CI);若加 required checks 会卡住它。
  - 文档:`RELEASING.md` / `RELEASING.zh-CN.md`;改流程要同步这两份 + `CONTRIBUTING.md` + README 入口。

## 工具链版本(互相约束)
- dashboard 无 Vite:web 客户端已移除,构建走根 `tsup` → `dist/tui.js` + `dist/tui.d.ts`。
  但 vite 仍以传递依赖存在:vitest 4 → vite 8(`engines.node ^20.19||>=22.12`)→ 这就是
  `devEngines.runtime.version` 下界 22.12 的来源;ink 8 要求 node >= 22。
- vitest 3 的 peer vite 不含 8,vitest 4 才是 `^6||^7||^8`;`@vitest/coverage-v8` peer 锁死 vitest 精确版本,
  所以三包 vitest 与根 coverage-v8 必须同版本。ink 8 peer:react >= 19.3.0(dashboard 装 19.3.0)。
- `pnpm-workspace.yaml` 设 `strictPeerDependencies: true` → peer 未满足时 install 直接失败。
- 改 `devEngines` 必须 `pnpm install --lockfile-only` 重生成 lockfile(记在 importers["."]),否则 CI frozen-lockfile 失败。

## Lint / Format
- Biome 2.5(单一工具管 lint+format+import 排序),根 `biome.json`。风格:2 空格、lineWidth 100、
  double quotes、asNeeded 分号、trailingCommas es5。pre-commit = husky + lint-staged。
- `noUnusedImports`/`useExhaustiveDependencies` 的修复被标 unsafe,`--write` 不自动应用,需人工判断。
- **`biome-ignore` 必须紧贴被标记行且理由写一行**;理由换行会报 `suppressions/unused` 并让原规则照旧报错。

## 测试
- vitest,测试与源码同目录(`src/**/*.test.ts`);时间用例用 `vi.useFakeTimers()`。
- 换运行时:向 `runtimeRegistry` 注册唯一 name 的 fake,不要覆盖内置 `claude`。
- 覆盖率门槛在各包 `vitest.config.ts` 的 `coverage.thresholds`,是**防倒退基线**不是目标:
  - core 90/85/90/90,exclude `src/types|agents|testing/**`、`src/index.ts`
  - cli 50/45/40/50,exclude `src/index.ts`、`src/lib.ts`
  - dashboard 90/85/90/90,**`coverage.include` 只列四个带决策的模块**:`tui/state.ts`、`format.ts`、
    `commands.ts`、`layout.ts`;App.tsx/index.ts/components/*.tsx 是终端胶水,不进分母。改 include = 改口径。
  - vitest 4 的 v8 provider 把未加载文件的 branches/functions 也计入分母,升级时这两项会跌,属口径变化。
- 事件类型:`MultiClawEvent` 含 `orchestration:warning` 与 `orchestration:stages`(architect 的 plan 在第一阶段后
  重新分组时补发,因为 `orchestration:start` 只能带分组前 stages)。消费方 switch 需 default 兜底。
- **新结果字段优先挂 `OrchestratorResult`,不新增事件**:`orchestration:complete` 的 payload 就是它,`reply` 即此例。
- **断言不变量,不要断言结果**:验证「运行中输入排队」要记 `inFlight` 峰值断言 `peak===1`,只断言「两轮都跑完」
  并发也能满足。**写完回归测试先临时回退修复确认它变红**,否则不知道测试是否空转。

## Agent 定义(core)
- `AgentDefinition.description`(静态角色,恒定;12 个内置预设各一句 ≤24 字符小写动词短语,新增内置 agent 必须
  一起加,`agents/index.test.ts` 用 it.each 卡住)vs `taskTitle`(per-turn,由 Orchestrator 从 leader 的
  `task-plan.json` 就地覆写,开跑前必空)。首屏渲染 `taskTitle ?? description`。
- **leader 是三态路由器**(`types/leader.ts` + `utils/leaderDecision.ts`):`{"mode":"run","run":[...]}` /
  `{"mode":"reply","message"}` / `{"mode":"ask","message"}`。不带 mode 的 `{"run":[...]}` 仍按 run 处理。
  - **无 plan JSON 时 leader 的散文就是回答(reply)** —— 这是「输入 hello 不烧掉整支团队」的全部实现。
  - leader 失败/输出全空 → warning + 回退跑完整团队。`run` 的 id 永远是配置子集,未知 id 丢弃,命中零个 → `finishEmpty`(失败)。
  - reply/ask 轮次:`success:true`、`agentResults:[]`、有 `reply`,**不发 `orchestration:start`**(否则 UI 画出不存在的 stage)。
  - 改 `{"run":...}` 契约要同步 `Orchestrator.run.test.ts` 与 `utils/leaderDecision.test.ts`。

## Runtime 抽象(core)—— 已加宽(commit `3169260`)
- `AgentRuntime` **是已发布导出 → 加宽是破坏性变更**;当时只有 claude 一个 runtime,故无兼容层。
  - `describe(): Promise<RuntimeInfo>` 取代 `checkAvailable()`;`RuntimeInfo.capabilities` 描述**适配器实际实现了什么**
    (Claude 的 `permissions`/`images`/`sandbox` 都是 false —— 没接的能力别声明,否则编排器会等一个永不到来的事件)。
  - `AgentTask.onEvent?: (e: RuntimeEvent) => void` 取代 `onOutput`;`RuntimeEvent` 是带 `runId`/`agentId`/`seq` 信封的 union
    (run_started / message / message_delta / tool_call / tool_result / plan / usage / cost / raw / run_finished / run_error)。
  - `AgentTask.sessionId` / `resume`;`AgentOutput.{sessionId,usage,costUsd,stopReason}`。
- **CLI 可用性门禁只有一处**:`cli/src/lib.ts` 的 `assertRuntimesAvailable`(硬门,throw)/ `availableRuntimes`(advisory);
  run/tui/init 都调它 —— **不要再各写一份**。
- `ClaudeRuntime` 走 `--output-format stream-json --verbose --include-partial-messages`,NDJSON 行缓冲;
  **文本恰好一次**:delta 出现后丢弃重复的 assistant 文本块(run-scoped `sawAgentDelta`,刻意如此,勿改)。
  - **坑**:stdout 分块解码必须用**有状态**的 `StringDecoder`(或 `setEncoding("utf8")`);
    `buffer += d.toString()` 是逐 chunk 无状态解码,会把跨块的多字节 UTF-8(中文/emoji)解成 U+FFFD(已实测)。
  - `AgentRunner` 把 `onEvent` 文本事件翻译回既有 `agent:output` 总线事件 → **TUI 不知道 runtime 变了**。
- ~~计划是两层并存~~ **已变更(用户拍板 2026-10-11)**:目标是把 `claude` 迁到 ACP 并**退役 `ClaudeRuntime`**。
  原方案文档 `ACP_INTEGRATION_PLAN.zh-CN.md` 已删除(内容过时,且引用了已删除的调研文件)。
  但**「先加宽接口再上 ACP」这条判断仍然成立** —— 正因为先做了 `3169260`,`AcpRuntime` 才能只是该接口的又一个实现,
  协议形状没有泄漏进 core。

## ACP 接入(进行中)
- SDK:`@agentclientprotocol/sdk@1.8.0`(peer `zod@4.6.5`,zod 约 8MB)。**稳定 API**:
  `client(options?)` → `ClientApp.connectWith(stream, ctx => …)`;`agent(options?)` → `AgentApp.connect(stream)`;
  `ndJsonStream(output, input)`;`ClientContext.buildSession(cwd).withSession(async s => …)`、`s.prompt(...)`、
  `s.nextUpdate()` → `{kind:"session_update"}` | `{kind:"stop"}`;处理器 `.onRequest` / `.onNotification`。
  **已废弃**:`AgentSideConnection` / `ClientSideConnection`(改用 `client`/`agent` builder)。
- **并发已验证(PASS)**:单进程可同时持有 N 条 ACP 连接(各接一个 spawn 的 agent),无串台、时间上真重叠
  (N=5:1205ms vs 串行 ~8000ms);共享一个 client app 也 OK。SDK 内只有 per-connection WeakMap,无强制串行的全局态。
- **坑**:`import "@agentclientprotocol/sdk"` 会拉起 `zod` ≈5.2s → **multiclaw 侧必须懒加载**(用到 ACP 才 import),
  否则拖垮 CLI 启动。child 侧那个 5.7s 是 mock 的产物(真实 child 是 opencode/codex 二进制),别照搬。
- 真实 agent:opencode **原生**(`opencode acp`,1.19.0);**codex 无原生 ACP**,须经适配器
  `@agentclientprotocol/codex-acp`(2.2.2,基于 Codex App Server)。两者都需登录(`opencode auth login` /
  codex api-key | chat-gpt)。codex-acp 发**非基线扩展**(`_meta.steering`、`_auth/status_update`)→ 映射要容忍未知 `_` 前缀字段。
- **协议帧只在 stdout**;stderr 是诊断(实测混入过 git/ssh host-key 提示)。

### ACP 现状(2026-10-11 实测)
- **`claude` 没有原生 ACP**(`claude --help` 子命令里没有 `acp`)。官方桥是
  `@agentclientprotocol/claude-agent-acp`(**0.89.1**,bin `claude-agent-acp`,包官方 `@anthropic-ai/claude-agent-sdk`)。
  **别用第三方** `@zed-industries/claude-code-acp`(0.16.2);`@agentclientprotocol/claude-code-acp` **不存在**(404)。
  三者(`opencode` 原生 / `codex-acp` 2.2.2 / `claude-agent-acp`)都报 `loadSession: true`。
- **ACP 没有 system prompt 字段**:`NewSessionRequest` 只有 `{cwd, additionalDirectories, mcpServers, _meta}`,
  `systemPrompt` 出现在 **0 个** `$defs` → 只能走 `_meta`。**能力位在 `initialize` 响应上,不在 `session/new` 响应上。**
- **`_meta` 投递(已实现 `526a462`/`73c10c4`)**:`META_CAPABLE_COMMANDS={"claude-agent-acp"}` 按 `basename`
  (去 `.cmd/.exe/.bat`、小写)查表。`"meta"` 模式发 `_meta.systemPrompt`(字符串**替换** preset;对象与
  `{preset:"claude_code"}` 合并,故 `{append}` 可用);`"prompt"` 模式(默认)把角色前缀进 prompt 文本。
  **两种模式互斥** —— 都发等于把指令说两遍。`commandKey` **miss 会静默降级**(别名/包装脚本如 `claude-acp`、`npx`
  认不出 → 落 prompt 模式,不崩但悄悄丢掉系统级提示词与工具限制)。
- **`_meta.claudeCode.options.tools` ≠ `--allowedTools`**(用已装 `claude --help` 核实):前者是
  *"list of **available** tools; `""` disables all"*(**可用性**),后者是 *"tool names to **allow**"*(**预授权**)。
  把 `task.tools` 映射过去是**行为变更(略更严)**,不是「保持原样」。`tools: []` 必须 **fail-closed** 照发
  (`AgentRunner.ts:50` 默认 `["Read","Write","Bash"]`,空数组只可能来自显式配置 —— 别加「防御性」长度守卫)。
- 🔴 **未接 `session/request_permission` ⇒ ACP 下 agent 用不了任何需要授权的工具**(迁移硬阻塞)。
  机制:bridge 向 client 要权限(`acp-agent.js:950`)→ SDK 对无 handler 的 request 回
  `-32601 Method not found`(`jsonrpc.js:774-775`)→ bridge 重抛 → 工具被拒。
  单变量实证:`tools: []` → agent 回 `NO_TOOLS`;默认 tools → 回 **`PERMISSION_DENIED`**。
  协议形状:响应 `{outcome:{outcome:"selected",optionId}}` 或 `{outcome:{outcome:"cancelled"}}`;
  option `kind ∈ allow_once|allow_always|reject_once|reject_always`;`ToolCallUpdate.name` **可空**,
  `kind` 是归一化枚举(`read|edit|delete|move|search|execute|think|fetch|switch_mode|other`)。

## 工作区语义
- `run`(批处理)→ 每次一个 `workDir/.multiclaw/runs/run-<stamp>/`,agent cwd 在其中(`commands/run.ts`)。
- 控制台(迭代)→ **每轮共用 `config.workDir`**,只日志按轮隔离(`<workDir>/.multiclaw/runs/run-<stamp>/logs/`)。
  `App.startTurn` **不要**再覆盖 `runConfig.workDir`。
- 后果:跨轮存活文件带来陈旧状态。`task-plan.json` 即实例 → `Orchestrator.run()` 开头必须
  `clearStaleTaskPlan()`(`fs.rmSync(..., {force:true})`)。测试里 task-plan.json 要在 **architect 运行期间**写
  (handler 内),否则会被清掉,测的不是真实路径。

## TUI(`packages/dashboard`)
- 包名 `@multiclawcli/dashboard`,Ink TUI,exports 只有 `"./tui"`;`startTui` 用 alternate screen,非 TTY 抛错
  (无 TTY 由 ConsoleReporter 兜底)。
- **状态两层**:`TurnView`(turn/requirement/phase/stages/agents/leaderIds/focusId/autoFollow/scroll/success/
  totalDuration/warning/reply)与 `TuiState extends TurnView { name; history: TurnView[]; view?: TurnView }`。
  - 所有面板组件只吃 `TurnView`,prop 叫 `turn` 不叫 `state`;只读辅助(`progress`/`turnElapsed`/`visibleLog`/
    `stageStatus`)参数也是 `TurnView`。
  - `history` 只存被新一轮顶替的轮次(`turn:start` 里 push,`turn===0` 不记);当前轮不进 history;上限 20。
  - `snapshot()` **逐字段写出**,不要 `...state`(会把 history 拷进自己 → 平方级内存)。
  - `view` 是 detached copy:`mapShown(state,fn)` 有 view 时改 view 否则改 live。两条不变量:回看不动 live 焦点/滚动;
    回看不改写 history。`fn` 返回同一对象 = 无变化 → 原样返回(reducer 的 `toBe` 恒等契约)。渲染统一 `state.view ?? state`。
- `LayoutInput.helpOpen` 已改名 `overlay`(help/history 共用);`viewing?: boolean` 多留一行横幅。
- 一轮以文字结束(reply/ask)时 `ReplyPanel` 接管 body,状态行写 `✓ answered`/`? needs your input`,**绝不写 done**;
  提示栏不提 `tab`(面板不读 focusId),写 `enter sends · / commands · ? help`。`esc` 优先退出回看。
- **keymap 地基:提示符永远持有焦点 → 裸键让位于打字**。只有两个裸键且都以「输入行为空」为门槛:`?` 帮助、`/` 命令面板。
  新增裸键前先问「用户正在打字时按到会怎样」。
- **提示符无 disabled 态**,运行中也能打字;`handleKey` 里不允许 `if (running) return` 早退(会丢运行中的输入)。
  `?` 门槛是 `line.text==="" && !running`。
- **运行中提交 = 入队**(`submit()` running 时 push queue,effect 在 `running===false && queue.length>0` 时取队首)。
  `QueueStrip` 显示队列(>3 行时末行 `(+N more)`);`layout.ts` 的 `queueRows` 必须计入 `reserved`。
  **取消(ctrl+c / /cancel)连队列一起清**。glyph 用 `»`(宽一格;`⏳` 宽度不定会破网格)。
- `menuOpen` 不受 running 限制(那是 `/cancel` 唯一入口)。模态浮层(help/history)在 `handleKey` 里**先于**普通键处理并吞掉
  自己不用的键。`ctrl+c` **逐层剥离**(帮助→历史→取消→清输入→退出);`ctrl+d` 空行退出;`tab`/`shift+tab` 切焦点,
  焦点自动跟随下一个启动的 agent,手动切换后停止跟随。
- 状态永远**字形+颜色双编码**;只用 16 个具名 ANSI 色。日志滚动存「距尾部偏移」,滚到尾部自动恢复 follow。
- 新组件/新行入布局前必须同步 `layout.ts` 的 `reserved` 并给 chrome 加 `flexShrink={0}`。
- **Ink 的 `Box` 默认 `flexDirection="row"`**:单子元素包装盒要显式 column,否则子元素按内容收缩 → `space-between` 静默塌陷。
- 多行正文放进**单个 `<Text>`** 让 Ink 折行(拆成逐行数组会引入 `noArrayIndexKey` 且折行更差)。
- **Ink `<Text>` 样式向下合并且无法 un-inherit**:要让某段跳出父级 dim/bold 必须做成**兄弟节点**。
- Ink 会 trim 行尾未着色空白;自绘光标每个闪烁相位占的列数必须相同(空行时画在占位符首字符上)。
- 测试:渲染集成测试**不能轮询 stdout**(非交互模式只在 unmount 写一次帧)→ 用 `onTurnStart` 拿 eventBus,
  在 `orchestration:complete` resolve Promise 再等 ~120ms。「先跑完一轮再敲命令」用 `driveFrame({ready, thenKeys})`。
  按键**分块写入**(多字符 chunk 被当粘贴,`\r` 必须单独 write)。`FORCE_COLOR=1` 才断言光标;fake stdout 的 write 必须回调。
- **同一屏两个 agent 列表时聚焦语义必须一致**(WelcomePanel 曾是旁路手写列表不读 focusId → 「tab 坏了」误判)。
  **提示栏只列此刻真有效的键**。**夹具比真实用法宽容 = 藏 bug**:默认值应取自真实路径(PRESET 用内置工厂搭);
  临时夹具的 agent **必须带 `taskPrompt`**(必填,漏了会抛 `matchAll` of undefined 伪装成产品 bug;vitest 不做类型检查);
  测 reply 分支要给 leader 设 `taskPrompt:"{{requirement}}"`。

## 已评审缺陷(针对 `61c6a02`)—— **已全部修复**(2026-10-11)
B1/B2/B3 + M1–M11 + 全部 minor 已修掉并提交,`pnpm verify` 绿(覆盖率门槛均过)。
评审文档本身已清理:`CODE_REVIEW.md` 走 `git rm`(可从 git 历史取回);`QUALITY_REVIEW*.md`、`RUNTIME_RESEARCH.zh-CN.md`
归档后删除;`.workbuddy-ai/reviews/`(12 份)于 2026-10-11 归档到 `/tmp/multiclaw-archive/2026-10-11-cleanup/` 后删除。
- 行为变更:`focus:cycle` 单 agent 现在是真 no-op(不再重置 scroll);新增事件 `orchestration:stages`。
- **评审方法论(可复用)**:缺陷集中在**取消 / 小终端 / 非 ESM / 发布**四类边缘场景。既有测试断言「东西在不在」而非
  「对不对」,而 header/prompt/hint 渲染在 body **之后**正好盖住溢出 → 截断类 bug 结构性测不出来。评审优先跑真实但边缘的场景。

## 环境坑(pnpm)
- 根目录**无** `.npmrc`/`.pnpmrc`,nodeLinker = 默认 isolated。新增依赖后 `.bin` 软链可能缺失报
  `vitest: command not found` —— **再跑一次 `pnpm install` 自愈**,不要手工补软链。
- 增量 install 可能把新平台二进制错写进 `node_modules/.modules.yaml` 的 `skipped`(→ `Cannot find native binding`);
  `pnpm install --force` 修好;干净安装不复现(CI 不受影响)。排查:`grep -n skipped node_modules/.modules.yaml`。
- `pnpm -r <script>` 会先 verify 并自动补齐依赖,若 node_modules 与 lockfile 不一致会隐式 install,
  与正在启动的 vitest 撞出**假失败**(no tests / 1 error);单独重跑该包即绿。

## 待办 / 路线图
- **ACP 迁移(当前主线)**:
  1. 🔴 **接 `session/request_permission`**(见上节)。策略已定:与 `--allowedTools` 对齐 —— `task.tools` 内的工具批准、
     其余拒绝(fail-closed);识别顺序 `toolCall.name` → `kind` 映射 → 拒绝;拒绝要发带 `toolCallId` 的 `raw` 事件,
     否则「agent 说自己没有工具」这类问题在 TUI 上根本看不出来。`CAPABILITIES.permissions` 改 `true`,并**重写**那段
     「为什么不声明 permissions」的注释(理由已不成立)。
  2. 退役 `ClaudeRuntime` 前:①改 `AgentRunner.ts:20,47` + `Orchestrator.ts:57` 的 `?? "claude"` 默认值
     (12 个内置 agent 都没设 `runtime`,今天全走 ClaudeRuntime,先删会打断所有配置);
     ②把 `usage_update`(SessionUpdate 第 13 个变体)映射成 `usage` 事件,否则丢掉已声明的 `usage/cost`;
     ③删 `ClaudeRuntime.ts` + 三个测试套件(~34 tests)。
  3. **codex 是否一起迁是开放问题**:`codex-acp` 完全不读 `_meta`,所以 codex agent 会**同时丢掉角色提示词和工具限制**。
     这是「先只迁 claude」的最强论据。
  4. 残留:`availableRuntimes()`(`cli/src/lib.ts`)仍不带 command 调 `describe()`,被 `init.ts` 的 `checkRuntime()` 使用 →
     只装 `codex-acp` 的用户跑 `multiclaw init` 会看到「No AI runtime detected」。
- cli 的 `commands/init.ts`、`run.ts`、`tui.ts` 与 dashboard 的 `tui/App.tsx`、`index.ts` 仍无单测。
- `graft/` 是**本机缓存且 git-ignore**(`graft build` 重生成,$0 无 key);改源码结构后跑 `graft build` 清失效节点。
- TUI 路线图:①空计划静默成功+运行中丢按键 ✅ ②Q2 意图路由(leader 三态)✅ ③Q4 持久工作区+历史 ✅
  ④Q5 并发:先不做(将来「前台+后台任务」,后台用 git worktree 避免撞文件)。
  ⑤ **`ask` 的回答没有上下文**(下一轮最该做):leader 问「用哪个数据库」用户答「Postgres」→ 下轮 requirement 就是
  孤零零的 `Postgres`。修法:把最近几轮(需求+回答)拼成 context 变量喂 leader prompt,属新设计决策(塞多少、token 预算),需用户拍板。
