# multiclaw 项目约定

## 产品定位
- 不做看板/项目管理平台；核心是多 agent 编排，改进聚焦 TUI 的 agent 交互（2026-10-30 用户明确）。

## 构建 / 校验
- pnpm workspace：core / cli / dashboard + examples/dev-team。
- CI 顺序固定 install → lint → build → typecheck → test（cli/dashboard 从 `packages/*/dist/*.d.ts` 取跨包类型，不先 build 会 TS2307）。
- 根命令：`pnpm verify`（lint+build+typecheck+test）、`lint`、`lint:fix`、`format`、`typecheck`、`test`、`test:coverage`。
- `--filter` 用 package name：core=`@multiclawcli/core`、dashboard=`@multiclawcli/dashboard`，**cli 的 name 是 `multiclaw`**（`--filter @multiclawcli/cli` 静默 exit 0 什么都不跑）。
- `verify` 不查覆盖率门槛；新增未测 core 文件会压低覆盖率让 CI 红（core 90/85/90/90）→ 配测试或本地跑 `test:coverage`。
- 发布手动两步：`bump-version.yml` 推 `release/v<version>` 开 PR → `release.yml`（merged && head.ref 以 release/v 开头）build/publish/tag/`gh release create`。trusted publisher 认 **workflow 文件名 `release.yml`**（不能改名/拆分，job 需 `id-token: write`）；改流程同步 RELEASING*.md + CONTRIBUTING + README。

## 工具链（互相约束）
- 2026-10-31 实测：vitest 5.0.4、biome 2.6.2、typescript 7.0.2、ink 8.0.0、react 19.3.1、`@agentclientprotocol/sdk` 2.0.2。会漂，以实际 node_modules 为准。
- dashboard 无 Vite（web 客户端已移除，tsup → dist/tui.js）；node 下界 22.12 来自 vitest→vite 的 engines，ink 8 要 node>=22。
- `@vitest/coverage-v8` peer 锁死 vitest 精确版本 → 三包 vitest 与根 coverage-v8 同版本。`strictPeerDependencies: true`。改 `devEngines` 必须 `pnpm install --lockfile-only`。

## Lint / Format
- Biome（lint+format+import 排序），根 `biome.json`；pre-commit = husky + lint-staged。`noUnusedImports`/`useExhaustiveDependencies` 的修复是 unsafe，`--write` 不自动应用。
- `biome-ignore` 必须紧贴被标记行且理由写一行（换行会报 suppressions/unused 且原规则照旧报错）。

## 测试
- vitest，测试与源码同目录；时间用 `vi.useFakeTimers()`。换运行时向 `runtimeRegistry` 注册唯一 name 的 fake，别覆盖 `acp`。
- 覆盖率门槛是防倒退基线：core 90/85/90/90、cli 50/45/40/50、dashboard 90/85/90/90。
- `MultiClawEvent` 含 `orchestration:warning`/`orchestration:stages`，消费方 switch 要有 default。**新结果字段优先挂 `OrchestratorResult`，不新增事件**。
- **断言不变量不断言结果**；写完回归测试先临时回退修复确认它变红。
- 全量并发跑时末尾 `fs.rmSync(tmpdir)` 偶发 `ENOTEMPTY`（safe-delete shim 与仍在写的进程竞争），单跑该文件是绿的 → 重跑即可。

## Agent 定义（core）
- `description` 静态角色（12 preset 各一句 ≤24 字符小写动词短语，`agents/index.test.ts` it.each 卡住）vs `taskTitle`（per-turn，由 leader 的 task-plan.json 就地覆写）；首屏 `taskTitle ?? description`。
- leader 三态路由器 run/reply/ask。`run` 的 id 永远是配置子集，未知 id 丢弃，命中零个 → `finishEmpty`（失败）。reply/ask 轮：`success:true`、`agentResults:[]`、有 `reply`，**不发 `orchestration:start`**。
- preset 默认 `tools` 是**审批白名单，不是能力上限**：默认含 Bash → `rm` 不经审批直接删文件；不含任何 `mcp__*` → MCP 工具一律被拒。`toolPermitted` 是 name 优先的**大小写不敏感通配**（`matchesTool`：`*` = 任意串，`mcp__graft__*` 覆盖整个 server；其余字符按字面量，无字符类），name 缺失才退回 kind（`KIND_TO_TOOLS`: read/edit/execute/search/fetch）。code-reviewer=`["Read","Write"]`、leader=`["Read","Bash"]`。
- **权限模式语义（2026-10-31 用户拍板，反转旧规则）**：`auto`（默认）= 白名单内放行、外拒绝；`ask` = 白名单内**直接放行不问**、外**交给 `onPermission` 问人**（无 handler 时 fail-closed 选 `reject_once`）；`deny` = 全拒。旧规则「ask 也会为白名单内工具弹窗、且人工同意不能超出白名单」已废弃；README 中英 + `docs/provider-verification.md` §3 已同步。

## Runtime（core）
- `AgentRuntime` 是已发布导出 → 加宽是破坏性变更。`describe(): Promise<RuntimeInfo>`；`capabilities` 只描述适配器真实现了什么。
- `AgentTask.onEvent?`；`RuntimeEvent` 带 runId/agentId/seq 信封。
- 唯一 runtime 是 `acp`（ClaudeRuntime 2026-10-11 退役）；`AgentDefinition.models` 的键是 **runtime 名**（`models: { acp: ... }`）。
- CLI 可用性门禁只有一处：`cli/src/lib.ts` 的 `assertRuntimesAvailable`/`availableRuntimes`（run/tui/init 都调）。用 `resolveCommand(agent, config)` 解析真实命令再 `describe({command})`；只读 `agent.command` 会把 `provider:"claude"` 误判成 opencode 默认。

## ACP 接入
- SDK 2.0.2（peer zod 4.6.7）**必须懒加载**。SDK 2.0 根导出指向 `dist/v1/stable/acp.js`（PROTOCOL_VERSION 仍 1）；裸脚本 import `dist/acp.js` 会 ERR_MODULE_NOT_FOUND。
- 两个桥是 multiclaw 自己的依赖（core+cli 都列）：`claude-agent-acp`、`codex-acp`；`resolveExecutable()` 先 PATH 后 bundled `node_modules`。opencode 是原生 ACP（用户自装，无桥）。
- `BRIDGES` 按 basename 分派 `_meta` 与 `tools` 能力位；未登记 bridge 无 `meta` → 角色提示词降级为 prompt 前缀。**投递互斥**：只有 `meta === undefined` 才前缀。
- `_meta`：claude = `_meta.systemPrompt` + `_meta.claudeCode.options.tools`（`tools: true`；可用性 ≠ `--allowedTools` 预授权）；codex = `_meta.jetbrains.air.customInstructions` → `developerInstructions`（无条件读取，非 string 静默忽略；**无工具限制落点** → `tools: false`，allowlist 丢弃）。刻意不声明 AIR 客户端能力（会把输出切成 diffPatch/subagent/asyncTasks，都没映射）。
- `describe().capabilities.tools` 随 command 变化；`permissions` 恒 true。
- `session/request_permission`：name 优先 → kind 启发式 → 拒绝（fail-closed），`delete`/`move`/`think`/`switch_mode`/`other` 一律拒。**流里 `✗ User refused permission to run tool` 是桥 `deny()` 的默认文案，不是真有人点拒绝**；我们发 `permission_rejected` raw（人工拒绝时带 `source: "user"`）+ 一句点名工具的警告。
- 工具参数**迟到但已不再丢**：桥先发 `tool_call`（input 空 `{}`），随后 `tool_call_update` 补 `rawInput`。`AcpRuntime` 现在在 update 首次带非空 `rawInput` 时**补发一次同 id 的 `tool_call`**（`argsSurfaced` 去重）；`AgentRunner` 按 id 只打一行，空参数时**延后**到参数到达（或结果）再打，所以不会再出现 `› Read {}`。`summarizeToolInput({})` 返回 `""`（`hasToolArgs`）。
- `usage_update` → `usage` + `cost` 事件（contextTokens/contextSize/amount/currency）。

## 中途纠偏 steering
- 协议不在 ACP 标准里，来自 codex-acp@2.2.2 / claude-agent-acp@0.93.0 dist：`_session/steering`，params `{sessionId, prompt, _meta:{steering:{idleBehavior}}}`，由 `initialize._meta.steering.supported === true` 广告。改桥版本要重核。
- `outcome`：`injected`/`promptRequired`/`startedNewTurn`/`failed`（codex 另有 `noRunningTurn`）。**一律带 `idleBehavior:"promptRequired"`**。
- **最危险**：两个桥在空闲会话收到 steer 都会自起新 turn（没有 `prompt()` owner 来 settle/归因/取消）→ ① 只给 `state==="running"` 的会话发；② 回了 `startedNewTurn` 立刻 `session/cancel` 清场。
- 2026-10-31 实测：Claude 0.89.1/0.95.0、Codex 2.2.2/2.5.0 广告；OpenCode 1.19.0 不广告。裸空闲仅测 Claude 0.93.0（promptRequired）与 Codex 2.2.2（startedNewTurn 并真开跑，cancel 必须以**通知**发，request 会 -32601）；**未在 0.95.0/2.5.0 重跑裸空闲与取消**。计数 probe 是特定任务+版本的观测；提示只能说"送达"。
- `RuntimeSession.capabilities.supplement` 是协商结果（initialize 晚于会话对象创建 → getter）。`AgentSessionManager.supplement()` 返回 `SupplementReport[]`（injected|idle|unsupported|error，每 agent 独立）；无 running 会话 → `[]`。
- TUI"永不丢"：有 agent 收到 → `stream:note` 写 `[steer] …` 到 live turn + 点名；都没收到 → 转成排队后续并说明时机变了；空闲时 `/steer` 直接拒（`availability:"running"`）。

## 工作区语义
- `run`（批处理）→ 每次 `workDir/.multiclaw/runs/run-<stamp>/`，agent cwd 在其中；控制台（迭代）→ 每轮共用 `config.workDir`，只日志按轮隔离，`App.startTurn` 不要覆盖 `runConfig.workDir`。
- `Orchestrator.run()` 开头必须 `clearStaleTaskPlan()`。
- core 无 session 概念 → 跨轮状态由调用方带：`MultiClawConfig.history?: TurnRecord[]` → `renderConversation()` → leader 的 `{{conversation}}`。预算最近 6 轮 / 4000 字符 / 单条 600，超预算丢最旧，编号绝对不重排。
- **占位符必须无条件设值**（`renderPrompt` 只替换存在的键，缺键会把 `{{x}}` 字面量塞进提示词）。

## TUI（packages/dashboard）
- Ink，exports 只有 `"./tui"`；`startTui` 用 alternate screen，非 TTY 抛错。
- 状态两层：`TurnView` 与 `TuiState extends TurnView { name; history; view? }`；面板只吃 `TurnView`，prop 叫 `turn`。`history` 只存被顶替的轮次（上限 20）；`snapshot()` 逐字段写出；`view` 是 detached copy。
- 文字结束（reply/ask）→ `ReplyPanel` 接管 body，状态行 `✓ answered`/`? needs your input`，绝不写 done。
- keymap：提示符持有焦点 → 裸键让位于打字；`?`/`/` 是裸键，**外加"请求挂起且输入行为空"时的审批菜单**（见下）。运行中提交=入队；取消（ctrl+c / /cancel）连队列一起清。
- **交互条**（2026-10-31）：`request_permission` 与 `elicitation/create` 不再替换 body，改为 dock 在 prompt 上方（`Rule` 分隔）。行数走 `computeLayout({interactionRows})`，被 `barRoom = rows - chrome - MIN_BODY_ROWS - 1` 夹住，否则短终端上 Ink 会从树底部裁掉 prompt；`< MIN_INTERACTION_ROWS(4)` 就整块不画、hint 退回命令式。权限=菜单：`↑↓`/`1-9` 移光标、`enter` 提交、`esc` 交还键盘（`released` 按 shortId 键控，新请求自动复位）；**无默认选中**，所以 enter 单按永不会批准。问题=逐字段表单，文本/数字字段复用 prompt 当编辑器（换字段时 `withDraft` 存、`focusField` 取）；`enter` 逐字段前进并在最后一格提交。纯逻辑全在 `tui/interaction.ts`（已进覆盖率 include）。
- 流里 tool 行：`\n› Name <summary>\n`（kind `tool`）+ `  ✓/✗ <首行>`（成功是 `tool-detail`，只有 /verbose 显示；失败必显示）。summary 走 `utils/toolSummary.ts`（首行 + 120 列截断，永不抛）。
- 测试：渲染集成测试不能轮询 stdout → 用 `onTurnStart` 拿 eventBus；按键分块写入。
- `conversationTurns(state)` 从 `history` + 当前轮派生，只收 `phase==="complete"`；`App.startTurn` 经 `stateRef` 读（deps 不含 state，直读会 stale）。**dashboard 测的是 `dist`**：改了 core 先 `pnpm build`。
- **输入行自己断行**：`Prompt` 不能把文本拆成 before/cell/tail 三个兄弟 `<Text>`（Ink 只对文本换行，光标是独立 flex item，会滞留首行右端 —— 2026-10-31 用户报的 bug）。现在 `promptLines(value, cursor, width)` 按**字符**断行（不是按词：输入行没有词边界），`caret` 存**行内下标**（宽字符 1 下标 2 列，按列切会切坏 CJK），续行用 `MARKER_WIDTH`(2) 空格缩进，`MAX_PROMPT_ROWS = 5` 超出滚动跟随光标，占位符 `truncate` 到可用宽度。行数经 `promptRowCount()` → `computeLayout({ promptRows })` 计入 `reserved`（理由同 `railCells`：Ink 布局前量不出换行高度，漏算会让 body 溢出被 Yoga 压缩）。
- 重启恢复只记边界不续接：`console/session.json`(v1) 记 inFlight/queue/taskStart/pending；`restoreConsole` 把 inFlight 还原成 `phase:"complete" + interrupted:true`。不变量：①挂载时不写日志；②去重靠 `inFlight.turn > last.turn`；③只有被杀才 interrupted（主动退出写干净日志）；④interrupted 进 conversation（cancelled 不进）；⑤不代答、不 resume 本进程没有的 session。写盘走 `atomic.ts: writeJsonFile`，`cleanup()` 要 await `pendingWrite`。

## 环境坑
- 根目录无 `.npmrc`，nodeLinker=isolated。新增依赖后 `.bin` 软链可能缺失（`vitest: command not found`）→ 再跑一次 `pnpm install` 自愈；新平台二进制错写进 `.modules.yaml` 的 skipped → `pnpm install --force`。
- PATH 上有两个桥（`~/.workbuddy-ai/binaries/node/versions/22.22.2-6/bin/`）：`claude-agent-acp` 0.89.1、`codex-acp` 2.2.2。`resolveExecutable` 优先 PATH → 真机验证跑的是 PATH 那份，验证前先 `which -a`。
- bundled `claude-agent-acp@0.95.0` 的原生二进制（darwin-arm64，122MB）本机下载超时 → `session/new` 报 `Claude native binary not found`；doctor 能报版本不代表会话能跑。
- 本机全局 multiclaw 是 npm 装的 **0.6.3**，仓库是 0.6.2 → 解释线上行为前先核对版本。
- **渲染集成测试不要用固定 sleep 等异步副作用**。非交互模式下 Ink 只在 unmount 时写帧（`stdout` 在此之前是空串，polling 输出行不通），所以只能：① `driveFrame` 的 `ready`/`thenReady` 等 app 自己给的 promise；② `vi.waitFor` 轮询外部事实（history 文件、session 已关）。曾经 `App.sessions` "reuses the leader handle after ask" 与 `App.session` "/quit does not claim successful cleanup" 并行全量稳定红，就是 `settleMs` 去撞落盘/落帧；2026-10-31 改成等事实后连跑全绿。

## `multiclaw upgrade` / `doctor`
- 升级必须打到"当前运行的那一份"所在 prefix（原实现硬编码 `npm install -g`，pnpm 全局装的机器上白升，2026-10-21 报障已修）。`findPackageRoot()` 从 `import.meta.url` 向上找 `name === "multiclaw"`；`detectInstaller()` 靠路径签名（pnpm/bun/yarn 签名要在通用 `/node_modules/` 之前匹配）。只给 npm/pnpm 实现 `view` + `add -g`，bun/yarn/unknown 报错给手动命令；registry 查询走安装器自己的 `view`（尊重 .npmrc 镜像）；装完 `readInstalledVersion()` 复查。`runUpgrade` 接受注入 `exec`/`readVersion` → 测试零 mock。
- doctor：version 列存解析后的数字（`parseVersion()`），但 `versionFor()` 必须返回原始行（`spec.confirm` 靠词确认身份，两处一起裁会让 cursor 变 missing）。已改为 provider 分组 + 标签行；告警复用 `hasExplicitTools`。本机实测：OpenCode 1.19.0 / Claude 0.89.1 / Codex 2.2.2，全 path。

## 待真机验证
- [x] `request_permission`：默认 tools 下 Read 读到 secret.txt，零 rejected。**推翻旧预期**：默认 allowlist 含 Bash → `rm` 不经审批直接删文件；`tools` 是审批白名单不是能力上限（`docs/provider-verification.md` §3.2/3.3 已改）。
- [x] codex AIR `customInstructions` 遵从度（"每句以 CODEX-OK 开头"，codex 与 claude 都照做）；`session/load` 跨会话续接（同 sessionId + `resume:"continue"` 仍记得 7319）。
- [x] steering 两个真 bridge：injected 真生效、promptRequired 真挡住自起 turn、startedNewTurn 真能 cancel、steer 后仍可 prompt。opencode 走 unsupported。
- [ ] `multiclaw init`：无 claude CLI 但装了 `claude-agent-acp` 的环境下的表现。

## 开放问题
- 已同意（2026-10-31）：先补跨轮事实摘要，再加显式工具限制的启动前检查；不加模型调用/弹窗/命令，不隐式批准/重试/切 provider/放宽权限。
- 工具来源：12 个工厂用 enumerable `Symbol.for("multiclaw.toolsProvenance")` 存原数组引用 + 冻结快照；显式 override/替换数组/改内容视为显式。不改 `AgentRuntime` 必选契约。
- 跨轮 `TurnRecord.outcome?`：execution 与 acceptance 分离，TUI 从历史事实派生；旧记录不足则 unknown。
