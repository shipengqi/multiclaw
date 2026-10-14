# Batch 3「续跑」实施计划

> 作者决策（产品 review Q3）：**`run --resume` 与 TUI `/retry <id>` 两者都做**。
> 本批同时落地架构评审 C6（ACP `session/load` 接线 —— 代码早已实现，只是没人传 `sessionId`）。

## 0. 前置探测结论（已从 bridge 源码查实，非推测）

原以为要真机才能定的边界，读 `node_modules` 里的 bridge 产物即可确认：

| Provider | `agentCapabilities.loadSession` | 证据 |
|---|---|---|
| **claude**（`claude-agent-acp@0.89.1`） | `true` | `dist/acp-agent.js:1404`（initialize 响应）+ `loadSession()` 实现在 `:1511`，注册于 `methods.agent.session.load`（`:9067`） |
| **codex**（`codex-acp@2.2.2`） | `true` | `dist/index.js:42456`（initialize 响应）+ `loadSession()` 实现在 `:43049`；另有更新的 `session/resume`（`:43091`） |
| opencode / cursor | 未验证 | cursor 未安装；opencode 原生 ACP 未实测 |

→ `AcpRuntime.ts:563` 的准入守卫（`init.agentCapabilities?.loadSession !== true` 才拒绝）对 claude / codex **会放行**，续跑路径可达。**这是本批能开工的依据。**

## 1. 设计边界（三条硬约束 + 一条刻意裁剪）

1. **`AgentRuntime` 接口不加宽**（已发布导出）—— 本批只动 `AgentTask` 入参（已有 `sessionId?`）与 `AgentOutput`（已有 `sessionId?`），零接口变更。
2. **core 不引入 session 概念** —— 会话状态由调用方带入，沿用 `history` 的既有先例：`MultiClawConfig.resume`。
3. **TUI 不新增裸键** —— `/retry` 是 `/` 命令。
4. **刻意裁剪：只在「成功路径」捕获 `sessionId`**。ACP 只在完成的 turn 上回传 session id（`AcpRuntime.ts:649` 在 `settleResolve` 里），失败路径拿不到。**不给失败路径新造通道**，理由：① 需加宽已发布的 `RuntimeEvent` union；② 一个死掉的 turn 未必有可复用的持久会话，硬续可能让「重试」反而因为 `session/load` 失败而更糟。**代价（如实记录）**：`/retry <id>` 重跑一个**失败**的 agent 时无会话可续 → 冷启动；续跑真正省下的是**已成功** agent 的重复探索。

## 2. 改动清单

### core

**B3-1 `AgentResult.sessionId?`**（`types/agent.ts`）
```ts
/** Session the runtime ran under, when it reported one. */
sessionId?: string
```

**B3-2 `MultiClawConfig.resume?`**（`types/config.ts`）
```ts
/**
 * Re-run a known set of agents instead of letting the leader route, continuing
 * their sessions where one is known.
 *
 * Set by a resume/retry driver — the CLI's `--resume`, the console's `/retry` —
 * which already knows which agents to redo. Like `history`, it is per-run state
 * the caller carries: core has no session of its own, and a config that never
 * resumes leaves it unset and behaves exactly as before.
 */
resume?: {
  /** Agent ids to run, in the order they were originally selected. */
  agents: string[]
  /** agentId → session id, for agents whose session is worth continuing. */
  sessions?: Record<string, string>
}
```

**B3-3 `OrchestratorResult.requirement?`**（`types/config.ts`）
`report.json` 就是 `orchestration:complete` 的 payload，而 requirement 此前只在 `orchestration:start` 里发过 → **续跑读不到原始需求**。按约定「新结果字段优先挂 `OrchestratorResult`」补上，`run --resume` 才能从 report 恢复需求。

**B3-4 `AgentRunner`**（`orchestrator/AgentRunner.ts`）
- 传 `sessionId: this.config.resume?.sessions?.[agent.id]` 给 `runtime.execute`。
- 成功路径把 `completed.sessionId` 写进 `AgentResult.sessionId`（失败路径不写）。

**B3-5 `Orchestrator.resolveTurn`**（`orchestrator/Orchestrator.ts`）
leader 分支**之前**插入：
```ts
// A resume/retry already knows who runs: re-deciding with the leader would
// re-route the turn and could pick a different team than the one being resumed.
if (this.config.resume) return { kind: "run", agents: this.selectAgents(this.config.resume.agents) }
```
复用 `selectAgents` —— 它已经负责未知 id 告警、`agent:skipped` 发射、以及**剔除不在集合内的 `dependsOn`**（单 agent retry 的依赖正好因此被清空，无需另写逻辑）。
`run()` 组装结果时带上 `requirement: this.config.context?.requirement`。

### cli

**B3-6 新文件 `commands/resume.ts`**（纯函数，可测）
- `resolveRunDir(runsRoot, target)`：`target` 为 `"latest"`/`true` → 取 `runsRoot` 下 `run-*` 里**名字最大**的（stamp 定宽 ISO，字典序=时间序，确定性、可测）；否则按路径解析（允许指向 run 目录本身或其 `logs/`）。
- `readReport(runDir)`：读 `<runDir>/logs/report.json` → `OrchestratorResult`；缺失/坏 JSON → 抛可读错误。
- `resumeOptionsFromReport(report, requirementOverride)` → `{ requirement, resume }`：`agents` 取 `agentResults[].agentId`，`sessions` 只收**有 `sessionId`** 的项；无人有 session 时 `sessions` 缺省（不是空对象）。需求优先用 override，其次 `report.requirement`；两者皆无 → 抛错提示显式传需求。

**B3-7 `commands/run.ts` + `index.ts`**
- `run [requirement]`（位置参数改可选）+ `--resume [path]`（无值时 = `latest`）。
- 续跑分支：**先算 runsRoot（`config.workDir` 此时仍是项目目录），再覆盖** `config.workDir = runDir`（cwd 必须与原 run 一致，否则 `session/load` 的会话指纹变化会让桥重建会话）；`config.logDir = <runDir>/logs-resume-<stamp>`（**绝不复用 `logs/`**，否则覆盖原 `report.json`）；`config.resume`/`config.context.requirement` 由 `resumeOptionsFromReport` 填。
- 打印一行 `Resuming <runDir> (<n> agents)`。

### dashboard

**B3-8 `state.ts`**：`AgentView.sessionId?`；`agent:complete`/`agent:failed` reducer 从 `result.sessionId` 拷入。`snapshot()` **无需改**（`agents` 整体带过）。`TurnView` 无需改。

**B3-9 `commands.ts`**：`{ name: "retry", args: "[id]", description: "Re-run a failed agent (or all of them)", availability: "idle" }`。

**B3-10 `App.tsx`**
- `startTurn(requirement, opts?: { resume?: MultiClawConfig["resume"] })`，`runConfig` 里带 `...(opts?.resume ? { resume: opts.resume } : {})`。
- `case "retry"`：作用于 `state`（最后一轮），要求 `phase === "complete"` 且有 `requirement`；无参数 → 取 `status === "failed"` 的 agent；有参数 → 该 id（未知 id 报错）；`sessions` 只收有 `sessionId` 的；全无失败 → notice `nothing failed`；空 → notice。

## 3. 验收

- `pnpm lint` / `build` / `typecheck` / `test` / `test:coverage` 全绿（core 90/85/90/90、cli 50/45/40/50、dashboard 90/85/90/90）。
- 每条回归测试做「临时回退 → 确认变红 → 恢复」。
- 关键不变量：**不设 `resume` 时行为与今天逐字节一致**（leader 照常路由）；`resume.sessions` 缺省时 `AgentTask.sessionId` 为 `undefined`（不误传空串）；`--resume` 不覆盖原 `report.json`。
- 不 commit，改动留在工作区。

## 4. 本批不做

- cursor / opencode 的真机续跑验证（环境不具备）——保持「未验证」标注。
- 失败路径的 session id 捕获（见 §1.4 裁剪）。
- 续跑时的 task-plan 复原（重跑 architect 会重新写 plan；单 agent retry 走默认 `agentScope`/`agentPlan` 兜底）——如实记录为降级。
