# Batch 5b 独立复核报告 —— T9 / T5 / T6 / T10 + A/B/C 收口

> 复核人：严过关（QA）｜日期：2026-10-14｜HEAD：`9a17bff`（工作树干净，未 commit）
> 方法：**对抗式**——独立测量、自写探针用例、亲手回退复现，不复述工程师结论。
> 计划书：`deliverables/software-company/multiclaw-batch5b-plan-2026-10-14.md`
> 约束遵守：未改源码（回退探针改动均**逐字还原**，`git status --porcelain` 为空）；未与其他 vitest 并发（`App.run.test.tsx` 用固定 `/tmp/multiclaw-tui-*` 工作区，两次并发会互相污染）；未重开已接受事项（三处 `state.test.ts` fixture 适配、persist effect 的 `biome-ignore`、`App.run.test.tsx` 的 `beforeEach` 清理、`resolveAgentId` 规格笔误）。

## 判定

**PASS WITH ISSUES**（无阻塞项；无 P0/P1/P2；3 项 P3）

四项功能**真实有效**且可被现有测试证伪：T9 跨会话落盘/加载、T5 `/replay`+`/fork`、T6 id 补全、T10 help 计数 + 面板开窗、A/B/C 三处收口均按计划工作。计划书 §6 要求的**三条回退证据逐条实跑、逐条变红**，与文档声明一致。三项 P3 是**覆盖率缺口与注释精度**，不影响正确性。

---

## 0. 门禁（独立运行）

```
$ pnpm verify            # 根目录，EXIT 0
  lint:  Checked 131 files in 21ms. No fixes applied.
  build: 3 个包 tsup 成功
  tsc:   3 × tsc -p tsconfig.json --noEmit 通过
  test:  core 369 | dashboard 380 | cli 81  = 830 passed

$ cd packages/dashboard && pnpm test:coverage   # EXIT 0
All files    |   99.45 |  96.77 |   100 |  99.66 |
 commands.ts |     100 |    100 |   100 |    100 |
 format.ts   |     100 |    100 |   100 |    100 |
 history.ts  |     100 |    100 |   100 |    100 |
 layout.ts   |   94.59 |  93.33 |   100 |  97.05 |
 state.ts    |     100 |   94.9 |   100 |    100 |
```
门槛 90/85/90/90 **全部满足**（新增 `history.ts` 100% 覆盖，`commands.ts` 4 个新函数 100%）。`test:coverage` 在 dashboard 包内运行，无 cli 的 `safe-delete` 沙箱干扰。

---

## 1. 探针 1 —— `/replay` 的 notice 顺序坑是否被测试锁住？

**结论：坑是真的，但没有测试锁它（P3）。**

**先证"坑真"**（自写探针，临时置于 `src/tui/zz-probe5b.test.tsx`，跑完即删）：

```
✓ shows 'replaying turn N' after a successful replay   （正确顺序下 "replaying turn 1" 出现在帧里）
```

把 `App.tsx` 的 `/replay` 分支两行**对调**（`setNotice` 提到 `void startTurn` 之前）后再跑：

```
× shows 'replaying turn N' after a successful replay
AssertionError: expected '◆ multiclaw · dev-team …' to contain 'replaying turn 1'
```
→ 帧里**确实没有** "replaying turn 1"：`startTurn` 首句同步 `setNotice(undefined)` 把先写的 notice 冲掉。**注释所述机制属实。**

**再证"无测试锁"**：在对调状态下跑**全部** `App.run.test.tsx`：

```
$ pnpm exec vitest run src/tui/App.run.test.tsx   # EXIT 0
 Test Files  1 passed (1)
      Tests  31 passed (31)
```
→ **31/31 全绿。** 现有用例只断言 `prompts`（leader 收到的 requirement）、`starts`（轮次计数）与错误文案（`no turn 99` / `nothing to replay yet`），**无一条断言 `replaying turn N`**。故顺序被改回去时**没有任何测试会红**——注释里那条"必须写在之后"的契约无人看守。

**影响**：计划 §2.2 只要求"写进注释"，未要求用例，所以这不是违约；但一次无害的重排（如未来把两行合并进一个 helper）会**静默**丢掉回放提示。建议补一行 `expect(frame).toContain("replaying turn 1")`（今日已证其会绿）。

---

## 2. 探针 2 —— 面板开窗端到端：回车跑的是**高亮那一条**吗？

**结论：行为正确；但既有用例只验了高亮，没验"跑的是谁"（P3）。**

**自写探针**（`/` 打开面板 → 连按 7 次 `↓` → 回车）：

```
✓ runs /fork, not /replay, when the highlight is seven rows down
```
断言 `frame` 含 `nothing to fork yet`，且**不含** `nothing to replay yet`。

推理链（已核代码）：idle 下 `matches = availableCommands(false)` 共 **10** 条，下标 7 = `/fork`。`App.tsx:746` 回车走 `runCommand(matches[selected].name, [])`，`selected = menuIndex`（**绝对**下标）。`paletteSelected = selected - windowStart` 只传给渲染。若某次重构把回车错改成 `allRows[paletteSelected]`（相对下标 6 = `/replay`），本探针会读出 `nothing to replay yet` 而变红——**该探针能区分正确与"相对/绝对错位"**。

**但既有用例做不到**：`App.run.test.tsx:1194` "follows the selection past the first window" 只断言：

```
expect(frame).toContain("› /fork")
```
它证明的是**高亮**落在 `/fork`，**不证明回车跑的是 `/fork`**。组件级 `components.test.tsx:788` 也仅验"caret 落在给定窗口的相对下标行"。二者合起来覆盖了"画对"，未覆盖"跑对"。

**影响**：功能正确（我的探针已证），但既有用例对"回车路由到错误列表"这类回归是盲的。建议把探针 2 的断言并入 `App.run.test.tsx`。

---

## 3. 探针 3 —— T9 真·重启往返

**结论：通过。**

自写探针（临时 `workDir`，同一 `workDir` 跨两次 `render`）：

```
✓ lists a turn from the previous session and continues its numbering
```
- 第一次渲染：键入 `remember me` + 回车，跑到 `orchestration:complete`；
- 落盘文件 `history.json` 实测为 `[{turn:1, phase:"complete", requirement:"remember me", …}]`（长度 1）；
- **卸载后**第二次渲染（无任何内存态共享），键入 `/history` + 回车 → 帧含 `remember me` 且含 `1 earlier`。

**编号续接**：`createInitialState(config, history)` 取 `history.at(-1).turn` 续号，`state.test.ts:767` "continues the turn number from restored history" 已覆盖。

**被取消的轮次**：`state.test.ts:1173` "keeps a cancelled turn in history but out of the conversation" 直接建模——取消的轮次 `phase` 仍为 `running`，留在 `history`（`/history` 可见），但被 `conversationTurns` 的 `phase === "complete"` 过滤剔除。与计划 §1.3 一致，**通过**。

---

## 4. 探针 4 —— `turn:start` 守卫（`requirement` vs `turn > 0`）

**结论：新守卫被测试锁住；反方向无法证伪。**

**回退实跑**：把 `state.ts:600` 的 `state.requirement !== undefined` 改回 `state.turn > 0`：

```
$ pnpm exec vitest run src/tui/state.test.ts   # EXIT 1
× does not invent a turn when history is restored but nothing is running
      Tests  1 failed | 117 passed (118)
```
**恰好一条**变红——正是计划 §1.5 指定的回归用例。守卫被锁，**通过**。

**反方向证伪尝试**（"屏幕上有轮次但 `requirement` 未设"）：审计 `state.ts` 中 `requirement` 的**全部**写入点——
- `:607` `turn:start` 写 `action.requirement`；
- `:328` `orchestration:start` 写 `event.payload.requirement ?? state.requirement`（**保留**既有值）；
- `:493` `snapshot` 原样携带。

**没有任何事件会把 `requirement` 清空**，`turn:start` 又必与 `turn` 同写。故 `turn > 0 && requirement === undefined` 的**唯一**可达状态就是 `createInitialState(config, history)` 造出的"从盘续号、无在跑轮次"的 idle 态——正是守卫要放过的那种。**无法构造**"真有轮次在屏、`requirement` 却未设"的合法状态 ⇒ 反方向证伪失败 ⇒ 守卫在两方向都成立。

（唯一理论缝隙：若未来出现**不经 `turn:start` 就起编排**的路径，守卫会把上一轮静默丢弃。今日不可达，记为设计注意点，非缺陷。）

---

## 5. 探针 5 —— `isTurnView` 的崩溃路径与**未覆盖**的形状

**结论：注释的强断言被证伪（P3）。**

`history.ts:27` 的五字段校验：`typeof turn === number`、`phase === string`、`agents` 为非 null object、`stages` 为数组、`leaderIds` 为数组。**只验外层形状，不验内层元素。**

**已证崩溃路径**（`loadHistory` 通过 → 渲染抛 `TypeError`）：

| 磁盘内容 | `isTurnView` | 首个崩溃点 | 实测 |
|---|---|---|---|
| `agents:{a:null}` | **接受** | `progress()`（`state.ts:708` `Object.values(...).filter(a => SETTLED.has(a.status))` → `null.status`） | `expect(() => progress(loaded[0])).toThrow(TypeError)` ✓ |
| `agents:{a:"str"}` | **接受** | `WelcomePanel`（`panels.tsx:307` `a.name.length`） | 已构造接受，`progress()` 不抛（`a.status` 为 undefined） |
| `stages:[null]` | **接受** | `railCellWidths`（`chrome.tsx:83` `for (const agent of stage.agents)` → `null.agents`） | `expect(() => railCellWidths(loaded[0])).toThrow(TypeError)` ✓ |

`progress()` 由 `HistoryOverlay`（`overlays.tsx:196`）对**列表中每一轮**调用，所以 `agents:{a:null}` 会让 `/history` 直接崩；`railCellWidths` 由 `App.tsx:634` 的 `computeLayout` **每次渲染**调用，所以打开 `stages:[null]` 的轮次（`/history` 回车）会在布局阶段崩。

**注释原文**："Not exhaustive … But it **must reject anything that would throw while rendering**."——**后半句被上述三例证伪**：它明确接受会抛的输入。

**可达性（低）**：`saveHistory` 是 tmp+rename **原子写**且总写完整 `TurnView`，正常写入不会产生这种文件；只有**手改/损坏**的文件才触发。故为 **P3**（防御缺口 + 注释夸大），非 P0-P2。建议二选一：收紧注释（"只保证外层形状，内层不校验"），或把校验下沉一层（`agents` 的每个值须为对象、`stages` 的每个元素须为对象）。

---

## 6. 探针 6 —— 套件连跑两遍

**结论：通过。**

```
$ cd packages/dashboard && pnpm test   # 第 1 遍（EXIT 0）：Test Files 10 passed | Tests 380 passed
$ cd packages/dashboard && pnpm test   # 第 2 遍，不清任何东西（EXIT 0）：Tests 380 passed
```
T9 会往固定 `/tmp/multiclaw-tui-*` 工作区写盘；`App.run.test.tsx` 末尾的 `beforeEach`（`App.run.test.tsx:1314`）对 12 个 config 统一清 `.multiclaw/console`，第二遍仍全绿 ⇒ **磁盘残留不会污染**。**通过**。

---

## 7. 探针 7 —— idle 下 `/cancel` 的新文案可达

**结论：通过。**

自写探针（`/cancel` + 回车，无在跑轮次）：

```
✓ tells the user the command only applies to a running turn
```
帧含 `/cancel only applies while a turn is running`。路径已核：`runCommand` 先过 `canRun("cancel", false)`（`commands.ts:96`，`cancel` 的 availability 为 `running`）→ false → `setNotice(unavailableReason("cancel", false))` → 返回该文案。单元层 `commands.test.ts:72` 亦断言同一字符串。

**另注**：`App.tsx:495` 的 `nothing to cancel` 分支（`running` 为真但 `abortRef.current` 为空）在正常流程下**不可达**（起轮次即设 `abortRef.current`），且无任何测试断言它——计划 §2.4 已"顺带核实"并接受，**非新增问题**。

---

## 8. 计划 §6 要求的回退证据（逐条实跑）

| # | 回退动作 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| A | `recordedTurns` → `return [...state.history]`（丢掉刚结束的当前轮） | 变红 | `state.test.ts`+`App.history.test.tsx` **6 failed**，含 `writes a finished turn to disk so the next session can restore it` | ✓ 与 §1.5 一致 |
| B | `/replay` 的 `void startTurn(...)` 去掉（只留 `setNotice`） | 前两条用例变红 | `App.run.test.tsx` **2 failed**：`replays the last finished turn by default`、`replays the turn named by number` | ✓ 与 §2.3 逐字一致 |
| C | 去掉 `runCommand` 的 `canRun` 守卫 | 该用例变红 | `App.run.test.tsx` **1 failed**：`refuses an idle-only command while a turn is running` | ✓ 与 §2.4 一致 |

三条回退全部**精确命中**计划声明的用例，还原后 `git status --porcelain` 为空。

---

## 9. 问题清单

| 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **P3** | `App.tsx:471-476`（`/replay`） | notice 顺序坑**真实**（对调后提示丢失，已复现），但**无测试锁**（对调后 `App.run.test.tsx` 31/31 仍绿）。重排会静默丢提示。 | 补 `expect(frame).toContain("replaying turn 1")`。 |
| **P3** | `history.ts:27-38`（`isTurnView`） | 注释 "must reject anything that would throw while rendering" **被证伪**：接受 `agents:{a:null}`（`progress()` 抛）、`agents:{a:"str"}`（`WelcomePanel` 抛）、`stages:[null]`（`railCellWidths` 抛）。可达性低（原子写+完整对象，仅手改文件触发）。 | 收紧注释，或将校验下沉到 `agents[*]`/`stages[*]`。 |
| **P3** | `App.run.test.tsx:1194` | "follows the selection past the first window" 只断言高亮 `› /fork`，**不验回车跑的是 `/fork`**；回车路由错位不会被捕获。 | 并入探针 2 的"回车后断言 `nothing to fork yet`"。 |

**无 P0/P1/P2。** 全部功能正确、门禁达标、回退证据齐全。

---

## 10. 覆盖到的与**未**覆盖到的（诚实边界）

- **已独立验证**：`pnpm verify` 全绿；dashboard 覆盖率达标；探针 1-7；回退 A/B/C；重启往返；被取消轮次的 history/conversation 分野。
- **未独立验证（信任既有测试，未重跑其内部逻辑）**：`helpRows(true) ≤ 19` 的行预算算术（`components.test.tsx` 既有用例覆盖）；`listWindowStart` 的三组边界（既有用例覆盖）；`resolveAgentId` 的 `ambiguous`/`unknown`（`commands.test.ts` 覆盖）。
- **探针文件均已删除**；最终 `git status --porcelain` 为空，源码与 HEAD `9a17bff` 逐字一致。
