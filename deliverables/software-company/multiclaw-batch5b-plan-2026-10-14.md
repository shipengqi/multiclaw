# Batch 5b 实施计划 —— TUI 会话与可发现性

> 来源：`multiclaw-implementation-plan-2026-10-13.md` 的 Batch 5
> 范围：**T9≡E9 / T5 / T6 / T10**（T7 已按作者同意挪到 5c，与 `/export` 配对）
> 日期：2026-10-14　状态：开工

## 0. 范围与两项事前判断

四项全在 `packages/dashboard`，彼此咬合：T9 给 T5 提供了"跨会话的过去轮次"这个**数据源**，
T6 与 T10 是同一件事的两面（命令的可发现性），所以放在一批做。

作者已拍板：`/replay` + `/fork` 取代原 T5 的 `/retry` 语义（`/retry` 在 Batch 3 已被"重跑失败 agent"占用）；
T7 挪后。派活前读完代码，另有**两处与评审条目字面不符**的判断，写在下面，作者可随时推翻。

**判断一：T10 不做"把命令逐条列进 help"。** 评审条目 T10 的意图是"help 不会与 `COMMANDS` 漂移"，
但逐条列举在 24 行终端上装不下（算术见 §4）。改为**不再枚举**：help 只留三个"不是命令的键"加一行
由 `COMMANDS.length` 派生的汇总行，枚举的责任交给 `/` 面板（它本来就由 `COMMANDS` 构造，不可能漂移）。
附带必须修的面板缺陷：`MAX_MENU_ROWS = 7` 而 5b 后命令有 11 条，**面板里 4 条命令看不到**。

**判断二：`tuiReducer` 的 `turn:start` 守卫要改一个字段。** `state.turn > 0`（`state.ts:559-560`）
是"屏幕上的这一轮是否真的开始过"的**代理**；`turn` 一旦从磁盘续上编号，这个代理就会在首个
`turn:start` 把初始态当成"上一轮"塞进 history（详见 §1.2）。会话内两者等价，所以这是修正而非放松。

---

## 1. T9≡E9 会话持久化（history 落盘 + 启动加载）

### 1.1 现状

- `App.tsx:156` `useReducer(tuiReducer, config, createInitialState)`；`state.ts:261` 初始 `history: []`
- `App.tsx:234` 只有**日志**落盘（`workDir/.multiclaw/runs/run-<stamp>/logs`），轮次本身不落盘
- `App.tsx:218` `conversationTurns(stateRef.current)` 只带**本会话**的轮次
- 后果：重启后 `/history` 是空的、`state.turn` 回到 0、`config.history` 为空 ⇒ 跨会话上下文全丢

### 1.2 改法

**(a) 新文件 `packages/dashboard/src/tui/history.ts`**

```ts
export const CONSOLE_DIR = "console"
export const HISTORY_FILE = "history.json"
export function historyPath(workDir: string): string   // workDir/.multiclaw/console/history.json
export function loadHistory(workDir: string): TurnView[]      // 同步、绝不抛
export async function saveHistory(workDir: string, turns: readonly TurnView[]): Promise<void>
```

- `loadHistory`：`readFileSync` → `JSON.parse` → **必须是数组** → 逐项浅校验
  （是对象、`typeof turn === "number"`、`typeof phase === "string"`），丢掉不合格项。
  ENOENT / 语法错 / 类型错 **一律返回 `[]`**。最后 `slice(-MAX_HISTORY)` 兜底（手改或旧版本文件）。
- `saveHistory`：`mkdir(recursive: true)` → 写 `history.json.tmp` → `rename`。
  **必须原子替换**：直接覆写时若进程被 kill 在写入中途，留下的半个 JSON 会让下次启动丢掉**全部**历史
  （因为 `loadHistory` 只能选择丢掉坏文件）。
- 用 `readFileSync` 而非异步：读发生在 `useReducer` 的惰性初始化里，正好一次，且在首帧之前——
  异步加载会与"用户马上敲的第一轮"竞争，反而要引入"历史还在路上"的中间态。

**(b) `state.ts`**

1. 新增导出 `recordedTurns(state: TuiState): TurnView[]`
   = `[...state.history, ...(state.phase === "complete" ? [snapshot(state)] : [])]`
   ——"值得留下的轮次"：history 里已有的（**可能含被取消的**，它们 `phase` 仍是 `running`）
   加上**已经结束的当前轮**。
   `snapshot` 是模块私有，所以这个导出必须落在 `state.ts` 里。
2. `conversationTurns`（`:530-544`）改为基于 `recordedTurns` 派生，过滤条件不变
   （`phase === "complete"` 且 `requirement` 非空）。现在它在 `:532` **内联了同一段推导**，
   两处各写一份必然会漂移——这是这次要消掉的重复。
3. `createInitialState(config, history: TurnView[] = [])` —— **只加可选第二参**。
   `src/tui/index.ts` 里有 `export * from "./state"`，所以 `state.ts` 的每个导出都是公开 API，
   **改签名是破坏性变更**。
   - `history` 装入 `state.history`
   - `turn` = `history.at(-1)?.turn ?? 0` —— 编号跨会话**连续**，否则 `/replay 3` 会指向两轮
   - `requirement` / `phase` 保持无 / `idle`：新会话里没有正在跑的轮次
4. **`turn:start` 的守卫**（`state.ts:559-560`）：`state.turn > 0` → `state.requirement !== undefined`

   理由：`turn:start` 要记住的是"**被顶替的**那一轮"。加载历史后 `turn` 已被种成 N，
   而初始态本身**不是一个轮次**（没有 requirement、`phase: idle`）。旧守卫会把它塞进 history，
   于是 `/history` 多出一条 `turn N · interrupted · (no requirement)` 的**假记录**。

   会话内 `state.turn > 0` ⟺ `state.requirement !== undefined`（两个字段由同一个 `turn:start` 一起写），
   所以**行为等价**；只有"从磁盘续编号"这一种情形被修正。

**(c) `App.tsx`**

- `useReducer(tuiReducer, config, (c) => createInitialState(c, loadHistory(c.workDir)))`
- 落盘 effect，deps `[state.history, state.phase]`，内部经**已有的** `stateRef.current`（`App.tsx:160-161`）读当前态：

  ```ts
  const lastSaved = useRef<string | undefined>(undefined)
  useEffect(() => {
    const turns = recordedTurns(stateRef.current).slice(-MAX_HISTORY)
    if (turns.length === 0) return          // 从没跑过轮次的工作区不该多出一个空文件
    const json = JSON.stringify(turns)
    if (json === lastSaved.current) return  // 见下
    lastSaved.current = json
    void saveHistory(config.workDir, turns).catch((err) =>
      setNotice(`history not saved: ${err.message}`)
    )
  }, [state.history, state.phase])
  ```

  - **为什么 dep 只取这两个字段**：`recordedTurns` 的成员只可能在这两处变化——
    `turn:start` 换掉 `history` 的身份，`orchestration:complete` 把 `phase` 改成 `complete`。
    其余事件都是 `{...state}` 展开，两个引用都不动。把 `state` 整个放进 deps 会让 effect
    **每 110ms（spinner tick）重跑一次**，把 `JSON.stringify` 一个最大 ~1.6MB 的数组变成帧率问题。
  - **为什么用 ref 读 state 而不是把 `state` 放进 deps**：把 `state` 写进 deps 就是上一条的帧率问题；
    不写又会被 `useExhaustiveDependencies` 拦下。ref 的取值不在依赖分析范围内，是这条窄路上的标准做法。
  - **`lastSaved` 字符串比对是必需的，不是优化**：一轮会产生**两次** effect——
    `turn:start`（把上一轮推进 history）和 `orchestration:complete`。第一次写的内容里
    新轮次还是 `running`（不入 `recordedTurns`），所以两次的 JSON **完全相同**；比对把第一次整个省掉。
  - **启动时首次 effect 会重写一遍刚读进来的内容**——`lastSaved` 初始为 `undefined`，比对不成立。
    一次有界写入，**接受**，但要在注释里写明，不要留成"看起来像 bug"的代码。
  - `config.workDir` 在会话内不变，不必进 deps。

### 1.3 必测不变量

- `loadHistory`：目录不存在 → `[]`；坏 JSON → `[]`；`{}`（非数组）→ `[]`；数组里混 `null` / 数字 /
  缺 `turn` 的对象 → **只丢坏的，好的保留**；超过 `MAX_HISTORY` → 只留最后 N 条。**五种都不抛。**
- `saveHistory`：写完的文件能被 `loadHistory` 原样读回（round-trip）；目录不存在时自动创建。
- `recordedTurns`：当前轮 `running` 时**不含**它；`complete` 时**含**它；被取消的轮次留在
  `history` 里（`phase` 仍 `running`）且**不被 `conversationTurns` 采纳**。
- `createInitialState(config, history)`：`turn` 接续为最后一条的编号；**不传第二参时与改动前逐字一致**
  （现有 `state.test.ts:683-702` 必须全绿）。
- **回归（新用例，关键）**：`{...initialState, turn: 5, history: [...], requirement: undefined}` 上跑
  `turn:start` → `history` **不增长**；`{...initialState, turn: 5, requirement: "x"}` → 增长 1 条。
- 端到端（App 集成）：`workDir` 里先放一份 `console/history.json` → 渲染 App → `/history` 能列出它；
  跑完一轮 → 文件内容含该轮（用临时目录，不要污染仓库）。

### 1.4 需要改的现有测试

`state.test.ts:462` 的 `const full: TuiState = { ...initialState, turn: MAX_HISTORY + 1, history: older }`
**在建模一个生产里不可能出现的状态**（`turn > 0` 却没有 `requirement`——真实状态里这两个字段由
同一个 `turn:start` 一起写）。给它补一个 `requirement`，**保留** `:466-468` 的上限断言。
这是**适配**（修一个不真实的 fixture），不是放松断言——不许顺手改断言值。

### 1.5 回退证据

- 把 `recordedTurns` 换成 `state.history`（丢掉刚结束的当前轮）→"最后一轮也落盘"的用例必须变红。
- 把守卫改回 `state.turn > 0` → §1.3 的回归用例必须变红。

---

## 2. T5 `/replay [turn]` + `/fork [turn]`

### 2.1 现状

`/retry [id]`（Batch 3，`App.tsx:335-372`）已占用"重跑失败 agent"。`/history`（`App.tsx:320-328`）
只能**看**过去的轮次，既不能重跑，也不能拿回来改。

### 2.2 改法

两条命令都从 `recordedTurns(state)` 按 `turn` 号取目标，**默认取最后一条**（"刚才那个再来一遍"）。
共用同一段解析，写在 `runCommand` 的 `switch` 里（`App.tsx:290-397`）：

```ts
const turns = recordedTurns(state)
if (turns.length === 0) { setNotice("nothing to replay yet"); return }
const raw = args[0]
const target = raw === undefined ? turns[turns.length - 1] : turns.find((t) => String(t.turn) === raw)
if (!target) { setNotice(`no turn ${raw}`); return }
const requirement = target.requirement
if (!requirement) { setNotice(`turn ${target.turn} has no requirement`); return }
```

- **`/replay [turn]`**，availability `idle`：把该轮的 `requirement` 作为**新的一轮**跑
  （`void startTurn(requirement)`）。
  **必须 idle**：`startTurn` 会 `abortRef.current = controller`（`:247`）、`setRunning(true)`、
  `dispatch turn:start`。运行中调用会**丢掉正在跑的那个 controller**（此后再也 cancel 不了它）
  并覆盖在屏的轮次。
- **`/fork [turn]`**，availability `always`：把该轮的 `requirement` **填进提示行**
  （`setLine({ text: requirement, cursor: requirement.length })`），**不跑**。用户改完自己回车。
  这才是"分支"的含义：从旧需求长出新需求。它只动输入行，所以运行中也可用（回车会正常入队）。

**顺序坑（必须写进注释）**：`startTurn` 的第一句就是 `setNotice(undefined)`（`App.tsx:215`），
且在任何 `await` 之前**同步**执行。所以 `/replay` 的 `setNotice(...)` 必须写在
`void startTurn(...)` **之后**，否则会被清掉。

`COMMANDS`（`commands.ts:22-54`）在 `retry` 之后加两条：

```ts
{ name: "replay", args: "[turn]", description: "Run an earlier turn again", availability: "idle" },
{ name: "fork", args: "[turn]", description: "Edit an earlier turn's requirement", availability: "always" },
```

### 2.3 必测不变量

- `/replay` 无参 → 跑**最后一条**的 requirement；`/replay 1` → 跑第 1 条的 requirement。
- `/replay 99` → notice `no turn 99`，**不起轮次**（断言 `onTurnStart` 未被调用）。
- 无历史 → notice `nothing to replay yet`。
- `/fork 2` → 提示行文本**等于**第 2 条 requirement，且**没有**新轮次。
- 运行中 `availableCommands(true)` **不含** `replay`、**含** `fork`。
- 回退：把 `/replay` 的 `void startTurn` 换成 `setNotice` → 前两条用例必须变红。

### 2.4 补记：`availability` 只在面板里生效（实施中发现的缺陷，已并入本批）

**本节是对 §2.2 / §2.3 的更正，原文保留在上，不改。**

§2.2 写的"必须 idle"理由是**对的**（运行中 `startTurn` 会覆盖 `abortRef.current`、丢掉在跑的 controller、
再起第二个 Orchestrator 于同一 `workDir`），但 §2.3 那条不变量只验了 `availableCommands(true)` 不含 `replay`
——**那恰好是让这个缺陷藏起来的东西**：`availability` 的声明是 `/** When a command may be run. */`
（`commands.ts:10`），而它**只在面板的候选列表里生效**：

- `App.tsx:513-516` `submit()`：`parseCommand` 之后**无条件** `runCommand(command.name, command.args)`
- `runCommand`（`:354`）的每个分支都没有阶段守卫
- 面板只决定"提供什么"，把命令**逐字打出来再回车**完全不经过它

于是运行中打 `/replay` + 回车会真的走到 `startTurn`：**丢掉正在跑的 controller**（此后 `ctrl+c` 与 `/cancel`
都停不下那一轮）、`dispatch turn:start` 覆盖在屏轮次、并起第二个 Orchestrator。
`/retry` 自 Batch 3 起就有同一个洞；`/cancel` 是唯一自带守卫的（`if (!abortRef.current)`）。

**这是同一个缺陷类别的第四次出现**（F1 块预算、F4 条目预算、C12 `resolveArgs`、`isTurnView`）：
**声明了一个契约，代码不履行。** 判据不变——让代码符合文档。

**改法**（在唯一的派发点收口，不新增第二套"可用"定义）：
- `commands.ts` 新增 `canRun(name, running)`，委托给已有的 `availableCommands`（阶段逻辑只此一份）
- `runCommand` 在 `switch` 之前查 `COMMANDS`：查不到 → 照旧落到 `default:`（`unknown command: /foo` 不变）；
  查到但 `canRun` 返回 undefined → `setNotice(...)` 后 return
- `runCommand` 需要 `running` 进闭包与 deps

**必测不变量**：用慢速 runtime 让轮次**真的在跑**，打 `/replay` + 回车，断言**轮次数仍为 1**
（即 `startTurn` 从未被触达）——验的是**危害消失**，不是"出现了提示"。
回退证据：去掉守卫后该用例必须变红。

**顺带核实**：无测试断言 `nothing to cancel`（该字符串只在 `App.tsx:483`）；也无测试在运行中打
`/retry` / `/replay`（现有用例都在轮次结束后才打）⇒ 加守卫不破坏任何既有断言。

---

## 3. T6 `/focus` 参数补全（并统一 id 解析）

### 3.1 现状

- `/focus <id>`（`App.tsx:298-311`）要求**逐字**输入 id，打错只有 `unknown agent: xxx`
- `/` 面板只补**命令名**：`menuQuery`（`commands.ts:99-103`）一遇空格就返回 `undefined`
  （有意为之，注释写明了理由），所以 `/focus ` 之后没有任何补全
- `/retry <id>`（`App.tsx:342-355`）同样只接受逐字 id

### 3.2 改法

**(a) `commands.ts`（纯函数，可单测）**

- `CommandSpec` 增可选字段 `completes?: "agent"`；`focus` 标记 `completes: "agent"`。
  用**数据**声明"这个命令的参数可补全"，而不是在 App 里写 `if (name === "focus")`。
- `PaletteRow = { key: string; label: string; description: string }`
- `paletteRows(commands: readonly CommandSpec[]): PaletteRow[]`，label = `/${name}` + （有 `args` 时 ` ${args}`）
- `argQuery(text): { command: CommandSpec; partial: string } | undefined`
  —— `isCommandLine` 且匹配 `/^(\S+)\s+(\S*)$/` 且该命令有 `completes`；否则 `undefined`。
  **只认第一个参数**（今天只有 `/focus` 有 `completes`）。
- `completeAgents(partial, ids, limit = 8): string[]` —— 大小写不敏感前缀匹配；
  `partial` 为空则返回前 `limit` 个（打 `/focus ` 直接看花名册）。
- `resolveAgentId(input, ids): { id: string } | { error: string }`
  —— 精确命中优先；否则前缀命中：1 个 → 该 id；0 个 → `` `unknown agent: ${input}` ``；
  \>1 个 → `` `ambiguous: ${hits.join(", ")}` ``。

**(b) `components/prompt.tsx`**：`CommandMenu` 改为吃 `rows: PaletteRow[]`（`:75-99`）。
label 已含前导 `/`，所以组件里硬编码的 `/{padRight(label, nameWidth)}`（`:93`）改成
`padRight(row.label, nameWidth)`。**组件不再认识 `CommandSpec`**——命令面板与参数面板走同一条渲染路径。
（`components/*` 不在 `index.ts` 的公开导出里，可以自由改。）

**(c) `App.tsx`**

- 命令面板行 = `paletteRows(matches)`；参数面板行 = `completeAgents(arg.partial, Object.keys(shown.agents))`
  映射成 `{ key: id, label: id, description: agent.description ?? agent.name }`
  （用静态 `description` 而非 `taskTitle`：补全时用户认的是"这个 agent 是干嘛的"）
- `paletteOpen = menuOpen || argOpen`；`layout.menuRows`（`:485`）与 `CommandMenu` 的渲染条件
  （`:825`）都改用 `paletteOpen`
- 方向键 / esc / enter 的处理块从 `if (menuOpen)`（`:582`）改为 `if (paletteOpen)`。
  enter 在参数面板 = `runCommand(arg.command.name, [id])`——**接受即执行**，
  与命令面板"回车即运行"一致；`/focus` 只有一个参数，不存在"接受后继续打字"的需求。
- 提示条（`:708-720`）加 `argOpen` 分支：`"↑↓ select · enter focus · esc close"`
- `/focus` 与 `/retry` 的 id 校验改用 `resolveAgentId`（`/retry` 也吃前缀，两个命令的 id 语义必须一致）
- 参数面板游标复用现有 `menuCursor`，key 用 `` arg ? `${arg.command.name} ${arg.partial}` : ... ``。
  两个面板互斥（`menuQuery` 有空格即 `undefined`，`argQuery` 无空格即 `undefined`），不会同时开。

### 3.3 必测不变量

- `argQuery`：`"/focus "` → `{command: focus, partial: ""}`；`"/focus ar"` → partial `"ar"`；
  `"/focus"` → `undefined`；`"/agents x"` → `undefined`（`agents` 无 `completes`）；`"plain"` → `undefined`。
- `completeAgents("ar", ["architect","dev","archivist"])` → `["architect","archivist"]`；
  `completeAgents("AR", ...)` 同上（大小写不敏感）；`completeAgents("", ids)` → 前 8 个。
- `resolveAgentId("dev", ids)` → `{id:"dev"}`；`"de"` → `{id:"dev"}`；
  `"d"`（命中 `dev` + `designer`）→ `{error:"ambiguous: dev, designer"}`；`"nope"` → `{error:"unknown agent: nope"}`。
- `paletteRows(COMMANDS)` 每行 label 以 `/` 开头，且当命令有 `args` 时 label 含 `args`。

### 3.4 需要改的现有测试

`components.test.tsx:752-775` 的 3 处 `renderFrame(<CommandMenu commands={[...COMMANDS]} selected={0} />)`
→ `rows={paletteRows(COMMANDS)}`。**断言（描述文本、caret 在选中行）一律不动。**

---

## 4. T10 help 不漂移 + 面板按选中项开窗

### 4.1 现状

- `HELP_GROUPS`（`overlays.tsx:15-44`）**手写**三组，commands 组只有 `/`、`/history`、`?`、`ctrl+c`；
  `COMMANDS` 里已有的 `agents`/`focus`/`clear`/`verbose`/`retry`/`cancel`/`quit` **一个都不在**。
  5b 新增 `/replay`、`/fork` 后会立刻再漏两条——漂移是必然，不是可能。
- `MAX_MENU_ROWS = 7`（`layout.ts:30`），而 `/` 面板空查询下匹配**全部**命令。
  5b 后 `COMMANDS` 有 11 条 ⇒ **4 条命令在面板里根本看不到**；
  且 `menuWindow = matches.slice(0, layout.menuRows)`（`App.tsx:497`）永远取**前** 7 条，
  方向键移到第 8 条时高亮被 clamp 在第 7 行（`:498`）——看起来像"方向键卡住了"。

### 4.2 改法

**(a) help 不再枚举命令。** commands 组保留三个"不是命令的键"（`/`、`?`、`ctrl+c`），
再加一行**派生**的汇总行：

```ts
["/<command>", `All ${COMMANDS.length} commands — type / to browse`]
```

数字来自 `COMMANDS.length`，增删命令自动更新；**枚举的责任交给 `/` 面板**
（它本来就由 `COMMANDS` 构造，不可能漂移）。

**为什么不能真的逐条列**——`helpRows()` 是行预算，不是排版偏好：

| | prompt | panes | commands | 合计 |
|---|---|---|---|---|
| 今天（commands 4 行） | 4 | 5 | 4 | `helpRows(false)=23` / `helpRows(true)=18` |
| 逐条列举（commands 12 行） | 4 | 5 | 12 | `helpRows(true)=26` |

`components.test.tsx:736-737` 卡住 `helpRows(true) ≤ 19`（24 行终端下 `bodyHeight` 正好 19）。
26 > 19 ⇒ 紧凑态也装不下 ⇒ `HelpOverlay` 从底部裁掉（`overlays.tsx:94-118` 的注释写明：
第一个消失的就是 "esc or ? to close"）。要让逐条列举成立，得先给 help 加滚动键位——
那是独立改动，不属于 5b。**这一条如果作者不认可，请直接推翻：我按上面的算术判定"逐条列举"
在 5b 内做不到，而不是想省事。**

**(b) 面板按选中项开窗**（让全部命令可达）：

- `historyWindowStart`（`overlays.tsx:69-74`）**改名** `listWindowStart`
  ——函数体与"历史"无关，本来就是通用列表开窗。更新 3 处调用：`HistoryOverlay`（`:163`）、
  `App`、`components.test.tsx` 的 import 与用例名。
- `App.tsx`：
  ```ts
  const menuStart = listWindowStart(selected, matches.length, layout.menuRows)
  const menuWindow = matches.slice(menuStart, menuStart + layout.menuRows)
  ```
  传给组件的是 **`selected - menuStart`**（组件只知道窗口内的相对下标）。
- 删掉 `App.tsx:493-498` 的 `menuSelected` 与那段"highlight 被 clamp"的注释——
  开窗之后不存在"高亮一行没画出来的行"，那段 clamp 是在给一个开窗前的 bug 打补丁。

### 4.3 必测不变量

- `helpRows(true) ≤ 19` 且 `helpRows(false) > 19`（**现有用例，必须继续绿**）。
- help 渲染后包含 `String(COMMANDS.length)`（**断言用变量而非字面量**——写死 `"11"` 会在下次加命令时碎掉，
  那就变成"改测试让 CI 变绿"了）。
- `listWindowStart(8, 11, 7)` → `2`；`listWindowStart(0, 11, 7)` → `0`；`listWindowStart(10, 11, 7)` → `4`。
- `CommandMenu` 收到 `selected - menuStart` 后 caret 落在**正确的那一行**（组件测试）。

---

## 5. 仓库卫生：`.gitignore` 加 `.multiclaw/`

`run` 与 TUI 都会往 `workDir/.multiclaw/` 写运行态（`runs/` 早已如此，`console/` 是 5b 新增），
而 `examples/dev-team` 的 `workDir` 是 `./workspace`、真实用户也常把 `workDir` 设成项目根。
今天它**没有被忽略**（`.gitignore` 里没有 `.multiclaw`，`git ls-files` 也没有已跟踪的 `.multiclaw`），
所以跑一次 TUI 就会在 `git status` 里冒出一串未跟踪文件。加一行即可。这是仓库卫生，不是功能。

---

## 6. 交付、验收与边界

**交付分两个 commit**（都在 `packages/dashboard`，`App.tsx` 被四项共同触碰，所以必须一个写者顺序做）：

1. `feat(tui): remember finished turns across sessions` —— T9（`history.ts` 新增、`state.ts`、`App.tsx`）
2. `feat(tui): replay and fork past turns, complete agent ids` —— T5 + T6 + T10（`commands.ts`、
   `prompt.tsx`、`overlays.tsx`、`App.tsx`）+ `.gitignore`

**验收门槛**：`pnpm verify` 全绿；**且** `packages/dashboard` 单独跑 `pnpm test:coverage`
（dashboard 门槛 90/85/90/90，而 `pnpm verify` 里的 `test` **不查覆盖率**）。
`history.ts` 是**新增文件**，`commands.ts` 新增 4 个函数——两者都必须配齐测试，
否则函数覆盖率会掉到门槛以下（Batch 5a 的 `providers/detect.ts` 踩过这个坑）。

**必须遵守的既有约束**：

- `state.ts` 的每个导出都是公开 API（`index.ts` 的 `export *`）⇒ `createInitialState` **只能加可选参数**
- `CommandMenu` 在 `components/*` 里，**不是**公开导出 ⇒ 可以自由改 props
- `biome-ignore` 要贴紧被标记行且理由写一行
- 新用例写完先**临时回退修复确认它变红**，再恢复——每个 §x.3 里的"回退证据"都要实际执行一遍

**与 5c 的边界（不在本批）**：E4 交付物摘要、E5 `run --dry-run`、E7 `/export`、**T7 流内搜索**
（受 `MAX_LOG_CHARS = 8000` 限制只能搜到缓冲区尾部，真正的需求由 `run-*/logs/*.log` 与 `/export` 覆盖）、
C9 真并发池。

**已知未修**：`Orchestrator.selectAgents` 仍会写一个 `undefined` 的 `dependsOn` 键（P3，5a 记录在案）。
