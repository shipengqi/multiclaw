# multiclaw Batch 1「止血修复」独立验证报告

- 验证人：严过关（Yan）· QA 工程师
- 日期：2026-10-13
- 仓库：`/Users/C5406922/code/multiclaw`（改动在工作区，未 commit）
- 验证立场：**证伪**。不复跑工程师的命令盖章，而是用独立手段复现 bug、检查断言是否被削弱。
- 工程师结论（待验）：全部绿、`IS_PASS: YES`。

---

## 判定：**PASS**（附 P2 级测试覆盖缺口，无源码缺陷）

| 项 | 结果 |
|---|---|
| V1 复现 C1 根因修复 | ✅ 通过（临时改回旧守卫，新用例确实变红） |
| V2 `init` 生成配置合法性 | ✅ 通过（真实 ESM 加载 + 注入测试） |
| V3 测试是否被削弱 | ✅ 无削弱（纯新增，0 删除） |
| V4 dashboard 渲染 | ✅ 通过（头部恒 1 行、无孤儿分隔符、右对齐成立） |
| V5 破坏性变更审查 | ✅ 通过（`role` 可选无消费者风险；`generateConfig` 未泄露；无新裸键/命令） |
| V6 全量质量门禁 | ✅ 全绿（lint/build/typecheck/test/coverage 均过线） |

**遗留问题清单：无 P0、无 P1；P2 见文末。测试未被削弱。**

---

## V1 —— 独立复现 C1（最重要）

### 方法
1. 读 `packages/core/src/orchestrator/Orchestrator.ts` 新逻辑并自行推演。
2. **临时把守卫改回旧版**（`i === 0 && stage.some(a => a.id === "architect")`），跑工程师新增用例，确认是否变红；随后**立即恢复**。
3. 用独立临时测试验证两个边界（planner 失败 / 多 planner）与 stage-0 行为。

### 实际结果

**新逻辑（工作区）** `Orchestrator.ts:125-144`：
```ts
if (
  !planApplied &&
  stage.some((a) => this.isPlanner(a)) &&
  stageResults.some((r) => r.status === "success")
) {
  planApplied = true
  await this.applyTaskPlan(agents)
  stages = this.buildStagesOrFallback(agents, ...)
  this.eventBus.emit({ type: "orchestration:stages", ... })
}
```
`isPlanner(a) = a.role === "planner" || a.id === "architect"`（`:340-342`）。

**推演（backend 预设）**：`product-manager`(stage0) → `architect`(stage1) → …。`i=1` 时 `stage=[architect]`，`isPlanner` 为真，且 stageResults 含成功 → `planApplied=true`、调用 `applyTaskPlan`、re-emit `orchestration:stages`。旧守卫 `i===0` 在 `i=0` 时 `stage=[product-manager]` 不含 architect → 永不触发。**根因与修复一致。**

**V1.2 证伪（临时改回旧守卫）**：
```
$ pnpm exec vitest run src/orchestrator/Orchestrator.run.test.ts \
    -t "applies the task plan when the planner runs in a later stage"
 FAIL  ... > applies the task plan when the planner runs in a later stage
 AssertionError: expected undefined to be 'Implement' // Object.is equality
 - Expected: "Implement"
 + Received: undefined
  ❯ Orchestrator.run.test.ts:263:28
 Tests  1 failed | 33 skipped
```
→ **新用例确实覆盖该 bug**（旧守卫下变红）。**恢复后** `shasum` 与备份一致（`47bf18c6…`），且该用例重新变绿。

**边界（独立临时测试，跑完即删）**：
```
 ✓ src/orchestrator/qa-verify.test.ts (3 tests) 58ms
   ✓ 不应用 plan：planner 所在 stage 失败（continueOnError）→ dev.taskTitle undefined、orchestration:stages 0 次
   ✓ 多 planner 只应用一次 → orchestration:stages 恰好 1 次、success true
   ✓ stage-0 planner（frontend-like）仍正常 → dev.taskTitle = "Implement"
```
- **stage-0 原有行为未被破坏**（frontend/simple 类）：现有用例 `applies the architect task plan to later agents` 亦通过。
- **planner 失败不应用 plan**、**多 planner 只应用一次**：行为正确，但**提交的测试套件未覆盖这两条** → 见 P2-1。

---

## V2 —— `init` 生成配置必须是合法可解析 TS

### 方法
用导出的 `generateConfig` 对 **backend/frontend/fullstack × 有/无 override** 生成配置，**剥掉 `multiclaw` import 行 + 注入本地 stub**（`defineConfig = c=>c`、`agents` 为返回入参的 Proxy），写入临时 `.mjs` 并**真实 `import()` 加载**；再断言 leader 行、JSON 引号、无 `{{`，并做注入攻击测试。

### 实际结果（临时脚本，跑完即删）
```
ALL V2 CHECKS PASSED
  ok  {backend,frontend,fullstack}[+override]: module loads and evaluates
  ok  {backend,frontend,fullstack}[+override]: default export carries a leader
  ok  {backend,frontend,fullstack}[+override]: no double-brace '{{' in output
  ok  injection: projectName JSON-quoted
  ok  injection: override model JSON-quoted
  ok  injection: evil projectName loaded verbatim (no code executed)
```
注入用恶意值 `projectName='a"b\c`);process.exit(1);//'`、`model='x"); process.exit(1); ("'`，生成结果为：
```
  name: "a\"b\\c`);process.exit(1);//",
  leader: agents.leader({ model: "x\"); process.exit(1); (\"" }),
```
→ 均被 `JSON.stringify` 转义，加载后 `projectName` 原样还原、**无代码执行**。

**工程师关于「规格外 bug」的声称——已独立证实为真**：
```
OLD -> agents.architect({ { dependsOn: ["product-manager"] }, model: "opus" })   ← 非法 TS
NEW -> agents.architect({ dependsOn: ["product-manager"], model: "opus" })       ← 合法
```
（旧 `slice(id.length+8,-1)` 保留花括号，再包一层 `{ }` → 双花括号。）

> 备注：本脚本初版因我自己的 stub 对 `agents.leader()`（无参）返回 `undefined` 而误报 3 条 FAIL，修正 stub 后全绿——**是我的测试 bug，非源码问题**。

---

## V3 —— 测试是否被削弱（防橡皮图章）

### 方法
`git diff` 所有被改动的测试文件；全仓 grep 跳过标记；逐行比对关键用例。

### 实际结果
- **无任何跳过**：`it.skip|it.todo|describe.skip|xit|xdescribe|.only|it.fails` 全仓 **0 命中**（唯一命中是 `process.exit`/`spyOnExit` 业务代码，非跳过）。
- **测试 diff 纯新增，0 删除**：
  ```
  121  0  packages/core/src/orchestrator/Orchestrator.run.test.ts
   46  0  packages/dashboard/src/tui/components.test.tsx
  (no deletions)
  ```
- **「status 与 elapsed 之间空格」用例与 HEAD 逐字节一致**：
  ```
  $ diff <(git show HEAD:.../components.test.tsx | grep -A5 "puts a space between") \
         <(grep -A5 "puts a space between" .../components.test.tsx)
  IDENTICAL
  ```
- **`withTaskTitle()` 的必要性 = 既有行为，非本次回归**：`packages/dashboard/src/tui/state.ts` **未被本次改动**（`git diff --stat` 为空）。`mergeStageAgents`（`state.ts:262`）本就把 `taskTitle: a.taskTitle` 写回；`midRun()` 的 `orchestration:start` STAGES 不带 taskTitle，故种子标题被清空——**改动前即如此**，helper 是合理补偿。

**结论：无断言被删除/放宽/跳过。**

---

## V4 —— dashboard 渲染

### 方法
读 `layout.ts` / `panels.tsx` 配对关系；用临时渲染测试验证「长标题下头部是否仍 1 行」、窄宽度下名字/时钟；核对无孤儿分隔符。

### 实际结果
- **头部/视口仍配对**：`layout.ts:169` `logViewport = Math.max(1, bodyHeight - 1)` 与 `panels.tsx:150` `viewport = Math.max(1, height - 1)` **均为 -1，未变**。
- **头部恒 1 行（P0 关注点）**——临时测试用超长标题 `"Design the authentication module and its persistence layer end to end"`，`height=8, width=99`：
  ```
  ✓ StreamPanel header stays exactly one line with a very long task title
      渲染 8 行；含 ▼ 的行恰好 1 行；超长标题被截断（frame 不含全文）；其余行无标题碎片
  ```
  结构为**单个** `<Text wrap="truncate-end">`，`truncate-end` 不会换行 → 不可能占 2 行。
- **无孤儿分隔符**：分隔符 ` · ` 位于条件内 `{agent.taskTitle ? <Text dim> · {agent.taskTitle}</Text> : null}`，缺失时不渲染；既有用例 `leaves no orphan separator…` 以「`·` 计数差 1」验证通过。
- **工程师偏离规格（单 Text vs 中间 Box）确实满足两个目标**：
  ```
  ✓ TeamRow keeps the agent name and truncates the long title      (width=30，含 "Architect"，行宽 ≤30)
  ✓ TeamRow keeps the elapsed clock right-aligned                  (行 trimEnd 后以 "4.2s" 结尾)
  ✓ StreamPanel keeps the live marker at the far right edge        (header.length===100，以 ▼ 结尾)
  ```
  → ① 名字优先保留、标题先让位 ✅；② 右侧耗时/标记仍右对齐 ✅。

---

## V5 —— 破坏性变更审查

- **`role?: "planner"` 可选字段**：全仓 `role` 消费方仅 `Orchestrator.isPlanner`。dashboard `AgentView` 用 `description`（非 `role`）；`doctor.ts` 无 `role/agents/AgentDefinition` 引用；`defineConfig` 为恒等函数（`defineConfig.ts:2` `return config`），**无严格 schema 校验**，未知字段自由透传。→ 无破坏。
- **`generateConfig` 导出未泄露为公开 API**：`packages/cli/src/lib.ts` 未 re-export；`packages/cli/src/index.ts` 未 re-export；`package.json` `exports` 仅 `"."` → `dist/lib.js`。属内部导出，可接受。
- **无新增裸键 / 无新增 `/` 命令**：`App.tsx` 与 `commands.ts` 本次**未改动**（git status），TUI `?` `/` 双裸键约束不受影响。

---

## V6 —— 全量质量门禁（自行执行）

| 门禁 | 命令 | 结果 |
|---|---|---|
| Lint | `pnpm lint` | ✅ `Checked 118 files … No fixes applied` |
| Build | `pnpm build` | ✅ core/dashboard/cli 均 `Build success` |
| Typecheck | `pnpm typecheck` | ✅ 3 包 `tsc --noEmit` 无错 |
| Test | `pnpm test` | ✅ core 284 / dashboard 283 / cli 55 = **622 passed** |
| Coverage | `pnpm test:coverage` | ✅ 见下，全部过线 |

**覆盖率（实测 vs 阈值）**：

| 包 | Stmts | Branch | Funcs | Lines | 阈值 | 结论 |
|---|---|---|---|---|---|---|
| core | 96.83 | 92.18 | 94.37 | 97.81 | 90/85/90/90 | ✅ |
| cli | 66.07 | 61.97 | 70.37 | 66.56 | 50/45/40/50 | ✅ |
| dashboard | 99.31 | 95.88 | 100 | 99.59 | 90/85/90/90 | ✅ |

**dist 新鲜度（关键：dashboard 测的是 core dist）**：先 `pnpm build` 再测；且验证后重建 core，`dist/index.js` 哈希**前后一致**：
```
dist hash before rebuild: 03e686c3eb83c3c6d126646ae17ba40731030e7c
dist hash after  rebuild: 03e686c3eb83c3c6d126646ae17ba40731030e7c
UNCHANGED -> dist was already built from final source
```
→ dashboard 集成测跑的是**含修复的** core 产物。**无任何失败被以「与本次改动无关」放过。**

---

## 遗留问题（P2）

**P2-1｜守卫的两个边界缺永久回归测试（非缺陷）**
`Orchestrator.run.test.ts` 新增 3 例，但未覆盖：
1. **planner 所在 stage 失败 → 不应用 plan**（`stageResults.some(success)` 为 false 分支）；
2. **多 planner → 只应用一次**（`planApplied` 语义）。

我以独立临时测试验证**二者行为均正确**（见 V1），但提交套件缺这两条断言，未来若有人删掉 `stageResults.some(...)` 或 `!planApplied` 不会被 CI 拦住。**建议补为永久用例。**

**P2-2｜理论边界（观察项，非缺陷）**
守卫用 `stageResults.some(r => r.status === "success")`，语义是「该 stage 有任一成功」，而非「planner 本人成功」。若 planner 与某非 planner 同 stage、planner 先写入 `task-plan.json` 后失败、而同 stage 他人成功，则该 plan 仍会被应用。实际影响极小：`run()` 开头 `clearStaleTaskPlan()`（`:43`）已清除上轮残留，只有「本轮 planner 写了文件又失败」才触发。**仅记录，不建议本批修改。**

---

## 附：验证过程中对源码的临时改动与恢复

| 文件 | 改动 | 恢复 |
|---|---|---|
| `packages/core/src/orchestrator/Orchestrator.ts` | 临时把守卫改回旧版（`i===0 && …id==="architect"`）以证伪 V1.2 | ✅ 已用备份恢复，`shasum` 一致（`47bf18c6…`），`git diff --stat` 仍为 `23 insertions(+), 3 deletions(-)` |
| 临时脚本/测试（3 个） | `packages/cli/verify-genconfig.mts`、`core/src/orchestrator/qa-verify.test.ts`、`dashboard/src/tui/qa-verify.test.tsx` | ✅ 全部删除 |

最终 `git status` 与初始一致（7 个 modified + `init.test.ts` 等 untracked）。**未 commit。未改动业务源码（仅上述已恢复的临时改动）。**
