# Batch 5a 独立复核报告 —— core 正确性（C10 / C8 / C7 / C12 / C13）

> 复核人：严过关（QA）｜日期：2026-10-14｜HEAD：`af25692`（未 commit）
> 方法：**对抗式**——独立测量、自写用例、自行回退复现，不复述工程师结论。
> 计划书：`deliverables/software-company/multiclaw-batch5a-plan-2026-10-14.md`

## 判定

**PASS WITH ISSUES**（无阻塞项；1 项 P2 注释精度、2 项 P3）

改动**真实有效**：C10 修复了「`retries>0` 时重试永远没机会」的真缺陷（回退即变红，逐字复现）；C8/C12/C13 行为正确；C7 已按计划回退为纯注释且属实。

---

## 1. C10 超时分层 —— 重点攻击

### 1.1 核心不变量：`retries:1` 时两次尝试各自能用满 `timeout`

**自写用例**（`/tmp` → 临时置于 `packages/core/src/__b5a_verify.test.ts`，跑完即删），直接复刻 `AgentRunner` 的组合 `withTimeout(s => withRetry(fn, 1, …, s), retryBudgetMs(timeout,1))`：

```
perAttempt=100ms, delay=2000ms
→ 第二次尝试的起始时刻 − 第一次 = 100 + 2000 = 2100ms（= perAttempt + delay）
→ resolves "second"（成功），attempts=2
```
**实测：第二次尝试在第一次用满整个 `timeout` 并睡满退避之后才启动。** 不变量成立。

### 1.2 `retryBudgetMs` 是否真是**上界**？

**算术核对**：`perAttemptMs*(retries+1) + delayMs*retries*(retries+1)/2`。
- 尝试数 = `retries+1`；退避和 = `delayMs*(1+…+retries)` = `delayMs*retries*(retries+1)/2`。
- 实测：`retryBudgetMs(1000,0)=1000`；`(1000,1)=4000`；`(1000,2)=9000`；`(1000,3)=16000`；`(600000,3)=2412000`。**逐项与手算一致。**

**最坏情况（fake timers）**：
- 前 `retries` 次每次耗满 `perAttempt` 且每次退避睡满，最后一次在 **99/100 预算处成功** → 总耗时 6299ms < budget 6300ms → **外层未在最后一次尝试完成前触发**（`resolves "ok"`）。
- 全失败最坏情况（每次耗满、每个退避睡满）：总耗时**恰好 = budget 6300ms**。实测边界上**外层计时器先赢**：
  ```
  [Q1b] all-fail@budget error = "[AGENT] timed out (6.3s)"
  ```
  即 budget 是**精确**上界、**零余量**；all-fail 时外层与内层在同一 ms 竞争，外层（先注册）抢先。**两个都是失败，无害**。

**反向核查（外层是否过大到掩盖问题）**：内层 timer **未被改动** —— `runtime.execute({ timeout })` 仍收到**单次** `timeout`（`AgentRunner.ts:94`），只有外层 `withTimeout` 用 `retryBudgetMs`。故单次尝试仍被 `timeout` 约束，**未掩盖**。

### 1.3 【P2】上界声明的两处不严谨

1. **零余量**：budget = 理想最坏值，无 slack（见 1.2）。理论上"上界"应为**严格**上界才安全，这里是"恰好相等"。因成功尝试必 < `timeout`（超时的尝试已被 `timedOut=true` 标记、不可能成功），**成功路径不会被误杀**；仅 all-fail 的报错文案会由内层的 `acp timed out` 变为外层的 `[name] timed out`。
2. **遗漏 SIGTERM→SIGKILL 宽限**：内层 timer 在 `task.timeout` 触发 `stop("SIGTERM")`，但 **reject 发生在 `child.on("close")`**；子进程若忽略 SIGTERM，需 `KILL_ESCALATION_MS=3000`（`AcpRuntime.ts:42`）后 SIGKILL。故**单次**实际耗时可达 `timeout + 3000`，而 `retryBudgetMs` 只计 `timeout`。真实序列上界 = `retryBudgetMs(…) + (retries+1)*3000`。
   → 该路径下外层会提前最多 `(retries+1)*3s` 触发并 abort。因该路径下**每次尝试本就在超时**（不可能成功），结果仍是失败，**无正确性损失**；但注释 "Wall-clock upper bound for one full retry sequence" 属**绝对化夸大**，宜补"前提：子进程在 SIGTERM 下及时退出 / 忽略宽限"。

### 1.4 「是否同义反复」——**不是**

工程师新增的 `gives each attempt the full timeout…` **会真实走到** `withTimeout + withRetry + retryBudgetMs` 组合与 `AgentRunner.run` 装配；回退后**确实变红**（§1.5）。因此不是同义反复。
**但它证明了什么 / 没证明什么**：
- **证明**：给定"内层在 `task.timeout` 处 reject"这一契约，外层预算足以容纳完整的一次重试。
- **未证明**：真实 `AcpRuntime` 的内层 timer **确实**在 `task.timeout` 处 reject —— 该用例用**手写 handler** 模拟内层（`setTimeout(reject, task.timeout)`），是**模型假设**，由 `AcpRuntime` 自身测试独立覆盖。

### 1.5 回退复现（我亲手改回 `timeout` 后实跑）

```
× gives each attempt the full timeout when retries are configured
AssertionError: expected 'failed' to be 'success' // Object.is equality
Tests  1 failed | 20 skipped (21)
```
**与工程师声称的 `expected 'failed' to be 'success'` 逐字一致。** 还原后 SHA256 核对通过。

---

## 2. C8 可重试错误分类

### 2.1 省略 `shouldRetry` → 行为逐字不变
`withRetry(fn, 3, onRetry, 1000)`（不传第 6 参）：`fn` 调用 **4** 次、`onRetry` **3** 次、参数 `[1,2,3]`、错误消息 `["x","x","x"]`。与改动前契约一致。**（第 6 参默认 `undefined` + `if (shouldRetry && …)` 守卫，与计划写的 `() => true` 行为等价，非缺陷。）**

### 2.2 不可重试错误
`withRetry(fn, 3, onRetry, 1000, undefined, e => !isPermanent(e))`，`fn` 抛 `PermanentError`：`fn` 调用 **1** 次、`onRetry` **0** 次、**不退避**（未推进任何 timer 即 settle）、reject 的是**同一个** error 对象。

### 2.3 `AcpRuntime` 只改两处，其余仍可重试
`git diff` 仅两处 `new Error(` → `new PermanentError(`：`child.on("error")`（spawn 失败，`:572`）与 `loadSession=false`（`:589`）。**超时（`:559`）、`connectionError`（`:563`）、子进程非零退出（`:566`）保持普通 `Error`** → 仍可重试。工程师用例 `leaves a plain non-zero exit retryable` 佐证。

### 2.4 错误消息逐字未变（结果契约）
- `Failed to start ${command}: ${err.message}` —— 逐字保留。
- `Agent does not support session/load (loadSession=false); cannot resume session ${task.sessionId}` —— 逐字保留。

### 2.5 传播与打包产物
- `PermanentError` 穿过 `withTimeout` 的 `Promise.race` + `withRetry` 后**仍是同一对象**，`isPermanent` 为 true。
- **打包产物核对**：core 只产出**单个** `dist/index.js`；`var PermanentError = class extends Error`（`:1078`）、`isPermanent` 用 `instanceof PermanentError`（`:1084`）、两处 throw（`:1426`/`:1435`）**同处一文件** → `instanceof` 在 dist 中**成立**，无跨 chunk 重复类风险。

### 2.6 回退复现（三条全中，另附 2 条）
回退 retry.ts 守卫 + AgentRunner 第 6 参 + AcpRuntime 两处后实跑：
```
× does not retry a failure the predicate rejects   AssertionError: expected "vi.fn()" to be called 1 times, but got 4 times
× passes the error and the 1-based attempt …        AssertionError: expected [] to deeply equal [ [ Error: boom, 1 ] ]
× does not retry a permanent runtime failure        AssertionError: expected 4 to be 1
× classifies a failed spawn as permanent            AssertionError: expected false to be true
× classifies an unsupported session/load as permanent  AssertionError: expected false to be true
Tests  5 failed | 33 passed (38)
```
工程师声称的三条 **逐字一致**；我多观察到两条（同因）。还原后三文件 SHA256 与备份**逐字节一致**。

---

## 3. C12 `resolveArgs`

- **diff 纯新增**：`resolve.test.ts` numstat `+26/−0`。既有 3 条断言（`provider:"claude"`→`[]`、`"opencode"`→`["acp"]`、`"unknown"`→`undefined`）**逐字未动**（在 diff 上下文中）。
- **行为**（自写用例）：custom command → `undefined`；catalog command → 自身 args（`opencode`→`["acp"]`、`claude-agent-acp`→`[]`）；`command` 与矛盾 `provider` 并存时 **command 胜出**；三无（无 args/command/provider）→ 回落 provider，**与旧行为一致**。
- **调用方全仓排查**：`resolveArgs` 经 `providers/index.ts` → `index.ts` 导出，但**全仓仅 `AgentRunner.ts:108` 一处内部调用**；cli/dashboard **零调用**。`Orchestrator.run.test.ts:85-103` 的 `run()` 级 args 断言用的是 `provider`（无字面 `command`）→ 走 provider 回落分支 → **不受影响**。**无其它调用点依赖旧回落行为。**

---

## 4. C13 `configuredAgents()`

- **深拷贝**：`copies[0].dependsOn !== config.agents[0].dependsOn`；对副本 `push` 不影响 config。✓
- **不新增键**：对无 `dependsOn` 的 agent，`"dependsOn" in copies[1] === false`，`Object.keys` 不含该键。✓（断言的是**键不存在**，非值为 `undefined`——正确。）
- **私有方法直访是否可接受**：**可接受**。`configuredAgents` 为 private，其拷贝语义**经 `run()` 不可观测**——因为 `applyTaskPlan` 对 `agent.dependsOn` 是**重新赋值**（`Orchestrator.ts:436` `agent.dependsOn = dependsOn`）而非原地 `push`；`agents` 来自 `resolveTurn()` → `configuredAgents()`（`:275/288/305`）。用例注释所述理由**成立**：无法构造 `run()` 级场景来观测，故直测不变量是务实选择。
- **【P3】同名模式在 `selectAgents` 仍在**：`Orchestrator.ts:369` `dependsOn: a.dependsOn?.filter(...)` 对**无** `dependsOn` 的 agent 会**写入值为 `undefined` 的键**——正是 C13 在 `configuredAgents` 中刻意避免的写法。属**既有代码**、超出 C13 范围，且下游 `a.dependsOn?.filter` 对 `undefined` 与"缺键"行为一致，**今日无可观测影响**。建议后续统一。

---

## 5. C7 `discoveredModels` 缓存键

- **键已回到 `command`**：`discoveredModels.set(command, ids)`（`:625`）、`.get(command)`（`:631`）——与 team-lead 核对的 625/631 **一致**；全模块**无** `exe` 作键。
- **假话已删**：净 diff 中不再有任何"跨 provider/跨版本失效"的错误论断。
- **剩余注释属实**：`resolveExecutable` 确为 `command + PATH + fs` 的纯函数；同一 command 在进程内恒定解析到同一二进制（`resolvesOnPath` 命中→裸名，否则→自带桥绝对路径），故**以 command 为键可靠**。原评审前提（"同一 command 可能指向不同二进制"）**被证伪**，回退为注释**正确**。
- **已知限制描述属实**：`:630-639` —— 当 `known` 存在且不含配置模型时，**只 `warn` 并跳过 `setConfigOption`**，模型不生效。✓
  - 【P3】措辞小瑕：注释写 "**silently** not take effect"，但代码**确有 warn**（非 silent）；含义（模型不生效）对，措辞宜微调。

---

## 6. 门禁与残留

```
build     : 三包 tsup 成功（core ESM 31.25KB + dts）           EXIT 0
lint      : biome check . — 128 files, No fixes applied        EXIT 0
typecheck : tsc ×3 — no errors                                 EXIT 0
test      : core 368 | dashboard 323 | cli 81 = 772 全过        EXIT 0
coverage  : core 97.2/92.73/95.02/98.07 | dashboard 99.36/96.26/100/99.61 | cli 76.07/70.08/75.8/76.61
            阈值 core 90/85/90/90、cli 50/45/40/50、dashboard 90/85/90/90 —— 全不破
            关键文件：errors.ts 100/100/100/100、retry.ts 89.28/92.85/83.33/91.3、
                     AgentRunner.ts 100/92.5/100/100、AcpRuntime.ts 96.95/88.57/95.12/99.06、
                     resolve.ts 89.65/90.9/80/86.36、Orchestrator.ts 100/98.63/100/100
skip/todo/only/xit : 0 命中 ; 快照断言 : 0 命中
```
- **`test:coverage` EXIT=1 的唯一原因**：cli 的 `V8CoverageProvider.cleanAfterRun` 删 `packages/cli/coverage/.tmp` 被本机 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` 拦截（`count:56 > threshold:50`）。**与代码无关**；三张覆盖率表**均已打印**且**无 threshold 报错** → 按约定**通过**。
- **`retry.test.ts` 的 1 行删除**：`-import { withRetry } from "./retry"`，被 `+import { PermanentError } from "./errors"` 与 `+import { DEFAULT_RETRY_DELAY_MS, retryBudgetMs, withRetry } from "./retry"` 两行取代。**合理**。
- **工作区**：10 `M` + 4 `??`。其中 `.workbuddy-ai/memory/2026-10-13.md`（会话记忆，非本批源码）占 1 `M`；本批源码/测试 = 9 `M`（5 源 + 4 测）+ 新增 `errors.ts` / `errors.test.ts` / `AcpRuntime.permanent.test.ts`（+ 计划书）。**无异常。**
- **无仓库内临时文件**：我的用例文件跑完即删；回退改动**逐字节还原**（SHA256 核对通过）；临时脚本全部在 `/tmp`。HEAD 仍 `af25692`。**未 commit。**

---

## 7. 回归面

- **既有测试只增不改**：`AgentRunner.test.ts` `+76/−0`、`Orchestrator.run.test.ts` `+27/−0`、`resolve.test.ts` `+26/−0`。**均为纯新增，无既有断言被删改。**
- **无因 `shouldRetry` / `resolveArgs` 失真**：全量 772 测试通过；`resolveArgs` 无其它内部调用点（§3）；`shouldRetry` 省略即等价旧行为（§2.1）。

---

## 8. 遗留问题

| 级别 | 项 | 说明 | 建议 |
|------|----|------|------|
| **P2** | C10 `retryBudgetMs` 注释夸大 | "Wall-clock upper bound" 未提：① all-fail 边界零余量（外层抢先，文案变 `[name] timed out`）；② 单次可因 SIGTERM 忽略而达 `timeout+3000`，真实上界应含 `(retries+1)*KILL_ESCALATION_MS` | 注释补前提；或在 doc 中给出 `+ (retries+1)*3000` 的保守上界 |
| P3 | C7 措辞 | "silently not take effect" 实为"有 warn 但不生效" | 微调为 "warns and skips setConfigOption, so the model does not take effect" |
| P3 | C13 一致性 | `selectAgents`（`:369`）仍会为无 `dependsOn` 的 agent 写入 `undefined` 键（既有、超范围、无可观测影响） | 后续统一为 C13 写法 |

**结论：无阻塞项。C10 真缺陷已修复且经回退复现证明有效；C8/C12/C13 正确；C7 按计划回退为纯注释且属实。建议提交。**

---

# §F5 Round 2 定向复核 —— KILL_ESCALATION_MS 计入外层预算

> 触发：team-lead 判定我的 P2 必须修（不只文案——前 retries 次各耗 `timeout+3000` 时，最后一次**本可成功**的尝试会少拿 `retries×3000` 而被外层杀掉）。工程师已修：`KILL_ESCALATION_MS` 改 `export const` + re-export；外层预算 `retryBudgetMs(timeout + KILL_ESCALATION_MS, retries)`；retry.ts 文档更新；AcpRuntime 行为未改。
> 日期：2026-10-14；HEAD 仍 `af25692`。所有脚本/探针自写，跑完即删。

## 判定

**PASS WITH ISSUES**（无新增阻塞项；P2 与 C7 措辞本轮已修；仅 P3 `selectAgents` 遗留）

---

## R2-1 独立复现 F5-1

### 【自算】
- `retryBudgetMs(100,2)` = `100*3 + 2000*2*3/2` = `300 + 6000` = **6300** ✓（与 team-lead 一致）。
- **实际调用** = `retryBudgetMs(100 + KILL_ESCALATION_MS, 2)` = `retryBudgetMs(3100,2)` = `3100*3 + 6000` = **15300**。
- F5-1 时间线 = `3100 + 2000 + 3100 + 4000 + 100` = **12300 < 15300** → 成功。
- 新用例原样通过：`attempts=3, success`。

### 【自回退（探针实测 result）】
```
REVERT A (pre-F5: retryBudgetMs(timeout, retries)=6300)
  [F5PROBE] status=failed attempts=2 error="[a] timed out (6.3s)"
REVERT B (pre-C10: bare timeout=100)
  [F5PROBE] status=failed attempts=1 error="[a] timed out (0.1s)"
```
- **回退 A 的 `[a] timed out (6.3s)` 与工程师声称逐字一致**（字符串与数字均核实）。
- 两次回退均变红（`expected 'failed' to be 'success'`）；还原后 `AgentRunner.ts` SHA256 与备份**逐字节一致**（`76b7e284…`）。
- 注：team-lead 括注"实参改回 `timeout`"字面得 `(0.1s)`；工程师声称的 `6.3s` 对应的是**pre-F5 的 `retryBudgetMs(timeout, retries)`**（即 F5 真正回退的那一步）。两者都已实测。

---

## R2-2 攻击新公式的上界性 —— **真上界（现实路径），无漏项**

`timeout + KILL_ESCALATION_MS` 是现实路径下单次尝试的真实上界：超时路径 = timer@`timeout` → `stop("SIGTERM")` → 若忽略则 SIGKILL@`+3000` → `close` → reject。逐条排查其它可能超时点：

| 路径 | 结论 |
|------|------|
| `stop()`/`killTree` 时序 | SIGTERM 立即，SIGKILL 在 `KILL_ESCALATION_MS` 后（`AcpRuntime.ts:336`）；reject 在 `child.on("close")`（`:555`），**无 `exit` 监听** → 上界 = `timeout+3000` ✓ |
| `close` 处理器 decoder flush | 同步、微秒级（`stderrDecoder.end()`），**非时间项** |
| `CANCEL_GRACE_MS`(2000) | **仅**在 abort 监听器（`:549`），超时路径**不触发**；且 abort 时外层 `cancelled` 立即 reject，**不叠加** |
| 子进程已退出但事件未到 | Node `close` 待 stdio 关闭；若孙进程（已脱离进程组）持有 stdio，`close` 延迟 → **外层兜底**（其职责），且该尝试不可能成功 |

- **残余唯一路径**：子进程/进程组被 SIGKILL 后仍不 close（不可中断进程、脱离进程组的孙进程持 stdio）→ 尝试永不 reject → 外层兜底触发。该尝试**本不可能成功**，**不丢任何"本可成功"的尝试**。
- **反向（是否过大）**：`retries:0` 外层由 `timeout` → `timeout+3000`，挂死 runtime 多等 3s。默认 `timeout=600s` 下 3s=**0.5%**，**可接受**；这是"不误杀合法收尾尝试"的必要代价。
- **旧等式依赖**：全仓无任何测试/代码依赖"外层预算 === `timeout`"。唯一相关的就是 R2-3 修改的那条（用**符号** `100 + KILL_ESCALATION_MS`）。

**判定：`timeout + KILL_ESCALATION_MS` 是真上界，无漏项；新预算未大到掩盖问题。**

---

## R2-3（重点）被改动的既有测试 —— **合法适配**

用例：`"fails the agent when the runtime exceeds the timeout"`（`AgentRunner.test.ts:97`）。

### 【逐行 diff】
```diff
     const promise = makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME, timeout: 100 }))
-    await vi.advanceTimersByTimeAsync(100)
+    // The outer budget is `timeout + KILL_ESCALATION_MS`: even with no retries, a
+    // single attempt may still be reaping a child that ignored SIGTERM during the
+    // SIGKILL grace.
+    await vi.advanceTimersByTimeAsync(100 + KILL_ESCALATION_MS)
     const result = await promise
 
     expect(result.status).toBe("failed")
     expect(result.error).toContain("timed out")
```
- **改动的是"推进量"**（`100` → `100 + KILL_ESCALATION_MS`），**不是断言**。
- 两条断言 `status==="failed"` 与 `error` **`toContain("timed out")`** **逐字未动**；断言**未钉 ms 数字或具体文案** → 不存在"文案随之变化"。

### 【判定：合法适配】
- 旧推进量 `100` 在新预算(3100)下**不再触发外层**；handler `() => new Promise(() => {})` 永不 settle，**只可能由外层触发** → 必须推进到新预算 3100。
- 语义"外层兜住忽略自身 timer 的 runtime" **保留**；断言未放松、覆盖未变窄、语义未改。
- **非削弱**。

### 【补强建议（非必须）】
该用例推进"恰好到预算"，未钉外层**恰在** 3100 触发（提前也会通过）；精确性由新用例 `does not let the outer timer beat…`（推进 30000 期望 success）覆盖，故**无缺口**。若要更严，可断言 `result.error` 含 `(3.1s)`。

---

## R2-4 导出面 —— **无泄漏**
- `src/index.ts:7` = `export { AcpRuntime, runtimeRegistry } from "./runtime"`（显式命名导出，**不含** `KILL_ESCALATION_MS`）。
- `packages/core/dist/index.d.ts` 导出清单（末行）**无** `KILL_ESCALATION_MS`；`grep -c` = **0**。
- `AcpRuntime.ts` 本轮 diff = `const`→`export const` + 注释，**无行为改动**（`:336` 用法不变）。

---

## R2-5 F5-2 —— **属实**
`discoveredModels` 注释改为"只发 `warn(...)` 并跳过 `setConfigOption`，故配置的模型不生效（有告警，但用户要的模型未被应用）"，与 `:630-639` 代码**一致**；**无逻辑改动**（仅注释）。

---

## R2-6 门禁与残留 —— **全绿**
```
build     : 三包 tsup 成功                                     EXIT 0
lint      : biome 128 files, No fixes                          EXIT 0
typecheck : tsc ×3 — no errors                                 EXIT 0
test      : core 369 | dashboard 323 | cli 81 = 773 全过        EXIT 0
coverage  : core 97.2/92.73/95.02/98.07 | dashboard 99.36/96.26/100/99.61 | cli 76.07/70.08/75.8/76.61
            AgentRunner.ts 100/92.5/100/100 | AcpRuntime.ts 96.95/88.57/95.12/99.06
            errors.ts 100/100/100/100 | retry.ts 89.28/92.85/83.33/91.3 —— 阈值全不破
skip/todo/only : 0 ; 快照 : 0
```
- `test:coverage` EXIT=1 唯一原因：cli `cleanAfterRun` 删 `coverage/.tmp` 被 `[safe-delete] count:56>50` 拦截（与代码无关）；三表已打印、**无 threshold 报错** → **通过**。
- `retry.test.ts` 仍只有那 1 行已判定合理的删除（旧 import 行被两行新 import 取代）。
- 工作区 11 `M` + 5 `??`；**无仓库内临时文件**（探针跑完即删）；脚本在 `/tmp`。HEAD 仍 `af25692`。**未 commit。**

---

## R2-7 回归面 —— **无其它改动**
- 除 R2-3 那条（+ 其 `import { KILL_ESCALATION_MS, … }` 行）外，`AgentRunner.test.ts` 无其它既有断言被改。
- `Orchestrator.run.test.ts`(27/0)、`resolve.test.ts`(26/0)、`retry.test.ts`(63/1) 与上轮**完全一致**。
- 全量 **773** 通过。

---

## §F5 Round 2 遗留问题
- **无新增阻塞项。**
- 上轮 3 项：**P2（`retryBudgetMs` 注释夸大）已修**（文档改为"第一个参数是单次尝试最坏墙钟，含清理宽限"）；**P3（C7 "silently"）已修**；**P3（`selectAgents` 未统一）仍在**（既有、超范围、无可观测影响）。

**结论：F5-1 修复正确且上界性成立、无漏项；被改动的既有测试属合法适配而非削弱；导出面无泄漏；F5-2 措辞属实；门禁全绿。建议提交。**
