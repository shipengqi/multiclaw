# multiclaw 项目约定

## 构建 / 校验
- 包管理:pnpm workspace(3 个包:core / cli / dashboard + examples/dev-team)。
- CI 顺序固定为 **install → lint → build → typecheck → test**。
  - 原因:cli、dashboard 的 typecheck 从 `packages/*/dist/*.d.ts` 解析跨包类型(dashboard←core,cli←core+dashboard);clean checkout 下不先 build 会报 TS2307。不要调整这个顺序。
- 常用命令(根目录):
  - `pnpm verify` = lint + build + typecheck + test(本地提交前跑)
  - `pnpm lint` = `biome check .`;`pnpm lint:fix` = `biome check --write .`;`pnpm format` = `biome format --write .`
  - `pnpm typecheck` = `pnpm -r typecheck`
  - `pnpm test` = `pnpm -r test`(跑全部 3 个包)
  - `pnpm test:coverage` = `pnpm -r test:coverage`(跑测试并强制覆盖率门槛,CI 用这个)
- 发布:**手动两步,不用 changesets**(仓库里没有 `.changeset/`,也没有 CHANGELOG.md)。
  - ① `.github/workflows/bump-version.yml`(`workflow_dispatch` + `bump` choice patch/minor/major)→ 一起改写三个包的 `version` → 推 `release/v<version>` 分支 → 开 PR `chore: release vX.Y.Z`。
  - ② `.github/workflows/release.yml`(`pull_request: closed`,job `if` = merged && 同仓 && head.ref 以 `release/v` 开头)→ `pnpm -r build` → `pnpm -r --filter "./packages/*" publish --no-git-checks --access public` → 推 `v<version>` tag → `gh release create --generate-notes`。
  - 鉴权:npm trusted publishing(OIDC),仓库内**没有任何 secret**(`gh secret list` 为空)。trusted publisher 匹配 **workflow 文件名 `release.yml`** → 发布步骤不能改名或拆到别的文件;job 需 `id-token: write`。**pnpm 原生支持 OIDC**(不必用 `npm publish`)。
  - 两个 workflow 都**不推 `main`**(只推 `release/v*` 分支与 `v*` tag)→ 与 main 的规则集天然兼容,**不需要任何 bypass**。
  - 已知代价:用 `GITHUB_TOKEN` 开的发布 PR **不会触发任何 workflow**(所以没有 CI 检查);若以后加 required status checks,发布 PR 会无法合并。
  - 文档:`RELEASING.md`(英)/ `RELEASING.zh-CN.md`(中);改发布流程时同步更新这两份 + `CONTRIBUTING.md` 的 Release process 段 + README 里的入口。

## 工具链版本(互相约束,不能单独升)
- **dashboard 包已无 Vite**:web 客户端(React + vite + tailwind + postcss)全部移除,构建改为根 `tsup`,产物 `dist/tui.js` + `dist/tui.d.ts`。仓库 manifest 里已无 vite/plugin-react/rolldown 依赖。
  - **但 vite 仍以传递依赖存在**:vitest 4 依赖 vite 8,而 vite 8 的 `engines.node` 是 `^20.19.0 || >=22.12.0` → 这就是 `devEngines.runtime.version` 下界 22.12 的来源(不是 22.0)。另有 ink 8 要求 `engines.node >= 22`。
  - vitest 3 的 peer `vite` 是 `^5||^6||^7`,**不含 8**;vitest 4 才是 `^6||^7||^8`。`@vitest/coverage-v8` 的 peer 锁死 vitest **精确版本**(4.1.11),所以三包 vitest 与根 coverage-v8 必须同版本。
  - ink 8 的 peer:`react >= 19.3.0`、`@types/react >= 19.3.0`、`react-devtools-core >= 6.1.2`(可选)。dashboard 装的是 react 19.3.0。
- `pnpm-workspace.yaml` 设了 `strictPeerDependencies: true`:未满足 peer 时 `pnpm install` **直接失败**,而不是只警告、然后装上一个跑不起来的组合。
- **改 `devEngines` 必须重生成 lockfile**(`pnpm install --lockfile-only`):lockfile 把它记在 `importers["."]` 的 specifier 里,否则 CI 的 `--frozen-lockfile` 直接失败。

## Lint / Format
- Biome 2.5(单一工具管 lint + format + import 排序),配置在根 `biome.json`。
- 风格:2 空格缩进、lineWidth 100、double quotes、asNeeded 分号、trailingCommas es5。
- pre-commit 由 husky + lint-staged 驱动(`.husky/pre-commit` → `pnpm exec lint-staged`)。
- 已知豁免:CSS 关闭 `noUnknownAtRules`(当初为 Tailwind 3 加的;web 端已移除,仓库里已无 CSS 文件,规则保留无副作用);测试文件关闭 `noNonNullAssertion`。
- 注意:Biome 的 `noUnusedImports` / `useExhaustiveDependencies` 修复被标为 unsafe,`--write` 不会自动应用,需人工判断(曾误判 React import 为可删)。
- **`biome-ignore` 注释必须紧贴被标记的那一行,且理由写成一行**。理由换行会切断关联,报 `suppressions/unused`「Suppression comment has no effect」,同时原规则照旧报错 —— 看起来像「抑制没用」,其实是位置错了。JSX 里注释放在 `map` 回调内、被标记元素的正上方即可。

## 测试
- 框架 vitest;测试文件与源码同目录(co-located `src/**/*.test.ts`)。
- 时间相关用例用 `vi.useFakeTimers()`。
- 需要替换运行时:向 `runtimeRegistry` 注册一个唯一 name 的 fake runtime,不要覆盖内置 `claude`。
- 覆盖率门槛写在各包 `vitest.config.ts` 的 `coverage.thresholds`,是**防倒退的基线锁**,不是目标:
  - core 90/85/90/90(实测 98.85/94/97.56/99.33),exclude `src/types/**`、`src/agents/**`、`src/index.ts`、`src/testing/**`
  - cli 50/45/40/50(实测 60.75/63.21/59.09/60.11;commands/init.ts、run.ts、tui.ts 尚未覆盖),exclude `src/index.ts`、`src/lib.ts`
  - dashboard 90/85/90/90(实测 100/95.6/100/100)。**`coverage.include` 只列四个「带决策」的模块**:`src/tui/state.ts`、`format.ts`、`commands.ts`、`layout.ts`。App.tsx / index.ts / components/**.tsx 是终端 I/O 胶水,无单测价值,不纳入分母(它们由 `App.test.tsx` / `App.run.test.tsx` / `components.test.tsx` 做渲染层断言,但不计覆盖率)。改这个 include 会立刻改变覆盖率口径。
  - 注意:vitest 4 的 v8 provider **把从未被加载的文件的 branches/functions 也计入分母**,所以升级到 vitest 4 时这两项会大跌(已按新口径重新标定,不是覆盖率真的退了)。
- 事件类型:core 的 `MultiClawEvent` 新增了 `orchestration:warning`;消费方 switch 需有 default 兜底。
- **新结果字段优先挂在 `OrchestratorResult` 上,而不是新增事件类型**。仓库既有约定是「`orchestration:complete` 的 payload 类型就是 `OrchestratorResult`」,所以「这一轮如何结束」这类信息加到 result 里就自动随完成事件送达(`reply` 就是这么加的)。只有「发生在完成之前、需要单独送达」的东西才值得新事件。
- **断言「结果」往往证明不了「机制」,要断言不变量**。实例:验证「运行中输入会排队」时,只断言「两轮都跑完了」是**无效**的 —— 把输入改成并发起第二轮同样满足它。真正区分「排队」与「并发」的是不变量:`execute` 里记 `inFlight` 峰值,断言 `peak === 1`。
- 配套习惯:**写完回归测试先临时回退修复,确认它真的红**。本轮两处都做了(core 报 `expected true to be false`,TUI 报 `expected 1 to be 2`),否则无从知道测试是不是空转。

## Agent 定义(core)
- `AgentDefinition.description`(静态角色,「这个 agent 是干嘛的」)与 `AgentDefinition.taskTitle`(本轮被派的活)是**两个概念,别混用**。
  - `description`:由 agent 工厂/用户配置声明,恒定;12 个内置预设各有一句小写动词短语(≤24 字符,跟在名字后面读)。新增内置 agent 时**必须一起加**,`packages/core/src/agents/index.test.ts` 会用 `it.each` 遍历命名空间卡住这一点。
  - `taskTitle`:由 `Orchestrator` 从 leader 的 `task-plan.json` **就地覆写**(`agent.taskTitle = task.title`),所以它是 per-turn 的,开跑前必然为空。
  - 控制台首屏渲染 `taskTitle ?? description`;事件 `StageInfo.agents` 两者都带。
  - 缩写在该字段里保持大写(`builds the API`、`reviews the UI design`),所以测试只断言**首字母**小写,不要断言整句。
- **leader 是三态路由器,不是「选人器」**:`{"mode":"run","run":[...]}` / `{"mode":"reply","message":"…"}` / `{"mode":"ask","message":"…"}`(类型在 `packages/core/src/types/leader.ts`,解析在 `packages/core/src/utils/leaderDecision.ts`)。
  - 不带 `mode` 的 `{"run":[...]}` 仍按 run 处理(向后兼容)。`message` 为空串、`mode` 是别的值 → 该对象不算数,继续往后找。
  - **没有可解析 JSON 时,leader 的散文就是回答**(`reply`),不再「跑全部 agents」。这是「输入 hello 不烧掉整支团队」的全部实现。
  - leader **失败 / 输出全空白** → warning + 回退跑完整配置团队(leader 是基础设施,不是任务)。
  - `run` 命名的 id 永远是配置的**子集**:未知 id 告警后丢弃,绝不新增;命中零个 → `finishEmpty`(失败),不是绿色 done。
  - `reply`/`ask` 的轮次:`success: true`、`agentResults: []`、`reply` 有值,**不发 `orchestration:start`**(没有 pipeline,发 start 会让 UI 画出并不存在的 stage)。
  - 改动 `{"run":...}` 契约时记得 `Orchestrator.run.test.ts` 与 `utils/leaderDecision.test.ts` 都要跟着动。

## 工作区语义(重要)
- **`multiclaw run` 与交互式控制台的工作区模型是刻意不同的**:
  - `run`(批处理/可复现)→ 每次调用一个 `workDir/.multiclaw/runs/run-<stamp>/`,agent 的 cwd 就在里面。`packages/cli/src/commands/run.ts` 负责。
  - 控制台(迭代式)→ **每一轮共用 `config.workDir`**,只有日志按轮隔离(`<workDir>/.multiclaw/runs/run-<stamp>/logs/`)。`App.startTurn` 里**不要**再往 `runConfig` 上覆盖 `workDir`。
- **后果:跨轮存活的文件会带来陈旧状态**。`task-plan.json` 就是实例 —— 若某轮 architect 没写新计划,`applyTaskPlan` 会把上一轮的计划套到新需求上。所以 `Orchestrator.run()` 开头必须 `clearStaleTaskPlan()`(`fs.rmSync(<workDir>/task-plan.json, { force: true })`)。
- 写 `Orchestrator` 测试时注意:task-plan.json 必须在 **architect 运行期间**写入(handler 里写),不能在 `run()` 之前写 —— 否则会被 `clearStaleTaskPlan` 清掉,测的就不是真实路径。

## TUI(`packages/dashboard`)约定
- 包名仍是 `@multiclawcli/dashboard`,但实现是 Ink TUI;exports 只有 `"./tui"`;`startTui` 用 alternate screen,非 TTY 直接抛错(无 TTY 由 `ConsoleReporter` 兜底)。
- **状态是「一轮」+「控制台」两层**:`TurnView`(turn/requirement/phase/stages/agents/leaderIds/focusId/autoFollow/scroll/success/totalDuration/warning/reply)与 `TuiState extends TurnView { name; history: TurnView[]; view?: TurnView }`。
  - 好处:一轮过去就是 `history` 里的一个 `TurnView`,而**所有面板组件都只吃 `TurnView`**,所以过去的一轮用完全相同的组件渲染。
  - 因此面板的 prop 叫 **`turn`** 而不是 `state`(它可能是一轮过去)。只读辅助函数(`progress`/`turnElapsed`/`visibleLog`/`stageStatus`)的参数类型也都是 `TurnView`。
  - `history` **只存被新一轮顶替掉的轮次**(在 `turn:start` 里 push;`turn === 0` 的种子 roster 不记);**当前屏幕上的那一轮不进 history**(已经在用户眼前)。上限 `MAX_HISTORY = 20`。
  - `snapshot(state)` **逐字段写出**,不要 `...state` 展开 —— 展开会把 `history` 拷进自己,平方级内存。
  - `view` 是 **detached copy**:`mapShown(state, fn)` 让 `focus:cycle`/`focus:set`/`stream:scroll`/`stream:clear` 在有 `view` 时改 `view`,否则改 live turn。两条不变量:① 回看不能动正在跑的轮次的焦点/滚动;② 回看不能改写 history 记录。`fn` 返回同一对象 = 无变化 → 原样返回,保住 reducer 的 `toBe` 恒等契约。
  - 渲染统一走 `const shown = state.view ?? state`,连 `hasRail` 也按 `shown` 算。
- **`LayoutInput.helpOpen` 已改名 `overlay`**(help 与 history 两个模态共用);新增 `viewing?: boolean` → 多留一行给 `viewing turn N · <需求> · esc to return` 横幅。
- **一轮以文字结束(reply/ask)时,`ReplyPanel` 接管 body**(与 `WelcomePanel` 同路数),状态行写 `✓ answered` / `? needs your input`,**绝不写 done**。此时提示栏**不能再提 `tab`**(面板不读 `focusId`,提了就是重演「tab 坏了」),改成 `enter sends · / commands · ? help`。
- `esc` 优先级:**先退出回看**(有 `view` 时),再清空输入行。
- **keymap 地基:提示符永远持有焦点 → 裸键必须让位于打字**。因此**只有两个裸键,且都以「输入行为空」为门槛**:`?` 帮助、`/` 命令面板。新增裸键前先问「用户正在打字时按到会怎样」。
- **提示符永远可用,不存在 disabled 态**。`Prompt` 的 `disabled` prop 已删除(恒为 false 是死代码)。运行中也要能打字 —— 所以 `handleKey` 里**不允许**出现 `if (running) return` 这类早退(它曾在字符插入之前把运行中的输入整段丢掉)。`?` 的门槛是 `line.text === "" && !running`:运行中按 `?` 就是打一个 `?`。
- **运行中提交 = 入队,不是丢弃,也不是并发**。`submit()` 在 `running` 时 `setQueue(push)`,再由一个 effect 在 `running === false && queue.length > 0` 时取队首 `startTurn` —— 没有这个 effect,队列就是「遗忘之地」。`QueueStrip` 显示队列(每项一行,首行前缀 `»`,超过 `MAX_QUEUE_ROWS = 3` 时末行 `(+N more)`);`layout.ts` 的 `queueRows` 必须计入 `reserved`。
- **取消 = 连队列一起丢**。`ctrl+c` 与 `/cancel` 都清空队列,否则 abort 一落地后继需求立刻开跑,读起来像「取消没生效」。glyph 用 `»`(Latin-1,任何终端占一格);`⏳` 这类象形字宽度不定,会破坏网格。
- `menuOpen` **不**受 `running` 限制:运行中也能开 `/` 面板,那是 `/cancel` 唯一被列出的地方。开面板是用户主动打 `/` 的结果,所以把方向键让给它可接受。
- 模态浮层(help / history)在 `handleKey` 里**先于**普通按键处理,并吞掉自己用不到的键 —— 否则方向键会滚到它背后的面板。
- `ctrl+c` **逐层剥离**(帮助→历史→取消运行→清空输入→退出),不直接退出;`ctrl+d` 空行退出。`tab`/`shift+tab` 切焦点;焦点自动跟随下一个启动的 agent,手动切换后停止跟随。
- 状态永远**字形 + 颜色双编码**(色盲可用 + 复制粘贴后仍可读);只用 16 个具名 ANSI 色,让终端主题能重映射。
- 日志滚动存「距尾部的偏移」而非绝对行号 → 新输出不顶走正在读的内容;滚到尾部自动恢复 follow。
- 新组件/新行加入布局前,必须同步 `layout.ts` 的 `reserved` 行预算,并给 chrome 加 `flexShrink={0}`;否则 Yoga 会静默压扁 header(见日志「三个可复用的坑」)。
- **Ink 的 `Box` 默认是 `flexDirection="row"`**(不是 column)。这有两个后果:① 单子元素的「包装盒」写成 `<Box>` 会让子元素按内容宽度收缩,而不是撑满 → 里面所有 `space-between` 静默塌陷(曾导致 stream 面板标题栏右列不右对齐);包装盒要显式写 `flexDirection="column"`。② 新增任何多行区域时先问「这个 Box 到底是行还是列」。
- 多行正文**交给 Ink 自己折行**:把整段放进**单个 `<Text>`**(`ReplyPanel` 就是这么做的)。拆成逐行数组会引入 `noArrayIndexKey` 抑制,且折行点更差。
- 测试:`FORCE_COLOR=1` 才能断言光标;fake stdout 的 `write` 必须回调(否则 Ink `waitUntilRenderFlush` 永不 settle);fake stdin 必须 `isTTY=true` + no-op `setRawMode`。
- **Ink 的 `<Text>` 样式是向下合并的,且无法 un-inherit**:子 `<Text>` 传 `dimColor={false}` 与不传无法区分,所以想让某段文字跳出父级的 dim/bold,必须把它做成**兄弟节点**而不是子节点(曾导致块状光标嵌在 dim 占位符里被一起变暗)。配套:自己画的光标格要「跟邻居亮度一致」——在 ghost 文本上要 dim、在已输入文本上要正常,否则那一格会闪亮度。
- **Ink 会 trim 行尾的未着色空白**:行尾那一格在「熄灭」相位会消失,反色时保留。判断「闪烁有没有挤动其他内容」时用 `trimEnd()` 比较;行尾之后无内容可挤,这个不对称是安全的。
- 自绘光标的不变量:**每个闪烁相位占的列数必须相同**。空行时应把光标「画在」占位符首字符上(块光标语义),而不是在它前面插一格——插入式会让 ghost 文本每秒左右横移。
- 渲染集成测试**不能轮询 stdout 等状态**:非交互模式下 Ink 只在 unmount 时写一次帧,轮询永远读不到东西(表现为每个用例跑满 timeout)。改为让被测组件通过 `onTurnStart` 拿到 `eventBus`,在 `orchestration:complete` 时 resolve 一个 Promise,再等 ~120ms 让 React 画完。
- 需要「先跑完一轮、再敲命令」的流程,用 `driveFrame({ ready, thenKeys })` —— `thenKeys` 在 `ready` resolve **之后**才写入。这是测 `/history` 这类命令的唯一办法。
- 按键要**分块写入**:Ink 把单个多字符 chunk 当粘贴处理并把换行折成空格,所以 `"文本\r"` 会输入一个空格而不是提交;`\r` 必须单独 write,且两次写入之间要留一个 tick。
- **同一屏出现两个 agent 列表时,聚焦语义必须一致**。首屏 `WelcomePanel` 曾是 `TeamPanel` 之外的一块手写旁路列表,不读 `state.focusId` → hint bar 写着 `tab switch` 但画面纹丝不动,用户判定「tab 坏了」(reducer 其实一直是对的)。旁路列表是这类 bug 的温床;要么复用同一组件,要么至少复用同一套 `›` 约定。
- **提示栏只列「此刻真的有效」的键**。只要某个键在当前屏幕上没有可见效果,就不要写进 hint bar —— 这比让键「无效但可用」更糟。已按这条调整过三处:运行中(`enter queues`)、reply 面板(`enter sends`,去掉 `tab`)、回看中(`esc live`)。
- **测试夹具比真实用法更宽容 = 藏 bug**。`DEMO` 手工给每个 agent 设了 `taskTitle`,而真实配置(内置预设)一个都没设 → 首屏描述列全空却测不出来。凡「用户能看到的默认值」,夹具都应取自真实路径(见 `PRESET`,用内置工厂搭)。同理:`App.run.test.tsx` 的 fake runtime **必须让 leader 输出 plan JSON**,否则按新契约那一轮会变成 reply,所有「跑完整流水线」的断言都会静默失效。
- **临时夹具里的 agent 必须带 `taskPrompt`(哪怕空串)**。`renderPrompt` 第一句就是 `template.matchAll(...)`,漏了它不会报「缺字段」,而是抛 `Cannot read properties of undefined (reading 'matchAll')`,被 `AgentRunner` 包成 `agent:failed`——看起来像产品 bug,其实是夹具少写一行。`AgentDefinition.taskPrompt` 是必填,所以 `pnpm typecheck` 能挡住,但 **vitest 不做类型检查**,临时 `.test.tsx` 里手搓的对象字面量会静默跑起来。
- 想让 fake leader **走 reply 分支**,光返回散文还不够:prompt 是从 `taskPrompt` 渲染的,而 `requirement` 靠 `{{requirement}}` 占位符注入。leader 的 `taskPrompt` 留空 → 渲染出空串 → 连「hello」都看不到,判断条件永远为假。夹具里给 leader 设 `taskPrompt: "{{requirement}}"`。

## 环境坑(pnpm)
- 当前 `nodeLinker` 是 **isolated**(不是 hoisted)。新增依赖后 `.bin` 软链可能缺失或指向不存在目录,报 `vitest: command not found`。**再跑一次 `pnpm install` 通常自愈**,不要手工补软链。
- **增量 `pnpm install` 可能把新加的平台二进制错写进 `node_modules/.modules.yaml` 的 `skipped` 数组**(实测:`@rolldown/binding-darwin-arm64@1.2.13` 被跳过 → `vite build` 报 `Cannot find native binding`)。`pnpm install --force` 一次性修好;干净目录安装不复现,所以 CI(干净安装)不受影响。排查手法:`grep -n skipped node_modules/.modules.yaml`。
- **`pnpm -r <script>` 会先校验并自动补齐依赖**(pnpm 12 的 verifyDepsBeforeRun)。若 `node_modules` 与 lockfile 不一致——例如手工放进 `node_modules/@biomejs/cli-darwin-arm64` 的那个二进制——它会隐式跑一次 install、`+24 -19` 重新链接 `.bin`。此时若 vitest 正在启动,就会出现「no tests / 1 error」的**假失败**(已实测复现)。单独重跑对应包即绿,不是代码问题。
- 本机 pnpm store 偶发写入失败(尤以 `@biomejs/cli-darwin-arm64` 为甚),重装通常能成功。

## 待办(已识别,未修复)
- cli 的 `commands/init.ts`、`run.ts`、`tui.ts` 与 dashboard 的 `tui/App.tsx`、`tui/index.ts` 仍无单测。
- 覆盖率门槛可随覆盖提升逐步上调。
- `graft/` 是**本机缓存且已 git-ignore**(`graft build` 重新生成,$0 无需 key);改动源码结构后跑一次 `graft build` 清掉失效节点。CI 可用 `graft check` 判 stale。
- **TUI 功能路线图(用户已拍板)**:
  1. ~~修「空计划静默成功」+「运行中丢按键」~~ ✅
  2. ~~**Q2 意图路由**~~ ✅ leader 三态 `reply`/`ask`/`run`;「没有 plan JSON」= reply;TUI 用 `ReplyPanel` + `✓ answered` / `? needs your input`。
  3. ~~**Q4 持久工作区 + 历史**~~ ✅ 控制台每轮共用 `workDir`(日志按轮隔离);`TurnView`/`TuiState` 拆分 + `history` + `view` + `/history` 浮层。
     - 注:最终**没有**走当初设想的 `{ tasks: TaskState[], activeId, queue }`。改用「`TurnView` 是基类、`TuiState` 继承它再加 `history`/`view`」——既有测试几乎全绿,代价小得多。将来做并发时,`tasks: TurnView[]` 仍然是最自然的延伸。
  4. **Q5 并发**:先不做。将来形态是「前台任务 + 后台任务」,后台任务建议用 git worktree 避免共享工作区撞文件。
  5. **`ask` 的回答没有上下文(下一轮最该做的)**:leader 问「用哪个数据库?」,用户答「Postgres」→ 下一轮 `requirement` 就是孤零零的 `Postgres`。工作区持久,leader 能从代码推断不少,但这是**降级可用**。修法:把最近几轮(需求 + 回答)拼成一个 context 变量喂进 leader prompt。属于新设计决策(塞多少历史、token 预算),需用户拍板。
