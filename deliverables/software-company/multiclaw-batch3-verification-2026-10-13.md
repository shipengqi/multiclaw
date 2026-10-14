# multiclaw Batch 3「续跑」独立验证报告

- **QA**：严过关（Yan）
- **日期**：2026-10-13
- **仓库**：`/Users/C5406922/code/multiclaw`（HEAD `5df4c5e`，Batch 1/2/3 改动均未提交）
- **被验证对象**：工程师寇豆码的 Batch 3 交付（core / cli / dashboard）
- **验证立场**：证伪优先。工程师自称「全绿、IS_PASS: YES」，本报告独立复现，不盖章。
- **设计依据**：`deliverables/software-company/multiclaw-batch3-plan-2026-10-13.md`

---

## 0. 总判定

# 判定：**PASS WITH ISSUES**

- **无 P0**：未发现源码 bug。所有质量门禁全绿，`--resume` / `/retry` 的**可观察行为**经独立端到端构造后全部符合设计。
- **1 条 P1**：`packages/cli/src/commands/run.ts`（`--resume` 的接线层）**测试覆盖率为 0%**，而它承载本批的关键不变量「不覆盖原 `report.json`」。行为经我用临时测试实测正确，但**没有随仓测试保护**——未来重构可静默破坏它。工程师给出的「`run.ts` 被排除在覆盖率外」的**理由不成立**（被排除的是 `index.ts`/`lib.ts`，`run.ts` 是被计量的）。
- **若干 P2**：见 §遗留问题清单。均为可读性/精确性/一致性，非缺陷。

### 遗留问题清单

| 级别 | 问题 | 位置 | 影响 |
|---|---|---|---|
| **P1** | `run.ts` 覆盖率 0%（`--resume` 接线无测试） | `packages/cli/src/commands/run.ts` | 「续跑不覆盖原 report.json」这一关键不变量无回归保护 |
| P2 | 「不设 resume 时逐字节一致」表述不精确 | 报告/计划 §3 | 当 `config.context.requirement` 有值时，`report.json` **新增** `requirement` 字段（B3-3 设计如此，additive 且安全，但字面不符） |
| P2 | resume 分支下未知 id 告警仍称「The leader named …」 | `Orchestrator.ts:318`（`selectAgents` 复用） | resume 时并无 leader 参与，文案误导 |
| P2 | `ResumeTarget` 导出但零消费方 | `cli/src/commands/resume.ts:6` | 死导出；**未**泄露为公开 API（`lib.ts`/`index.ts`/`package.json exports` 均未再导出） |
| P2 | `typeof target !== "string"` 使 `false` 被当作 `latest` | `resume.ts:26` | commander 永不产生 `false`（已实测），故不可达；建议类型收窄为 `string \| true` |
| P2 | dashboard `/retry` 传 `sessions: undefined`（键在、值为 undefined） | `App.tsx:367` | 与 core 的 `?.` 语义等价、功能正确；但 CLI 侧 `resume.ts` 是**省略键**，两处风格不一致 |

### 工程师上报的 3 处偏离判定

| # | 偏离 | 判定 | 依据 |
|---|---|---|---|
| 1 | `runCommand` 的 deps 加 `startTurn` | **合法** | 实测：删掉后 `pnpm lint` 报 4 个 `useExhaustiveDependencies` 错误并给出「Add the missing dependency startTurn」；恢复后 lint 全绿。加回后无行为变化（`startTurn` 仅随 `config/flush/onTurnStart` 变化，而 `state` 已是 dep、每事件都重建） |
| 2 | `resolveRunDir` 判定改 `typeof target !== "string"` | **合法** | 实测 commander `--resume`（无值）产出 `true`，绝不产出 `false`；故对可达输入语义**完全等价**。`false` 不可达 |
| 3 | `ResumeTarget` 导出无消费方 | **可接受** | 全仓仅此一处声明；`lib.ts`/`index.ts`/`package.json exports` 均未再导出 → 非公开面 |

---

## 1. 方法与「改动前」基线的界定

工作区同时含 Batch 1/2/3 的未提交改动，`git stash` 无法单独回退 Batch 3。故采用：

1. **逐行读 `git diff`**，从混合 diff 中**人工切出 Batch 3 的增量**（`resume` / `sessionId` / `requirement` 相关），确认其余为 Batch 1/2（`planApplied`/`isPlanner`/`totalCostUsd`/`onWarning`/`kind`/`cancelled`/`getModel`）。
2. **独立构造断言**（不复用工程师用例），断言「改动前基线」的形状。
3. **两次受控实验**（临时改源码 → 观察变红 → 立即恢复），隔离 Batch 3 增量的因果。

> 「改动前」在本报告中指 **Batch 3 之前**（即 Batch 1/2 之后的基线）。

### Batch 3 的增量（读 diff 切出，逐文件）

- `types/agent.ts`：`AgentResult.sessionId?: string`
- `types/config.ts`：`MultiClawConfig.resume?`、`OrchestratorResult.requirement?`
- `orchestrator/AgentRunner.ts`：`sessionId: this.config.resume?.sessions?.[agent.id]`；成功路径 `...(sessionId ? { sessionId } : {})`
- `orchestrator/Orchestrator.ts`：`resolveTurn()` 在 leader 分支**之前**加 `if (this.config.resume) return { kind:"run", agents: this.selectAgents(this.config.resume.agents) }`；新增 `requirementField()`，在 `run()`/`finishWithMessage()`/`finishEmpty()` 三处展开
- `cli/commands/resume.ts`（新）、`cli/commands/run.ts`、`cli/index.ts`
- `dashboard/tui/state.ts`（`AgentView.sessionId`）、`commands.ts`（`retry`）、`App.tsx`（`startTurn(opts)` / `case "retry"`）
- **未改**：`AcpRuntime.ts`（其 diff 全部为 Batch 2：`onWarning`/`models` 能力/`errorMessage`）

---

## 2. V1（最高优先级）「不设 `resume` 行为不变」的独立证伪

### V1.1 逐行审 `resolveTurn` / `AgentRunner`

【验证方法】读 `Orchestrator.ts` / `AgentRunner.ts` 的完整 `git diff`，判断 leader 分支是否被重构、`requirementField()` 是否影响既有字段集合。

【实际结果】
- `resolveTurn` 的 leader 分支**未重构**，Batch 3 只是在其**之前**插入一个 `if (this.config.resume)` 守卫（严格守卫，无 else、无副作用）。
- `AgentRunner` 的 `sessionId` 只在 `runtime.execute` 入参和成功路径结果里出现；失败路径（catch）**不含** `sessionId`。
- `requirementField()` 是纯函数，只返回 `{}` 或 `{ requirement }`。

【结论】**守卫是严格且局部的**；Batch 3 在非 resume 路径上的唯一增量就是 `requirementField()` 的三处展开。

### V1.2 独立构造：无 `resume`（有 leader）时 `OrchestratorResult` 键集合与顺序

【验证方法】写独立测试（`batch3-verify.test.ts`，13 例，验后已删），对 `run()` / `finishEmpty()` / `finishWithMessage()` 三条出口断言 `Object.keys(result)` 的**精确数组**（含顺序）与 `"requirement" in result`。

【实际结果】
```
✓ V1.2 result key set AND order are unchanged when context has no requirement
    keys === ["name","success","totalDuration","agentResults","startTime","endTime"]
    "requirement" in result === false ；"totalCostUsd" in result === false
✓ V1.2 finishEmpty key order is unchanged
✓ V1.2 finishWithMessage key order is unchanged（末尾为 "reply"）
✓ V1.2 requirement appears (intended) only when context.requirement is set
    → result.requirement === "do it"；Object.keys(result).at(-1) === "requirement"
Tests  13 passed (13)
```

【结论】
- **未设 `context.requirement` 时**：键集合、**键顺序**均与基线一致（`requirement` 追加在**末尾**，不移动任何既有键 → 不改变 `JSON.stringify` 的既有字段顺序）。`"requirement" in result === false` 成立。✅
- **设了 `context.requirement` 时**：`requirement` 出现（B3-3 的**预期**新增）。⚠️ 见 §5 P2。

### V1.3 `AgentRunner` 在无 `resume` 时传给 runtime 的 `task.sessionId` 必须是 `undefined`

【验证方法】独立断言（不复用工程师用例）：捕获 `AgentTask`，断言 `task.sessionId` **严格等于 `undefined`**、`!== ""`、`!== null`。

【实际结果】
```
✓ V1.3 no resume ⇒ task.sessionId is strictly undefined (not '' / null)
✓ V1.3 resume with an unknown agent ⇒ sessionId still undefined
```

【结论】`sessionId` 为 `undefined`，非 `""`、非 `null`。✅（注释里「`""` 会被 `if (task.sessionId)` 误读」的推理与 `AcpRuntime.ts:558` 的 `if (task.sessionId)` 一致。）

### V1.4 字段顺序回归

【验证方法】`report.json` 由 `FileLogWriter` 对 `orchestration:complete` payload 做 `JSON.stringify(payload, null, 2)`（`FileLogWriter.ts:53`）。因此字段顺序变化=字节变化。

【实际结果】Batch 3 只在结果字面量**末尾**追加 `...this.requirementField()`（`Orchestrator.ts:191/445/487`），既有键顺序不变。V1.2 的顺序断言已覆盖。

【结论】无既有字段顺序回归。✅

### V1.5 「改动前 vs 改动后」同用例对比（无法 stash → 代码推导 + 受控实验）

【验证方法】两次受控实验（临时改源码、验后恢复，见 §6 恢复记录）：
- **实验 A**：把 `if (this.config.resume)` 临时改为 `if (false && this.config.resume)`。
- **实验 B**：临时移除三处 `...this.requirementField()`。

【实际结果】
- 实验 A（禁用守卫）：`6 failed | 7 passed` —— **全部 V2 用例变红**（resume 失效），**全部 V1 用例仍绿**。→ 守卫是 resume 的**唯一开关**，且对非 resume 路径**零影响**。
- 实验 B（移除 requirementField）：`1 failed | 12 passed` —— **只有**「requirement 出现」变红，其余（含全部键顺序断言、全部 V2）仍绿。→ `requirementField()` 是 `requirement` 字段的**唯一来源**，且不触碰任何其它键。

【结论】**「不设 resume ⇒ 路由/执行与结果形状不变」成立**（在 `context.requirement` 未设的前提下逐字节一致）。**唯一的非 resume 增量**是「当 requirement 有值时给 `report.json` 加一个 `requirement` 字段」——这是 B3-3 的**刻意设计**、additive、无既有消费者读取，因此**对既有用户安全**；但「逐字节一致」的表述**不精确**（见 P2）。

---

## 3. V2 `resume` 分支语义

【验证方法】独立 fake runtime（计数/捕获），不复用工程师用例。

【实际结果】（全部通过，13 例中的 V2 部分）
```
✓ V2.1 the leader is never called when resume is set（leaderCalls === 0）
✓ V2.2 only the named agents run（startedIds === ["dev"]）
✓ V2.3 unknown id warned+dropped；all-unknown ⇒ finishEmpty（success:false, agentResults:[]）
✓ V2.4 non-selected agents receive agent:skipped（["architect"]）
✓ V2.5 resumed agent's out-of-set dependency pruned（无 "declaration order"/"Could not order" 告警；dev 单独处于 stage 0）
✓ V2.6 a session id is threaded to the runtime under resume（task.sessionId === "sess-9"）
```

【关键点】V2.5 独立证明：`resume.agents=["dev"]` 且 dev 原 `dependsOn:["architect"]` 时，dev 的依赖已被剔除（`buildStages` 未抛错、未降级为声明顺序、dev 独占 stage 0）。这正是 `selectAgents` 被**复用**（而非另写逻辑）的直接证据——V2.4 的 `agent:skipped` 与 V2.5 的裁剪同源。

【结论】V2 全部符合设计。✅

---

## 4. V3 `--resume` CLI 逻辑（重点：不覆盖原记录）

> **前提事实**：`run.ts` 在本批**没有随仓单测**，且它**并未**被覆盖率排除（被排除的是 `index.ts`/`lib.ts`）。干净覆盖率下 `run.ts` = **0%**（见 V8）。以下 V3 结论来自：真实文件系统调用 `resume.ts` 的三个纯函数 + 一个**mock 依赖的 `runCommand` 端到端**（临时测试 `batch3-verify.test.ts`，15 例，验后已删）。

【验证方法】`mkdtempSync` 造真实目录；对 `runCommand` 用 `vi.mock` 替换 `loadConfig`/`Orchestrator`/reporters，**真实执行**续跑分支并捕获传入 `Orchestrator` 的 config。

【实际结果】
```
✓ V3.2 latest 选到 lexicographic 最大值（名字最大者），不是创建最晚者，也不是最旧
✓ V3.4 空 runsRoot 报错含路径；report.json 缺失/坏 JSON 报错可读
✓ V3.5 override 优先 > report.requirement > 两者皆无抛错（三条都验）
✓ V3.6 全员无 sessionId ⇒ "sessions" in resume === false（不是 {}）；有则只收有 sessionId 的
✓ V3.3 续跑写 logs-resume-<stamp>，NEVER 原 logs/
     实测 stdout：Logs: <runDir>/logs-resume-2026-10-13T05-33-34
     断言：config.logDir !== <runDir>/logs ；config.workDir === runDir ；原 report.json 内容不变
✓ V3.7 非续跑分支 config.logDir 保持 undefined（`logDir = config.logDir ?? <runDir>/logs` 是**读**不是**写**）
Tests  15 passed (15)
```

【关键点 1｜不覆盖原 report.json】`run.ts:45` 置 `config.logDir = path.join(runDir, \`logs-resume-${stamp}\`)`；`run.ts:57` 是 `const logDir = config.logDir ?? path.join(config.workDir, "logs")`——**只读**。我**端到端实测**了续跑分支：日志目录落在 `logs-resume-<stamp>`，与原 `logs/` 不同；原 `report.json` 仍可原样读回。✅（这是我用真实 `runCommand` 执行 + mock 依赖完成的，非纯推导。）

【关键点 2｜`latest` 语义】stamp 为定宽 ISO，字典序=时间序；我的用例刻意让「创建最晚」与「名字最大」分离，证明取的是**名字最大**（时间最新），而非目录创建顺序。✅

【结论】V3 逻辑正确。⚠️ 但**无随仓测试**（P1）。

---

## 5. V4 dashboard `/retry` 语义

【验证方法】`availableCommands` 单测 + 三个端到端 frame 测试（临时 `batch3-verify.test.tsx`，5 例，验后已删），运行时捕获 `AgentTask` 与 `orchestration:complete` 次数。

【实际结果】
```
✓ V4.1 availability:"idle" → running 时不在 availableCommands(true)，idle 时在 availableCommands(false)
✓ V4.3 混合状态 turn（architect=success、dev=failed、qa=skipped）→ 无参 /retry 只重跑 dev
       runs === ["leader","architect","dev","dev"]；qa 从不出现；completes === 2
✓ V4.4 有参 /retry architect（该 agent 已成功且有 sessionId）→ 新 task.sessionId === "s-arch"
       捕获：sessArchSessions === [undefined, "s-arch"]
✓ V4.5 未知 id /retry nope → notice "unknown agent"；completes === 1（不触发新 turn）
✓ V4.6 失败 agent 无 sessionId → 重跑时 task.sessionId === undefined（未伪造 {dev: undefined}）
```

【逐项对照 team-lead 要求】
- **作用于 `state` 而非 `shown`**：读码确认 `case "retry"` 读的是 `state.phase` / `state.requirement` / `state.agents`（`TuiState` 自身字段），**未**读 `state.view ?? state`。回看旧轮次时 `state.view` 才被设置，retry 不受其影响。✅
- **无参只收 `failed`**：`filter(a => a.status === "failed")`，V4.3 用 success/failed/skipped 混合轮次实测，skipped 被排除。✅
- **未知 id → notice 且不触发新 turn**：V4.5 实测。✅
- **全无失败 → `nothing failed`**：工程师用例覆盖（`App.run.test.tsx` "says there is nothing to retry…"），我另核对了代码分支。✅
- **`sessionId` 缺失不伪造**：V4.6 实测 `undefined`。⚠️ 细节见 P2（键在、值为 `undefined`）。✅
- **`phase !== "complete"` 或无 requirement → notice**：读码确认（`if (state.phase !== "complete" || !state.requirement) { setNotice("nothing to retry yet"); return }`）。✅

【结论】V4 语义正确。✅

---

## 6. V5 `snapshot()` / 历史轮次不丢字段

【验证方法】独立 reducer 测试：`agent:complete`(带 sessionId) → `turn:start` 把该轮顶入 `history` → 断言 `history[last].agents.a.sessionId` 仍在。

【实际结果】
```
✓ V5 the session id is still there after the turn is pushed into history（history[last].agents.a.sessionId === "sess-x"）
```

`snapshot()` **确实未为 Batch 3 改动**：`git diff` 该函数只显示 Batch 2 的 `totalCostUsd` 一行（`state.ts:488`），无 `sessionId` 相关改动——因为 `agents` 是整体带过的，`sessionId` 随 `AgentView` 自然保留。✅

【结论】无字段丢失；工程师未多做事。✅

---

## 7. V7 防橡皮图章：测试是否被削弱

【验证方法】`git diff --numstat` 全部测试文件 + 全仓 skip/todo/only 检索 + 逐条核对被删断言。

【实际结果】
- **skip/todo/only 全仓 0 命中**（`\b(it|describe|test|context)\.(skip|todo|only)\b|\bxit\(|\bxdescribe\(` → No matches）。✅
- 有删除行的测试文件仅 3 个，全部**非放宽**：
  - `AgentRunner.test.ts`：`makeRunner = () =>` → `(overrides = {})`（**新增默认参数**，所有既有 `makeRunner()` 调用等价）；「忽略非文本事件」旧用例被**更强的**新用例取代（旧断言 `toEqual([...2 项])` → 新断言 `toHaveLength(5)` + 逐项 `kind`）。前者为 Batch 2，后者含 Batch 3 的 sessionId 用例（`"sessionId" in result === false` 等）。
  - `commands.test.ts`：`always offers the rest` 清单**加 `"verbose"`**（Batch 2）；Batch 3 **未动该清单**，另加独立用例 `offers /retry while idle but not while a turn is running`，**两条都断言**（idle `toContain` + running `not.toContain`）。✅
  - `components.test.tsx`：仅 import 行增 `ErrorPanel`（Batch 2）。
- `App.run.test.tsx` 的 `expected 2 to be 1` 断言**语义正确**：`expect(leaderRuns).toBe(1)` 断言「leader 只在第 1 轮规划过，重试轮未再调用 leader」（实验 A 已证明该断言有区分度：禁用守卫后 leaderRuns=2 → 变红）。✅

【结论】无断言被删除/放宽/跳过。✅

---

## 8. V8 全量质量门禁

【验证方法】先 `pnpm -r build`（dashboard 测的是 core 的 **dist**，必须先构建），再跑 `pnpm verify` 与 `pnpm test:coverage`。**先删除我的全部临时测试文件**，保证数字是「随仓测试」的真实值。

【实际结果】
```
pnpm lint        → EXIT=0 ；Checked 123 files in 71ms. No fixes applied.
pnpm -r build    → EXIT=0
pnpm -r typecheck→ EXIT=0
pnpm verify      → EXIT=0
  core      : Test Files 21 passed (21) ；Tests 320 passed (320)
  dashboard : Test Files  8 passed (8)  ；Tests 318 passed (318)
  cli       : Test Files  8 passed (8)  ；Tests  79 passed (79)
```

覆盖率（干净，无我的临时文件）：

| 包 | Stmts | Branch | Funcs | Lines | 阈值 | 结果 |
|---|---|---|---|---|---|---|
| core | 97.03 | 92.42 | 94.7 | 97.96 | 90/85/90/90 | ✅ |
| dashboard | 99.36 | 96.26 | 100 | 99.61 | 90/85/90/90 | ✅ |
| cli | 68.51 | 67.09 | 74.19 | 68.54 | 50/45/40/50 | ✅ |

`pnpm test:coverage` EXIT=0（阈值在 `vitest.config.ts` 中显式配置且生效，非空跑）。

【关注点】
- `resume.ts`：**100 / 92.3 / 100 / 100**（工程师的 `resume.test.ts` 17 例覆盖充分）。✅
- `run.ts`：**0 / 0 / 0 / 0**（行 17–79）——`--resume` 的接线层**零覆盖**。⚠️ P1。
- 工程师称「`run.ts` 因 `index.ts`/`lib.ts` 被排除而无单测」：**排除项里没有 `run.ts`**，它被计量且为 0%。理由不成立。
- 未以「与本次改动无关」放过任何失败：本次无任何失败。

【结论】门禁全绿，覆盖率不破线；但 `run.ts` 0% 是本批最大测试盲区。

---

## 9. V6 三处偏离的独立判定

### V6.1 deps 数组加 `startTurn`

【验证方法】临时把 `App.tsx:398` 的 `[config, exit, queue.length, state, startTurn]` 改为 `[config, exit, queue.length, state]`，跑 `pnpm lint`，随后恢复。

【实际结果】lint 报 **4 errors**，含：
```
lint/correctness/useExhaustiveDependencies
> 364 │  void startTurn(state.requirement, {
i This dependency is being used here, but is not specified in the hook dependency list.
i Unsafe fix: Add the missing dependency startTurn to the list.
```
恢复后 `pnpm lint` 全绿（EXIT=0）。**行为论证**：`startTurn = useCallback(..., [config, flush, onTurnStart])`，而 `runCommand` 的 deps 已含 `state`（每个事件都变），故 `runCommand` 本就频繁重建；加入 `startTurn` 只使闭包更正确，不引入可观察行为变化。

【结论】**合法**。✅

### V6.2 `resolveRunDir` 判定改为 `typeof target !== "string"`

【验证方法】写 commander 脚本实测 `--resume` 各形态的实际取值（在 cli 包内运行以解析到 commander）。

【实际结果】
```
argv: ["run","do it"]                  → resume: undefined
argv: ["run","do it","--resume"]       → resume: true   (boolean)   ← 不是 ""
argv: ["run","do it","--resume","latest"] → resume: "latest"
argv: ["run","do it","--resume","/some/path"] → resume: "/some/path"
argv: ["run"]                          → resume: undefined
```

【分析】commander 对可选值选项**只产出 `undefined` / `true` / `string`**，**绝不产出 `false`**。故：
- `target===true` 与 `typeof target!=="string"` 对所有**可达**输入**语义等价**；
- `false` **不可达**（调用方 `options.resume !== undefined` 守卫 + commander 行为共同排除）。
- 附带：即便有人程序化传 `false`，新代码把它当 `latest`（旧代码会在 `path.resolve(false)` 抛 TypeError）——更健壮，非回归。

【结论】**合法**，语义等价。建议（P2）：`RunOptions.resume` 收窄为 `string | true` 以消除「`false` 可达」的假象。✅

### V6.3 `ResumeTarget` 导出但无消费方

【验证方法】全仓检索 `ResumeTarget` + 检查 `cli/package.json` `exports`、`lib.ts`、`index.ts`。

【实际结果】`ResumeTarget` 全仓**仅 1 处**（`resume.ts:6` 声明）。`package.json` 的 `exports` 只暴露 `"."` → `./dist/lib.js`；`lib.ts` 与 `index.ts` 均**未**再导出它。

【结论】**可接受**（非公开 API 泄露）；仅是不必要的死导出（P2）。✅

---

## 10. V9 端到端可行性复核（读码）

【验证方法】读 `AcpRuntime.ts` 与其 `git diff`；检索 cursor/opencode 的续跑声明。

【实际结果】
- `AgentTask.sessionId` → `AcpRuntime.ts:558` 的 `if (task.sessionId) { … session.load … }`：`task.sessionId` 有值即走，**可达**。✅
- `AcpRuntime.ts:563` 的 `if (init.agentCapabilities?.loadSession !== true) throw` 守卫**仍在**，且是 `git diff` 的**上下文行（未改）**。本批**未放宽**它。✅
- `AcpRuntime.ts` 的 `git diff` **不含任何 Batch 3 改动**（全部为 Batch 2 的 `onWarning`/`models` 能力/`errorMessage`）。✅
- 全仓无任何「cursor/opencode 支持续跑」的声明（仅 provider catalog/detect/bridge 的元数据）；计划 §0/§4 明确标注二者「未验证」。✅

【结论】续跑路径在 claude/codex 下可达且守卫未被放宽；cursor/opencode 保持「未验证」。✅

---

## 11. 临时改动与恢复记录（合规声明）

**未 commit、未修改任何随仓源码的最终状态。** 以下临时改动均**立即恢复**并已验证：

| 临时改动 | 文件 | 何时恢复 | 如何确认恢复 |
|---|---|---|---|
| deps 去掉 `startTurn` | `dashboard/src/tui/App.tsx:398` | 实验后立即 | 该行回到 `[config, exit, queue.length, state, startTurn]`；`pnpm lint` EXIT=0 |
| 守卫 `if (this.config.resume)` → `if (false && …)` | `core/.../Orchestrator.ts:249` | 实验 A 后立即 | grep 无 `false && this.config.resume`；13/13 测试复绿 |
| 三处 `...this.requirementField()` → 注释 | `core/.../Orchestrator.ts:191/445/487` | 实验 B 后立即 | grep 三处展开齐全；无 `QA-EXPERIMENT-B` 残留；13/13 复绿 |
| 新增 3 个临时测试文件 | `*/batch3-verify.test.*` | 全部实验后 | 已删除；`git status` 与初始一致；lint 计数回到 123 |

**最终一致性证据**：`git status --short` 与验证开始时的清单**逐行一致**（30 个 ` M` + 9 个 `??`，无 `batch3-verify`）；`pnpm verify` EXIT=0。

---

## 12. 附：本次独立构造的测试规模

临时测试（验后已删，非交付物）：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `core/src/orchestrator/batch3-verify.test.ts` | 13 | V1、V2 |
| `cli/src/commands/batch3-verify.test.ts` | 15 | V3 |
| `dashboard/src/tui/batch3-verify.test.tsx` | 5 | V4、V5 |
| **合计** | **33** | 全部通过 |

结论：**33/33 独立用例通过**，与工程师用例互相印证；未发现源码 bug。

---

## 13. Round 2 复核（工程师修复 P1/P2 后）

工程师在收到报告后修复了 P1 与 P2-1/3/4（P2-2 接受措辞更正，无代码改动），并称「源码最终状态未 commit」。**独立复核如下。**

### 13.1 修复内容核对（读源码）

| 项 | 修复 | 独立核对 |
|---|---|---|
| P1 | 新增 `cli/src/commands/run.test.ts`（2 例） | ✅ 存在；覆盖 workDir===runDir、原 report.json 逐字节不变、logDir 落 `logs-resume-*`、非续跑走新 `run-<stamp>` |
| P2-1 | `selectAgents(run, namedBy = "The leader")`；resume 传 `"The resume list"` | ✅ `Orchestrator.ts:316` 签名 + `:325` 用 `${namedBy}`；`resolveTurn` 传 `"The resume list"` |
| P2-3 | App.tsx 省略 `sessions` 键 | ✅ `...(Object.keys(sessions).length > 0 ? { sessions } : {})`，与 `cli/resume.ts` 一致 |
| P2-4 | `RunOptions.resume?: string \| true` | ✅ `run.ts:17` 已收窄，`false` 从类型域移除 |

### 13.2 独立回归（新建临时用例，验后已删）

- core（`batch3-round2.test.ts`，7 例，全绿）：
  - **P2-1**：resume 未知 id 告警含 `"resume list"`、**不含 `"leader"`**；且 leader 路径**仍**说 `"The leader named"`（默认参数未破坏既有行为）。
  - V1.2 键顺序不变、V1.3 `sessionId` 严格 `undefined`、V2.1 leader 零调用、V2.5 依赖裁剪、V2.6 session 透传 —— 全部复绿。
- dashboard（`batch3-round2.test.tsx`，1 例，绿）：混合状态轮次无参 `/retry` 仍只重跑 dev（`runs === ["leader","architect","dev","dev"]`，qa 不出现），失败 agent 的 sessionless 重跑 `task.sessionId === undefined`。

### 13.3 测试削弱复核

`git diff --numstat -- '*test*'`：Round 2 仅 `Orchestrator.run.test.ts` 由 364→**368**（+4 行，新增 `messages.some(m => m.includes("leader")) === false` 断言，**无删除**）；其余测试文件与 Round 1 一致。全仓 `it/describe/test.skip|todo|only|xit|xdescribe` **仍 0 命中**。**无削弱。**

### 13.4 全量门禁（干净，无临时文件）

```
pnpm verify      → EXIT=0
  core      : 21 files / 320 tests passed
  dashboard :  8 files / 318 tests passed
  cli       :  9 files /  81 tests passed   （+2 = run.test.ts）
pnpm test:coverage → EXIT=0
  core      : 97.03 / 92.44 / 94.7 / 97.96   （阈值 90/85/90/90）✅
  dashboard : 99.36 / 96.26 / 100  / 99.61   （阈值 90/85/90/90）✅
  cli       : 76.07 / 70.08 / 75.8 / 76.61   （阈值 50/45/40/50）✅
```

**P1 已闭合**：`run.ts` 覆盖率 **0/0/0/0 → 88.23/58.33/50/90.9**（cli 总计 68.51→76.07）。`resume.ts` 仍 100/92.3/100/100。

### 13.5 Round 2 结论

- **P1 已修复并独立复现**（`run.ts` 覆盖率从 0% 升到 88.23% stmts / 90.9% lines，且新增测试断言了关键不变量）。
- **P2-1/P2-3/P2-4 已修复**，独立回归通过；P2-2 措辞已更正。
- 无新增削弱，无回归，全部门禁 EXIT=0。
- **Round 2 判定：PASS（无 P0/P1；P2 已全部处理）**。临时改动（2 个 round2 测试文件）已删除；`git status` = 39（Round 1 基线）+ 1（`run.test.ts`）= 40，无残留。
