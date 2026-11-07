# multiclaw Batch 2「可观测性」独立验证报告

- 验证人：严过关（Yan）· QA 工程师
- 日期：2026-10-13
- 仓库：`/Users/C5406922/code/multiclaw`（HEAD `5df4c5e`；Batch 1 + Batch 2 改动同在工作区，**未 commit**）
- 验证立场：**证伪**。工程师寇豆码报「全绿、IS_PASS: YES」，并主动上报 2 处既有测试改动——本报告用独立手段复现不变量、用回退实验判定测试是否具区分度、逐字核对测试是否被削弱。
- 独立验证代码：5 个临时测试文件（core×2 / dashboard×2 / cli×1，共 27 例），**跑完已全部删除**；源码临时改动 2 处，**已用备份恢复并核对哈希**（见文末附录）。

---

## 判定：**PASS**（无 P0、无 P1；4 条 P2 观察项，无源码缺陷）

| 项 | 结果 |
|---|---|
| V1 成本字段语义不变量（含「有才存在」/混合/显式 0） | ✅ 通过（回退实验确认测试有区分度） |
| V2 `cancelled` 端到端 | ✅ 通过 |
| V3 既有测试改动合法性 | ✅ **合法**（1 处等价替换 + 1 处合法枚举更新，无削弱） |
| V4 headless stdout / 日志「逐字节不变」 | ✅ 通过（独立构造对比数组完全一致） |
| V5 `onWarning` 通道 + stderr 前缀不变 | ✅ 通过（前缀逐字节一致） |
| V6 TUI 渲染与布局预算 | ✅ 通过（头部恒 1 行、无孤儿 `·`、esc 三语义） |
| V7 `/verbose` 折叠语义 | ✅ 通过（`kind` 缺省 === text） |
| V8 未新增事件 & 破坏性变更 | ✅ 通过（union 无新成员；`"arg"` 仅存于历史 RFC） |
| V9 全量质量门禁 | ✅ 全绿（679 测试、覆盖率全过线、dist 新鲜） |
| V10 工程师「诚实记录」的独立复核 | ✅ **工程师判断有误——该测试具区分度，建议保留** |

**遗留问题：无 P0、无 P1。P2 见文末。**

---

## V1 —— 成本字段的语义不变量（最高优先级）

### 验证方法
独立编写 `packages/core/src/orchestrator/qa-v2-verify.test.ts`（12 例），用真实 `Orchestrator` + 注册 fake runtime 构造场景，**不复用工程师用例**。另做回退实验判定区分度。

### 实际结果
```
$ pnpm exec vitest run src/orchestrator/qa-v2-verify.test.ts
 ✓ ① nobody reports a cost -> totalCostUsd absent (not 0)
 ✓ ② every agent reports -> the sum
 ✓ ③ mixed -> only the reporting agents count; the silent one is not 0
 ✓ ③b explicit zero from one agent is a report, so the total is 0 (not absent)
 ✓ model is resolveModel(): a tier-only agent reports a concrete model
 ✓ model falls through the defaults chain when the agent pins nothing
 ✓ model is NOT the raw agent.model when the agent has none
 ✓ a failing run carries model but no usage/cost
 Tests  12 passed (12)
```

- **①「有才存在」**：全员无 cost → `result.totalCostUsd === undefined` **且** `("totalCostUsd" in result) === false`（对象层面键缺失，非仅值为 undefined）✅
- **②全员有 cost** → 求和（1.2+0.3=1.5）✅
- **③混合**（a=0.4，b/c 不报）→ `0.4`；不报的 agent **未**被当成 0 计入 ✅
- **③b 补充边界（我独立加的最强区分用例）**：a **显式报 `costUsd: 0`**、b 不报 → `totalCostUsd === 0` 且键存在。**这条把「上报了 0」与「没有数据」区分开**——纯求和无从分辨，只有 `reported` 标志能分辨。工程师用例未覆盖此边界，实测源码正确（`sumCosts` 用 `typeof === "number"` 判定）。
- **model 是 `resolveModel()` 结果**：只配 `modelTier: "fast"`（provider claude）的 agent → `model === "haiku"`（tier 链），且 `orchestration:start` 的 stage 也报 `haiku`；只配 `defaults.model` 的 agent → `"sonnet"`（defaults 链）；**均非裸 `agent.model`** ✅
- **失败路径不凭空带 usage/cost**：agent 抛错 → `status:"failed"`、`model` 有值、`usage`/`costUsd` 均 undefined 且键不存在 ✅

### 回退实验（区分度判定）
临时把 `Orchestrator.sumCosts` 的 `return reported ? total : undefined` 改为 `return total`（永远返回数字）：
```
FAIL  > leaves totalCostUsd undefined when nobody reported a cost
AssertionError: expected +0 to be undefined          ← 工程师用例变红
FAIL  > ① nobody reports a cost -> totalCostUsd absent (not 0)
AssertionError: expected +0 to be undefined          ← 我的独立用例变红
```
→ **「undefined 而非 0」这条不变量被真实保护**。随后用备份恢复，`shasum` 一致（见附录）。

---

## V2 —— `cancelled` 状态端到端

### 验证方法
core 侧用 `AbortController` 直接 abort `AgentRunner.run` 与 `Orchestrator.run`；dashboard 侧独立构造单 agent 状态验证 `progress()`；cli 侧验证 `ConsoleReporter` 文案。

### 实际结果
```
core:
 ✓ an aborted run is cancelled, not failed
 ✓ a timeout is still failed, not cancelled        ← 区分 abort 与 timeout
 ✓ Orchestrator marks a cancelled run and does not report success
     （result.cancelled===true、success===false、agentResults[0].status==="cancelled"）

dashboard:
 ✓ progress counts a cancelled agent as done        （{done:1,total:1}）
 ✓ status comes from the result, not the event type

cli:
 ✓ a cancelled agent is never the red failure cross  （含 "Tester cancelled"，不含 "x Tester"）
 ✓ a real failure still uses the red cross           （"x Tester failed: boom"）
 ✓ the summary row marks cancelled apart from failed （"- Tester"，不含 "x Tester"）
```
- **`progress()` 把 cancelled 计入 `done`**：`SETTLED` 已含 `"cancelled"`（`state.ts:638-643`），单 agent abort 后 `progress === {done:1,total:1}`，**轮次不会停在 N-1/N** ✅
- **`ConsoleReporter` 不渲染红色 ✗ failed**：`markFor()` 对 cancelled 返回 `{icon:S.skip, color:yellow}`；`agent:failed` 分支对 `status==="cancelled"` 走 "cancelled" 文案；`orchestration:complete` 头部对 `payload.cancelled` 走 "Cancelled" ✅
- **`snapshot()` 未漏字段**：`state.ts:479` 明确写出 `totalCostUsd: state.totalCostUsd`；历史轮次不丢成本（见 V8 的 snapshot 用例）✅

---

## V3 —— 改动既有测试的合法性判定（重点）

### 验证方法
`git diff --numstat` 列出所有含删除行的文件 + 逐字核对 2 处改动 + 全仓 grep 跳过标记。

### 实际结果

**① 全仓仅 2 个既有测试用例被改动**（其余含删除行的都是源码或 import 行）：
```
$ git diff --numstat | awk '$2>0'
96  18  packages/cli/src/commands/init.ts            ← 源码
32   7  packages/cli/src/reporters/ConsoleReporter.ts ← 源码
 6   1  packages/cli/src/reporters/FileLogWriter.ts   ← 源码
99   8  packages/core/src/orchestrator/AgentRunner.test.ts   ← 既有测试 ①
95  37  packages/core/src/orchestrator/AgentRunner.ts        ← 源码
53   6  packages/core/src/orchestrator/Orchestrator.ts       ← 源码
10   1  packages/core/src/providers/catalog.ts               ← 源码
34   8  packages/core/src/runtime/AcpRuntime.ts              ← 源码
27   1  packages/core/src/types/agent.ts                     ← 源码
17   1  packages/core/src/types/event.ts                     ← 源码
30   2  packages/dashboard/src/tui/App.tsx                   ← 源码
 5   1  packages/dashboard/src/tui/commands.test.ts          ← 既有测试 ②
104  1  packages/dashboard/src/tui/components.test.tsx       ← 仅 import 行改写
65  12  packages/dashboard/src/tui/components/panels.tsx     ← 源码
53  16  packages/dashboard/src/tui/state.ts                  ← 源码
```
`components.test.tsx` 的 **唯一 1 行删除** 是 import 语句改写（`+ ErrorPanel`），**非测试用例改动**：
```diff
-import { ReplyPanel, StreamPanel, TeamPanel, WelcomePanel } from "./components/panels"
+import { ErrorPanel, ReplyPanel, StreamPanel, TeamPanel, WelcomePanel } from "./components/panels"
```
其余测试文件（`ConsoleReporter.test.ts` 72/0、`FileLogWriter.test.ts` 26/0、`Orchestrator.run.test.ts` 269/0、`AcpRuntime.test.ts` 101/0、`App.run.test.tsx` 94/0、`format.test.ts` 40/0、`state.test.ts` 139/0）**均纯新增（0 删除）**。新增文件：`init.test.ts`、`toolSummary.test.ts`、`App.error.test.tsx`。

**跳过标记：全仓 0 命中**
```
$ grep -rnE '\b(it|test|describe)\.(skip|todo|only|fails)\b|\bx(it|describe)\(' packages/**/*.{ts,tsx}
No matches found
```

**② `AgentRunner.test.ts`：替换 `"forwards agent text events as agent:output, and ignores non-text events"` → `"forwards agent text untagged and tool activity tagged by kind"`**

- **旧断言**：`expect(outputs.map(e=>e.payload)).toEqual([{agentId:"a",chunk:"chunk-1"},{agentId:"a",chunk:"chunk-2"}])`（**精确数组相等**，即「只有 2 条、tool_call 被忽略」）。
- **新断言**：`outputs[0].payload === {agentId:"a",chunk:"chunk-1"}`、`outputs[4].payload === {agentId:"a",chunk:"chunk-2"}`（**文本仍被转发、payload 形状不变**）+ `outputs[1]/[3]` 为 `kind:"tool"`、`outputs[2]` 为 `kind:"tool-detail"`。
- **判定：等价替换，非净减少。** 文本转发契约被完整保留（`outputs[0]`/`outputs[4]` 精确断言）；旧「忽略非文本事件」契约被**设计性取代**——tool 事件现在**确实**进入 `agent:output`（带 kind），这是 B2-3 的目标而非回归。
- **替代保护存在**：headless stdout「不受 tool 事件影响」的新契约由 `ConsoleReporter.test.ts > "keeps tagged tool activity out of stdout"` 承担（断言 `writeSpy` 调用数组为 `["  prose","  text"]`），我另有独立 V4 用例（见下）双重覆盖。
- **唯一轻微减弱**：旧用例断言 `outputs` **精确长度**（隐式=2），新用例未断言 `outputs.length===5`——若在末尾多出一次 emit 不会被抓。但 `outputs[1..4]` 均被逐位断言，实际风险极低。记为 **P2-3**。

**③ `commands.test.ts`：`"always offers the rest"` 名单加入 `"verbose"`**

- **该用例改前改后都是 `expect(idle).toContain(name)`**（循环断言「包含」），**从未**是「必须等于全集」。改动仅是名单字面量 `[... , "verbose"]`。
- 全文件亦**无**任何「精确等于命令全集」的断言（`"returns everything for an empty query"` 用的是 `toHaveLength(availableCommands(false).length)` 自洽长度，非硬编码集合）。
- **判定：合法枚举更新，非放宽断言。** 新增 `matchCommands("verb")[0].name==="verbose"` 用例亦为纯新增。

### 回退实验
临时回退 `AgentRunner` 失败路径的 `model` 捕获 → `"records the model on a failure"` 变红（见 V10）。→ **新用例具区分度。**

---

## V4 —— headless stdout 与日志文件「逐字节不变」

### 验证方法
**自写** `packages/cli/src/reporters/qa-v4-verify.test.ts`（6 例），独立构造「纯文本序列」与「文本+tool+tool-detail 交错序列」，比较 `writeSpy` 调用数组。

### 实际结果
```
$ pnpm exec vitest run src/reporters/qa-v4-verify.test.ts
 ✓ produces the exact same write() calls
 ✓ an explicit kind:'text' passes through like an untagged chunk
 ✓ a cancelled agent is never the red failure cross
 ✓ a real failure still uses the red cross
 ✓ the summary row marks cancelled apart from failed
 ✓ writes text and skips tagged tool activity
 Tests  6 passed (6)
```
- **stdout 逐字节不变**：纯文本序列 `writeSpy` = `["  alpha ", "  beta\n"]`；把 tool(`"\n› Bash pnpm test\n"`)、tool-detail(`"  ✓ all green\n"`)、失败 tool(`"  ✗ boom\n"`) 插进同一序列后，`writeSpy` **仍为** `["  alpha ", "  beta\n"]`——**两数组 `toEqual` 完全一致** ✅
- 显式 `kind:"text"` 与无 `kind` 的 chunk 一样透传（`["  x","  y"]`）✅
- **日志文件**：`alpha.log` 内容恰为 `"one two"`（tool 事件被跳过）✅

---

## V5 —— `onWarning` 通道

### 验证方法
自写 `packages/core/src/runtime/qa-v5-verify.test.ts`（2 例），复用 `FakeChild` + `attachAgent` 真 ACP 在环；另确认既有 `AcpRuntime.lazyimport.verify.test.ts` 仍绿。

### 实际结果
```
$ pnpm exec vitest run src/runtime/qa-v5-verify.test.ts
 ✓ with onWarning: nothing to stderr, message delivered
 ✓ without onWarning: stderr fallback keeps the byte-identical prefix
 Tests  2 passed (2)
```
- **有 `onWarning`**：`process.stderr.write` **未被调用**；warning 数组恰 1 条且含 model id ✅
- **无 `onWarning`**：回退 stderr，写入内容 **`startsWith("[multiclaw] Warning: ")`**（历史前缀逐字节一致），含 model id，以 `\n` 结尾 ✅
- **`describe()` 仍 SDK-free 且不 spawn**：既有 `AcpRuntime.lazyimport.verify.test.ts`（3 例，全绿）通过 mock SDK 计数 `loads===0` 证明「import 模块不加载 SDK、`describe()` 不加载 SDK」；`describe()` 路径只调 `resolveExecutable`（PATH 查找），无 spawn。本次改动未触及 `describe()` 路径 ✅
- 备注：告警**正文**措辞有变（`running with provider default.` → `running with the provider's default.`），但**前缀**按要求逐字节不变；全仓无测试/文档依赖旧正文（`AcpRuntime.test.ts:862` 只 `toMatch(/provider's default \(.+\)/)`）。记 **P2-5**。

---

## V6 —— TUI 渲染与布局预算

### 验证方法
自写 dashboard 用例；用「超长 taskTitle + 同时有 usage 与 cost」的极端组合渲染 `StreamPanel`，并直接打印原始帧。

### 实际结果
**StreamPanel 头部恒 1 行**（配对算术 `layout.ts:169 logViewport=bodyHeight-1` ↔ `panels.tsx:150 viewport=Math.max(1,height-1)` 均为 -1，未变）：
```
FRAME_PROBE: " Architect · sonnet-4 · ⠋ running · x · ctx 45.2k/200k · $0.42 ... 4.2s ▼\n waiting for output…\n..."
 ✓ stays one row with a very long title AND usage AND cost
 ✓ keeps the log viewport budget (header + body <= height)
 ✓ no orphan separator when usage and cost are absent
 ✓ no ctx segment when only one half of usage is present
 ✓ shows a multi-line error in full, each line its own row
```
- 超长标题（84 字符）+ usage + cost 同时存在时：含 `▼` 的行**恰好 1 行**、宽度**恰为 100**（未换行）、行尾仍是 `▼`（右侧未被挤掉）✅
- **无孤儿 `·`**：无 metering 时头部不以裸 `·` 结尾；加 title+usage+cost 后 `·` 计数恰好 +3（一一对应，无多余分隔符）✅
- `usage` 只有一半（只有 `contextTokens`）时**不渲染 ctx 段**（避免「半截分数」）✅
- **ErrorPanel 多行完整**：三行错误分别落在**三个不同行**（`new Set(findIndex).size === 3`），未被压成一行 ✅
- **esc 优先级**（独立 keystroke 用例，3 语义全过）：
```
 ✓ 1. esc closes the help overlay first (overlay semantic)
 ✓ 2. esc leaves a past turn and returns to live (view semantic)
 ✓ 3. esc clears the input line when nothing else is open (input semantic)
```
  代码顺序（`App.tsx`）：`helpOpen`(488) → `historyOpen`(495) → `menuOpen`(551) → **`error`(626，新增)** → `state.view`(636) → 清输入行(640)。**新增的 error 检查插在 overlay 之后、view/输入行之前**，因 `if (error)` 守卫，仅当有错误时生效——既有三语义未破坏；error 自身的 esc 关闭由 `App.error.test.tsx` 覆盖。✅

---

## V7 —— `/verbose` 折叠语义

### 实际结果（独立用例）
```
 ✓ verbose off: tool chunk enters, tool-detail is dropped   （drop 返回同一对象，reducer 恒等契约保持）
 ✓ verbose on: tool-detail enters
 ✓ kind absent is text: enters regardless of verbose        ← 向后兼容关键
 ✓ kind === 'text' explicitly also enters
 ✓ toggling verbose never resurrects dropped history
```
- 默认（verbose=false）：`kind==="tool"` **进入**流，`kind==="tool-detail"` **被丢弃**（`state.ts:361` 在 reducer 层丢弃，非渲染层）✅
- 打开后：`tool-detail` 进入 ✅
- **`kind` 缺省（无该字段）等同 `"text"`**：无论 verbose 开关都进入 ✅（`if (kind === "tool-detail" && !state.verbose)` 只拦 tool-detail，缺省值落空即透传）
- 开关不会「复活」已丢弃历史 ✅

---

## V8 —— 未新增事件类型 & 破坏性变更

### 实际结果
- **`MultiClawEvent` union 无新增成员**：`git show HEAD:event.ts` 与工作区对比，事件类型集合完全一致；`orchestration:warning` **在 HEAD 即存在**。本次仅**加宽** `agent:output` payload（新增可选 `kind`）。独立用例「a full run emits no event type outside the pre-existing union」通过 ✅
- **`AgentStatus` 新增 `cancelled` 的全部消费者已覆盖**：
  - `theme.ts:32 Record<AgentStatus, StatusStyle>` 补 `cancelled`（穷尽 Record，`tsc` 通过即证明无遗漏）；
  - `state.ts:638 SETTLED` 加入 `cancelled`；
  - dashboard **无 `switch(agent.status)`**（唯二 switch 是 `switch(event.type)`/`switch(action.type)`，为封闭联合，无需 default）——故「switch 缺 default」的担忧在本仓**不适用**；
  - `chrome.tsx:52`/`panels.tsx:34` 用 `STATUS[status]` 全量 Record 查表，无遗漏。
- **`ModelSelectionMode` 收窄**：全仓 `"arg"` 字面量 **0 命中**；仅 `docs/rfcs/0001-agent-provider-catalog-and-init-wizard.md`（3 处）提及 `"arg"`——**历史 RFC 文档，不算违规**，按要求在此指出。catalog 四家 provider 均为 `"config-option"`，`capabilities.models` 判定改为 `=== "config-option"` ✅

---

## V9 —— 全量质量门禁（自行执行）

| 门禁 | 命令 | 结果 |
|---|---|---|
| Lint | `pnpm lint` | ✅ `Checked 121 files … No fixes applied` |
| Build | `pnpm build` | ✅ core/dashboard/cli 均 Build success |
| Typecheck | `pnpm typecheck` | ✅ 3 包 `tsc --noEmit` 无错（exit 0） |
| Test | `pnpm test` | ✅ core 306 / dashboard 311 / cli 62 = **679 passed** |
| Coverage | `pnpm test:coverage` | ✅ 全过线（下表） |

**覆盖率（实测 vs 阈值）**：

| 包 | Stmts | Branch | Funcs | Lines | 阈值 | 结论 |
|---|---|---|---|---|---|---|
| core | 97.01 | 92.32 | 94.67 | 97.94 | 90/85/90/90 | ✅ |
| cli | 67.42 | 64.56 | 70.90 | 67.57 | 50/45/40/50 | ✅ |
| dashboard | 99.35 | 96.21 | 100 | 99.61 | 90/85/90/90 | ✅ |

**dist 新鲜度（关键：dashboard 集成测跑的是 core 的 dist）**：先 `pnpm build` 再测；验证后重建 core，`dist/index.js` 哈希**前后一致**：
```
before: 0046622ef9bbe2990d20a4672d699d6f199e956b  packages/core/dist/index.js
after:  0046622ef9bbe2990d20a4672d699d6f199e956b  packages/core/dist/index.js
UNCHANGED -> dist was already built from final source
```
（`dashboard/vitest.config.ts` 无 alias，`package.json` 依赖 `@multiclawcli/core: workspace:*` → 解析到 `packages/core/dist/index.js`，故 dashboard 测的确为**含修复的** core 产物。）
**无任何失败被以「与本次改动无关」放过。**

---

## V10 —— 独立复核工程师的一处「诚实记录」

工程师自述：`AgentRunner.test.ts` 的 `"records the model on a failure but no usage or cost"` **回退后仍绿（断言不具区分度）**。

### 验证方法
临时删除失败路径 result 里的 `model` 字段（回退 B2-1 的失败路径改动），单独跑该用例。

### 实际结果
```
× records the model on a failure but no usage or cost
AssertionError: expected undefined to be 'opus'   ← 变红
```
→ **该测试具区分度**：一旦失败路径不再携带 `model`，用例立即变红（`result.model` 期望 `"opus"`、实得 `undefined`）。工程师的自评**过于苛刻**。

### 判断：**保留**（可酌情加强，但不应删除）
理由：
1. 它真实守护两条不变量：**失败路径携带 `model`**（TUI 需要显示「哪个模型失败了」）+ **失败路径不得凭空产生 usage/cost**（`"usage"/"costUsd" in result === false`）。后者是「无数据 ≠ 0」语义在失败分支的对应物。
2. 若日后重构时误把成功路径的 `...(usage ? {usage}:{})` 复制到失败路径，这条会拦住。
3. 可选**加强**（非必需）：追加断言 `agent:failed` 事件 payload 也携带 `model`，把「事件消费者可读到 model」一并锁死。

---

## 遗留问题清单

**P0：无。P1：无。**

**P2-1｜陈旧注释（文档级）**
`packages/core/src/orchestrator/Orchestrator.ts:116` 注释仍写「`AgentRunner` turns an abort into an ordinary `failed` result」，但 B2-6 后 abort 已产出 `cancelled`。逻辑本身正确（`status!=="success"` 仍成立，故 `allSuccess=false` 的理由不变），仅注释失准。建议顺手改「an abort result（now `cancelled`）」。

**P2-2｜`stageStatus` 对纯 cancelled 阶段回滚为 `pending`（潜在、当前未接线）**
`state.ts:629 stageStatus` 的判定：非 failed、非 running/retrying、非全 success、非全 skipped → 落 `"pending"`。故「某 stage 全员 cancelled」会读成 `pending` 而非 `cancelled`。**但 `stageStatus` 当前仅被测试引用，生产渲染（`PipelineRail`）逐 agent 用 `STATUS[status]`，cancelled 的 ■ 显示正常**，故非用户可见缺陷。若未来把 `stageStatus` 接入 rail，需补 cancelled 分支。

**P2-3｜`AgentRunner.test.ts` 新用例未断言 `outputs` 精确条数**
旧用例隐含断言数组长度=2；新用例逐位断言 `outputs[0..4]` 但未断言 `length===5`。末尾多一次 emit 不会被抓。风险极低（中间位已逐位锁定），可选补 `expect(outputs).toHaveLength(5)`。

**P2-4｜`toolSummary` 两函数实现完全一致（代码整洁，非缺陷）**
`summarizeToolInput` 与 `summarizeToolOutput` 均直接 `return firstLineTruncated(...)`。当前语义上「输入/输出」确有区分价值（未来可能分道），保留可接受；仅记录。

**P2-5｜告警正文措辞变更（向后兼容提示）**
stderr 回退文案由 `…; running with provider default.` 改为 `…; running with the provider's default.`。**前缀 `[multiclaw] Warning: ` 逐字节不变**（已实测），符合要求；仅提示按正文 grep 日志的脚本需注意。

---

## 附：验证过程中对源码的临时改动与恢复

| 文件 | 改动 | 恢复 |
|---|---|---|
| `packages/core/src/orchestrator/AgentRunner.ts` | 临时回退失败路径的 `status`/`model`（验证 V10 与 V3 区分度） | ✅ 用 `/tmp/qa-AgentRunner.bak` 恢复，`shasum` 一致（`8c45629d…`） |
| `packages/core/src/orchestrator/Orchestrator.ts` | 临时把 `sumCosts` 改为恒返回数字（验证 V1 区分度） | ✅ 用 `/tmp/qa-Orchestrator.bak` 恢复，`shasum` 一致（`46c7207c…`） |
| 临时测试文件 ×5 | `core/src/orchestrator/qa-v2-verify.test.ts`、`core/src/runtime/qa-v5-verify.test.ts`、`cli/src/reporters/qa-v4-verify.test.ts`、`dashboard/src/tui/qa-v2-verify.test.tsx`、`dashboard/src/tui/qa-esc-verify.test.tsx`（共 27 例） | ✅ 全部删除（`git status` 无残留） |

**恢复确认**：`git diff --stat` 与初始一致（`AgentRunner.ts` 132 行、`Orchestrator.ts` 59 行变更）；源码哈希与备份逐一相符。**未 commit，未改动业务源码（仅上述已恢复的临时改动）。**
