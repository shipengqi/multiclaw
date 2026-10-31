# multiclaw 项目约定

## 产品定位
- 用户明确（2026-10-30）：不需要看板；最重要的是多 agent 编排，改进聚焦用户体验与 agent 交互。保持 CLI/TUI 产品定位，不把审查扩成看板或项目管理平台。

## 构建 / 校验
- pnpm workspace:core / cli / dashboard + examples/dev-team。
- CI 顺序固定 **install → lint → build → typecheck → test**。cli、dashboard 的 typecheck 从
  `packages/*/dist/*.d.ts` 解析跨包类型,clean checkout 不先 build 会 TS2307 —— 不要改顺序。
- 根目录命令:`pnpm verify`(lint+build+typecheck+test,提交前跑)、`pnpm lint`(biome check .)、
  `pnpm lint:fix`、`pnpm format`、`pnpm typecheck`(=`-r typecheck`)、`pnpm test`、`pnpm test:coverage`(CI 用)。
- **`--filter` 用 package name,不是目录名**:core=`@multiclawcli/core`、dashboard=`@multiclawcli/dashboard`,
  但 **cli 的 name 是 `multiclaw`**(`pnpm --filter @multiclawcli/cli ...` 静默匹配不到任何包,exit 0 且什么都不跑,
  2026-10-20 因此白跑了好几轮 CLI 测试)。单跑 CLI 测试:`pnpm --filter multiclaw exec vitest run <file>`。
- **`pnpm verify` 跑普通 `test`,不查 coverage 门槛**:新增未测的 core 文件会把函数覆盖率压低,
  让 CI 的 `test:coverage` 红(core 需 90/85/90/90)。**新文件要么配测试,要么本地单独跑 `test:coverage` 兜底**
  (2026-10-12 踩坑:`providers/detect.ts` 上线时一度 0% funcs,已补 `detect.test.ts`)。
- 发布:手动两步,无 changesets。① `bump-version.yml` → 推 `release/v<version>` → 开 release PR。
  ② `release.yml`(merged && head.ref 以 `release/v` 开头)→ build → publish → 推 tag → `gh release create`。
  - trusted publisher 匹配 **workflow 文件名 `release.yml`** → 发布步骤不能改名/拆分;job 需 `id-token: write`。
  - 文档:`RELEASING.md` / `RELEASING.zh-CN.md`;改流程要同步这两份 + `CONTRIBUTING.md` + README 入口。

## 工具链版本(互相约束)
- 2026-10-31 实测装的是:vitest **5.0.4**、biome **2.6.2**、typescript **7.0.2**、ink **8.0.0**、
  react **19.3.1**、`@agentclientprotocol/sdk` **2.0.2**。(下面几行写于 vitest 4 时代,版本号会继续漂,
  以 `node -e "require('./packages/dashboard/node_modules/vitest/package.json').version"` 为准。)
- dashboard 无 Vite:web 客户端已移除,构建走根 `tsup` → `dist/tui.js` + `dist/tui.d.ts`。
  但 vite 仍以传递依赖存在:vitest → vite(`engines.node ^20.19||>=22.12`)→ 这就是
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
  run/tui/init 都调它 —— **不要再各写一份**。它用 `resolveCommand(agent, config)` 把 `provider`/`defaults`
  解析成真实命令再 `describe({ command })`;只读 `agent.command` 会让 `provider:"claude"`(无 `command`)退回
  opencode 默认、误报不可用(dev-team 示例即此形态,2026-10-12 修 + 回归测试)。

## ACP 接入
- SDK:`@agentclientprotocol/sdk`(**2026-10-31 dependabot 升到 2.0.2**;peer `zod@4.6.7`)。**必须懒加载**,否则拖垮 CLI 启动。
- **SDK 2.0 改了 dist 布局**:根导出指向 `dist/v1/stable/acp.js`(仍是 `PROTOCOL_VERSION = 1`,
  `client`/`ndJsonStream`/`methods` 都没变,我们的代码零改动通过)。直接 import
  `.../sdk/dist/acp.js` 会 `ERR_MODULE_NOT_FOUND`——裸 client 脚本要写 `dist/v1/stable/acp.js`。
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

## 中途纠偏(steering)
- **协议不在 ACP 标准里**,是从 `codex-acp@2.2.2` / `claude-agent-acp@0.93.0` 的 dist 源码核实的:
  扩展请求 `_session/steering`,params `{ sessionId, prompt: ContentBlock[], _meta?: { steering: { idleBehavior } } }`,
  由 `initialize` 的 `_meta.steering.supported === true` 广告(必须显式 true,别猜)。改 bridge 版本要重核。
- `outcome`:`injected` / `promptRequired`(Claude 空闲时的 opt-in)/ `startedNewTurn` / `failed`
  (Codex 另有 `noRunningTurn`)。**发 steer 时一律带 `idleBehavior:"promptRequired"`**。
- **最危险的一条:两个 bridge 在空闲会话上收到 steer 都会自己开一个新 turn**。那样起的 turn 没有
  `prompt()` owner,没人 settle/归因/取消。所以:① 只给 `state === "running"` 的会话发;
  ② 万一回了 `startedNewTurn`,立刻发 `session/cancel` 清场。
- **2026-10-31 真机实测（严格区分版本与路径）**:
  - Claude 0.89.1 / 0.95.0、Codex 2.2.2 / 2.5.0 广告 steering；OpenCode 1.19.0 不广告。
  - 裸 ACP 空闲请求仅测 Claude 0.93.0 与 Codex 2.2.2：带 idleBehavior 时前者回
    `{outcome:"promptRequired",reason:"noRunningTurn"}`，后者回 `startedNewTurn` 并真的开跑。
  - Codex 2.2.2 的清场：`session/cancel` 必须以通知发出（request 会 -32601），流随后停止。
    **没有在 Claude 0.95.0 / Codex 2.5.0 重跑裸空闲请求与取消路径**。
  - 计数 probe：Claude 0.89.1 / 0.95.0 数到 4 / 36、Codex 2.5.0 数到 6 后改回 BANANA；
    Codex 2.2.2 数满 200 才回。是特定任务与版本的观测，不是普遍保证；提示只能说“送达”。
  - 最新 probe 使用本地 core dist + npx 安装的 multiclaw 0.6.1 bridge，不是发布 CLI 实任务端到端验证。
- `RuntimeSession.capabilities.supplement` **是协商结果**,不是常量:initialize 晚于会话对象创建,
  所以用 getter 暴露。`AgentSessionManager.supplement()` 返回 `SupplementReport[]`
  (`injected|idle|unsupported|error`,每 agent 独立,一个失败不影响其他);没有 running 会话 → `[]`。
- TUI 语义“永不丢”:有 agent 收到 → `stream:note` 写 `[steer] …` 到 **live turn**(即使正在回看旧轮次)
  + 提示点名;一个都没收到(没人在轮次中 / bridge 不支持)→ **转成排队后续**并说明时机变了;
  空闲时 `/steer` 直接拒绝(`availability: "running"`)。

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
- **重启恢复只记边界,不续接**:`console/session.json`(`session.ts`,版本 1)记 inFlight 轮次/queue/
  taskStart/pending 计数;`restoreConsole` 把 inFlight 还原成 `phase:"complete" + interrupted:true` 的
  普通历史记录(未回音 agent → `cancelled`,stage outcome 丢弃重新推导),队列恢复但**暂停**。
  不变量:①挂载时**不写**日志(清 inFlight 会与把 interrupted 轮次写进 history.json 竞争,窗口内崩溃两边都没);
  ②去重靠 `inFlight.turn > last.turn`,不靠删字段;③主动退出写干净日志,只有进程被杀才出现 interrupted;
  ④interrupted 进 conversation(cancelled 不进),否则重启后"继续"没上下文;⑤不代答、不 resume 本进程没有的 session。
  写盘统一走 `atomic.ts` 的 `writeJsonFile`(按路径串行 + tmp+rename),`cleanup()` 要 `await pendingWrite`。

## 环境坑(pnpm)
- 根目录**无** `.npmrc`/`.pnpmrc`,nodeLinker = 默认 isolated。新增依赖后 `.bin` 软链可能缺失报
  `vitest: command not found` —— **再跑一次 `pnpm install` 自愈**。
- 增量 install 可能把新平台二进制错写进 `node_modules/.modules.yaml` 的 `skipped`;
  `pnpm install --force` 修好;排查:`grep -n skipped node_modules/.modules.yaml`。
- **本机 PATH 上有两个桥**(`~/.workbuddy-ai/binaries/node/versions/22.22.2-6/bin/`):
  `claude-agent-acp` **0.89.1**、`codex-acp` **2.2.2**。`resolveExecutable` 优先 PATH,所以
  **真机验证跑的是 PATH 那份,不是 bundled 的**——2026-10-31 差点把 0.89.1 的结果写成 0.93.0。
  验证前先 `which -a claude-agent-acp codex-acp`。
- bundled `claude-agent-acp@0.95.0` 的原生二进制(`@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.309`,
  **122 MB**)在本机下载超时 → 装不出,`session/new` 报 `Claude native binary not found for darwin-arm64`。
  `pnpm install --force` 和重装无效（网络超时）；随后 npx 安装的 0.6.1 副本可成功建会话。
  doctor 的检测与版本输出本身不能证明会话能运行。

## `multiclaw upgrade`(cli)
- **不变量:升级必须打到"当前正在运行的那一份"所在的 prefix**。原实现硬编码 `npm install -g`,
  在 pnpm 全局安装的机器上会装到 npm 的 prefix,`--version` 永远不变(2026-10-21 用户报障,已修)。
- `findPackageRoot()` 从 `import.meta.url` 向上找 `package.json.name === "multiclaw"`;
  `detectInstaller(pkgRoot)` 靠路径签名判安装器(pnpm/bun/yarn 的签名要在通用 `/node_modules/` 之前匹配)。
- 只给 **npm / pnpm** 实现 `view` + `add -g` 命令对;bun/yarn/unknown **明确报错 + 给手动命令,不猜**。
  registry 查询走安装器自己的 `view`,以尊重 `.npmrc` 镜像(别改成硬编码 fetch)。
- 装完必须 `readInstalledVersion(pkgRoot)` 复查(readFileSync,不走 require 缓存),不符则退出 1。
- `runUpgrade(ctx)` 接受注入的 `exec`/`readVersion` → 测试零 mock。

## `multiclaw doctor`(cli)
- **version 列存的是解析后的数字,不是 `--version` 的整行**。`providers/detect.ts: parseVersion()`
  在存值时裁出 `\d+\.\d+\.\d+`;但 `versionFor()` 必须返回**原始行**,因为 `spec.confirm`
  (cursor 的 `agent`)靠词确认身份——两处一起裁会让 cursor 变 missing。
- 表格的 `cell()` **补白就是列分隔符**,超宽值会与下一列粘连(0.6.0 的 `2.5.0bundled`)。
  超宽时裁到 `width-1` + `…`,保证至少一个空格。
- 渲染实测(本机):`OpenCode 1.19.0 path / Claude 0.89.1 path / Codex 2.2.2 path`。

## 待真机验证(mock 覆盖不了,需真实 API 密钥 / 真实二进制)
- [x] `session/request_permission`(2026-10-31 已验):默认 tools 下 Read 成功读到 `secret.txt`,
  零 `permission_rejected`。**同时推翻了两条旧预期**:默认 allowlist 含 `Bash`,所以 `rm` 不经
  审批直接删文件、`grep` 类任务直接走 Bash——`tools` 是**审批白名单,不是能力上限**。
  `docs/provider-verification.md` §3.2/§3.3 已按实测改写。
- [x] codex-acp AIR `customInstructions` 遵从度(2026-10-31):角色提示词要求"每句以 CODEX-OK 开头",
  codex 与 claude 都照做。AIR 命名空间这条路可用。
- [x] `session/load` 跨会话续接(2026-10-31):关掉会话后用同一 sessionId + `resume:"continue"`
  重开,仍记得上一轮的 7319。
- [ ] `multiclaw init`:在无 claude CLI 但装了 `claude-agent-acp` 的环境里的表现。
- [x] steering(claude/codex 两个真 bridge,2026-10-31 已验):`injected` 真被接受且真的影响输出、
  `promptRequired` 在 claude 空闲时真挡住自起 turn、codex 的 `startedNewTurn` 真能 cancel 掉、
  steer 之后会话仍可继续 prompt。opencode 不广告该扩展(已验,走 unsupported 分支)。

## 开放问题
- **codex 的工具限制**(命名空间分派已实现,此项待拍板):角色提示词已走 AIR 命名空间,但 codex
  **无工具限制落点**,当前是 `tools: false` + 丢弃 allowlist(**不报错**)。
  要改成「显式配置 `tools` 时硬报错」必须先给 `AgentTask` 加字段区分显式配置与默认值 ——
  `AgentRunner.ts:50` 恒给 `tools` 兜底 `["Read","Write","Bash"]`,运行时**分不出来**,
  直接报错会把 opencode/codex 全打死。
- **跑过流水线的轮次不记结果**:`TurnRecord` 只有 requirement + leader 的话,没有 success/失败摘要。
  「上一轮到底跑成了没」leader 得自己去 workspace 看。若发现它常判断错,再给 `TurnRecord` 加一行摘要。
