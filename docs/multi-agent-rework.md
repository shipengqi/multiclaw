# 多 Agent 返工与验证

## 原先的断点

普通流水线只判断 Agent 是否成功结束，不解析报告里的 FAIL 或 Changes Required。原有 `review` 能在流水线末尾循环验收，但只有一个最终验收者；架构评审、UI 评审、测试不能各自阻止下游。最终返工也没有重新触发修改涉及的人类检查点。

## 现在的执行规则

`reviewGates` 为流水线中的任意 Agent 配置验收关卡。位置由该 Agent 的 `dependsOn` 决定。不通过时，按依赖顺序串行运行本次已选中的 `repairAgents`，传递完整需求、责任范围、问题清单和最新输出，再执行原验收者。通过后才执行后续阶段。

| 关卡 | 修复链路 | 修复后验证 |
| --- | --- | --- |
| 架构评审 | architect | 重新检查设计；更新尚未执行者的计划和范围 |
| UI 评审 | ui-designer | 重新检查 UI 设计 |
| 测试 | backend-developer → frontend-developer | tester 实际重测最新代码 |
| 代码评审 | backend-developer → frontend-developer → tester | tester 必须通过自己的关卡，再重新代码评审 |
| 自定义关卡 / 最终验收 | 配置中允许的修复者与验证者 | 重新验收；包含的关卡仍执行自己的返工机制 |

fullstack 配置示例（这些 ID 必须存在于 `agents` 中）：

```ts
reviewGates: [
  { reviewer: "arch-design-reviewer", repairAgents: ["architect"], maxRepairRounds: 3 },
  { reviewer: "ui-design-reviewer", repairAgents: ["ui-designer"], maxRepairRounds: 3 },
  {
    reviewer: "tester",
    repairAgents: ["backend-developer", "frontend-developer"],
    maxRepairRounds: 3,
  },
  {
    reviewer: "code-reviewer",
    repairAgents: ["backend-developer", "frontend-developer", "tester"],
    maxRepairRounds: 3,
  },
],
```

`review` 继续支持保留在流水线之外的最终验收者，可以和 `reviewGates` 一起使用。同一验收者不能同时配置两种策略。新生成的 backend、frontend、fullstack 配置和示例已启用相应关卡；已有配置需要加入 `reviewGates`。

验收者最终返回：

```json
{
  "verdict": "changes_required",
  "summary": "登录 API 返回了错误状态码",
  "issues": ["backend-developer: POST /login，错误密码返回 200，预期 401；附复现步骤、证据和修改方向"]
}
```

`approved` 必须没有未解决的阻塞问题；`changes_required` 必须包含具体问题。tester 的 FAIL / BLOCKED 均应返回 `changes_required`，说明失败证据或缺失条件。普通文字、无效 JSON、矛盾结论会阻止验收，进程退出 0 不等于通过。

## 预算、上下文与恢复

- 每个关卡独立计算修复轮数，默认 1，支持 0–5；新生成配置设为 3。首次验收不消耗修复轮数。
- 同一轮任务里，嵌套重测和交回 leader 后重新路由不会重置已消耗的预算。循环修复策略在启动前被拒绝。
- 只运行本次 leader / retry / resume 选中的修复者。没有可用修复者或预算耗尽时停止，`success: false`。`continueOnError` 不能绕过失败关卡。
- 共享工作目录和兼容的 Agent Session 被复用。提示词使用各 Agent 的最新有效输出；完整旧结果留在审计中，费用累计全部实际调用。
- 修复清单由配置定义，问题清单交给每位修复者在其责任范围内处理；不会根据 issue 文本自动选择负责人的路由器。需要重测的验证者应显式加入后续关卡的 `repairAgents`。
- 修改涉及的检查点重新触发并展示最新输出；取消停止后续修复与验收。检查点追加的需求反馈交给下一次验收。
- `gateResults` 保存每个流水线关卡的结论历史和预算；`acceptance` 给出决定本轮结果的验收状态。CLI 报告、交互界面历史及 Markdown 导出保留这些结果。
- `/retry tester` / CLI resume 保留流水线中的验收者；最终保留的 reviewer 仍由 `review` 自动运行。用户发起的新重试是新一轮任务，重新使用配置的预算。
- 生成配置让 DevOps 依赖 code-reviewer，等待测试和代码评审通过。

## 验证证据

| 测试文件 | 验证内容 |
| --- | --- |
| `packages/core/src/orchestrator/Orchestrator.run.test.ts` | 多角色返工、三轮耗尽、嵌套 tester 预算、无效结论、循环策略、选中团队限制、检查点输出与取消、最终验收重测、planner 范围与关卡顺序、阶段事件及费用 |
| `packages/core/src/orchestrator/Orchestrator.routing.test.ts` | 交回 leader、一次重新路由、预算保留、固定 retry/resume 团队限制 |
| `packages/cli/src/commands/init.rework.test.ts` | 生成 fullstack 配置 → 实际加载 → 修改后端/前端文件 → Node 子进程测试两轮失败 → 通过 → 代码评审退回 → 再修改和重测 → DevOps → 报告序列化与 resume |
| `packages/dashboard/src/tui/App.gates.test.tsx` | 交互界面执行到关卡失败 → `/retry tester` → 通过测试与代码评审 → 持久化与加载历史 → 导出多个 reviewer 的结果 |

测试运行真实编排器、配置加载器、Session 管理、事件流和交互界面；Agent 输出由可控 runtime 提供，CLI 集成测试额外实际写文件并执行 Node 命令。这验证确定性的编排链路，不代表已对真实 Claude / Codex 服务的模型行为做端到端验收。

```sh
pnpm -r build
pnpm -r typecheck
pnpm test
pnpm lint
```
