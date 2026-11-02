# dsh-superagent 与 multiclaw 深度对比 + 可借鉴点

> 当前源码复核与建议修正见 [2026-11-02 编排对比](orchestration-comparison-2026-11-02.md)。本文保留为早期分析，其中 prompt 指纹、已读回执、权限解析、retry、TUI 续接与 dry-run 的建议以新文档为准。

> 依据：`deepseek-ai/dsh-superagent-prototype`（v0.1.0，MIT，2026-10-31）的 `docs/000–007`、`prompts/*`，以及源码 `src/core/{model,engine,tickets,intake,assignments}.ts`、`src/app/sessions.ts`、`src/policy.ts`、`src/executor/{dsh,background}.ts`。multiclaw 侧依据 `packages/core/src/{orchestrator/Orchestrator,orchestrator/AgentRunner,orchestrator/AgentSessionManager,agents/leader,config/permissionMode}.ts` 与项目记忆。
>
> 一句话：**dsh 是"常驻服务 + 领域模型（Ticket）+ 事件驱动"的自主 Agent；multiclaw 是"人驱动 + 一轮编排（leader→stages）+ 结果信封"的 CLI/TUI 编排器。** 两者同源（编排者轻/执行者重、授权与执行分离），但 dsh 在"长期存活 / 持久化 / 精细状态机"上更彻底，multiclaw 在"交互式权限 / 单需求多 agent 协同 / 工程化"上更成熟。

> **范围声明（重要）**：multiclaw 的主线是**编排**，暂不引入 GitHub / 飞书等外部组件。因此本文**只把 dsh 当作编排内部机制的参照**：`Source / Trigger / Thread / Subscription / Channel`、GitHub/飞书接入、`git worktree` prepare、事件驱动 intake 等一律**不作为借鉴对象**，仅在第 2–3 节作为背景说明。第 8 节的可借鉴点已按此过滤，全部落在"编排 / 会话 / 权限 / 并发 / 状态机"内部。

---

## 1. 定位与形态

| 维度 | dsh-superagent | multiclaw |
|---|---|---|
| 形态 | 常驻进程（DeepSeek Harness 插件），7×24 在线 | CLI `run` / TUI `tui`，按需启动 |
| 触发 | 事件驱动：GitHub（通知/Issue/PR/CI）、飞书；人 @ 才接活 | 人驱动：一条 requirement 启动一轮 |
| 核心原则 | "尽可能少占用人注意力"；只在被请求或规则允许时行动 | 人主导对齐；交互式权限让人拍板 |
| 交付 | 回原对话（PR/评论/飞书）；面板只列"待人工决定" | 终端 TUI 实时展示；产物落 `workDir` |
| 成熟度 | 研究原型，官方明确非正式产品 | 工程化（覆盖率门槛/CI/trusted publisher） |

**本质差异**：dsh 把"全局连续性 + 并发执行"做成系统能力；multiclaw 把"一轮需求内多 agent 分工"做成可交互的编排。

---

## 2. 编排模型（源码对照）

### dsh：领域模型驱动
`Engine`（`src/core/engine.ts`）是**单一事务入口**，把 `Intake / Evals / Tickets / Assignments / Replies` 组合起来，对外只暴露角色化 `Pick` 接口（`EngineForSources / EngineForMainSession / EngineForExecutor / EngineForPeople`）。核心概念（`src/core/model.ts`）：
- `Trigger → Thread → Eval → Decision → Mandate → Ticket → Assignment → Executor → Channel`。
- **Ticket 自己定义状态，不跟随 Session**（`model.ts` 注释明确："A Ticket can be handed off, resumed, or run by several Executors, so it defines its own state"）。
- **Eval 无状态**：输入是 Trigger 批 + Thread 快照 + 该 Thread 上所有 Ticket + 当前 Policy，输出 Decision。
- **Assignment 是 Ticket↔Executor 的绑定**，独立于 Ticket 生命周期，`pending → running → ended`。

### multiclaw：一轮编排驱动
- `Orchestrator.run()`：`resolveTurn`（leader 三态 run/reply/ask）→ `selectAgents`（只减不增，未知 id 丢弃并告警）→ `buildStages`（按 `dependsOn` 拓扑排序）→ `runStage`（`maxConcurrency` 槽位补位，不是固定分批）→ 可选 `reviewDelivery`（reviewer + repair 循环）→ `OrchestratorResult` 信封。
- `AgentRunner`：`resolveModel / resolvePermissionMode / withRetry / withTimeout / AgentSessionManager.execute`，事件走 `EventBus`。
- **没有持久领域模型**：一次 `run` 就是一个需求的生命周期；跨轮只靠 `history: TurnRecord[]` 与 `report.json`。

**对照结论**：dsh 是"以 Ticket 为中心、Session 可换"；multiclaw 是"以 turn 为中心、agent 为角色"。dsh 的 `Assignment` 与 multiclaw 的"一次 agent 执行"最接近，但 dsh 把它做成一等对象（可 retry/restart/resume 而不动 Ticket）。

---

## 3. 会话与恢复（这是差距最实质的地方）

### dsh 的机制（源码级）
- **Session 身份与内容解耦**：`Sessions.ensure(id, cwd, title, role)` 按 `worker-<ticketId>` 解析或创建；prompt 通过 `agent.ctx.systemPrompt.section(...)` 动态注入（`sessions.ts:244`），**改提示词不换 Session**。每个 Session 记录它跑过的 prompt revision（`KV.sessions.prompts`，`mayRead` 授权读）。
- **delivered ≠ read**：`TicketInput` 有 `readAt`（`null`=已送达未读，时间戳=已被 Session 取入一步）与 `deliveredTo`；`Engine.inputsRead` 在 `session/event` 的 `user/message` 时标记（`dsh.ts:495`）。这让"进程被杀时哪些消息真被消费"可判定。
- **retry = 新 Assignment，同 Session/目录/branch/PR**：`Tickets.retry` 结束旧 Assignment、`requeueUntaken` 把被 cancel 丢掉的输入放回、再 `newAssignment` + `executor.start`（`tickets.ts:168`）。
- **restart 注入 recovery note**：`Assignments.interrupted` 用 `RECOVERY_NOTE`（"host restarted... inspect worktree, git history and GitHub before continuing; do not repeat a completed external operation"）重启（`assignments.ts:21,83`）。
- **先存后做**：`Effects.enqueue` 把 relay/notice/launch/delivery 持久化后按序执行，失败 2s→翻倍至 1min 重试；relay/notice 保序（`sessions.ts:104`）。
- **ended Ticket 用人消息 resume**：不做新 Eval、不新开授权，仅 `revalidate(mandate)` 通过即可（`tickets.ts:252 wake`）。

### multiclaw 的现状
- `AgentSessionManager` 用 **fingerprint**（含 `systemPrompt`！）判断复用；**systemPrompt 一变就 close 旧 Session 再开新的**（`AgentSessionManager.ts:46-71`）。这是与 dsh 最大的设计分歧：dsh 把 prompt 当"可热更新的 section"，multiclaw 把 prompt 当"Session 身份的一部分"。
- `supplement(text)` 把消息**广播给所有 running 的 Session**（`AgentSessionManager.ts:180`），没有"这条消息归哪个 agent"的判定。
- `/retry` 对失败 agent **冷启动**（失败无 sessionId）；`/replay` 整轮重跑；批处理 `run --resume` 走 `report.json` 的 `sessionId → session/load`；TUI 只恢复边界（`console/session.json`），不续会话、不注入 recovery note。

**对照结论**：multiclaw 的恢复是"边界级 + 可选会话续接"；dsh 是"Assignment 级 + 输入级 + 提示词级"三层都持久。dsh 的 `readAt/deliveredTo` 与"prompt 与 Session 解耦"是两条最值得搬的机制。

---

## 4. 权限模型

| 维度 | dsh | multiclaw |
|---|---|---|
| 粒度 | **谁可以发起工作 + 授权范围**（Mandate/Policy） | **单条工具请求**（auto/ask/deny） |
| 结构 | 两层 gate（程序层 Fast Path + 语义层 Slow Path）+ admission table + strength（explicit/inferred）+ accept mode（off/observe/auto） | 三模式；`resolvePermissionMode` 三层回退（agent > 项目 > defaults） |
| 版本化 | `policyVersion` 哈希；Mandate 记录依赖版本；resume 时 `revalidate` | 静态 `permissionMode`，跨轮不重校验 |
| 诚实声明 | worker `danger-full-access` 跑在 operator OS 用户；wrappers 不是安全边界 | `auto` 不是沙箱，Bash 照样能 rm；拒绝发 `permission_rejected` |

**对照结论**：两者都把"授权"和"执行"分开，也都承认工具包装不是安全边界。差异在粒度与**版本化**：dsh 的 `revalidate`（resume 时重校验授权是否仍成立）是 multiclaw 目前缺的；multiclaw 的交互式三态更贴合人在终端拍板的场景。

---

## 5. 工作区 / 并发 / 异步

- **dsh**：每 Ticket 一个目录（`<stateDir>/work/<name>`）+ `prepare` 命令（`git worktree`，10min 超时，失败不自动重试）；`WorkerSlots` 并发上限 + **额外 1 个 slot 专给人消息**（`dsh.ts:171`，`reserve(..., 'person')` 可超 `max+1`）；前台 shell 5s 转后台 job，turn 结束后后台最多 30min，job 完成唤醒同一 slot。
- **multiclaw**：`run` 每次 `workDir/.multiclaw/runs/run-<stamp>/`；控制台每轮共用 `config.workDir`；`maxConcurrency` 槽位补位；**ACP 单 turn 阻塞**，无"命令后台跑、下一步还能接新指令"的模型。

**对照结论**：dsh 的"人优先 slot"和"turn 结束后后台继续"是 multiclaw 没有的两块；multiclaw 的 `supplement` 是异步接收消息的雏形，但没有队列与 owner 判定。

---

## 6. 失败处理

| 维度 | dsh | multiclaw |
|---|---|---|
| 状态机 | Report：progress/waiting/ready/blocked/failed/dropped；stage 显式区分 `person/*` vs `working/*` vs `idle` | 轮内 success/failed/cancelled；`/retry` 重跑失败者 |
| 瞬时失败 | 408/429/5xx/连接重置 → 3 次递增 backoff | `withRetry` + `isPermanent` 快速失败 |
| 重启 | recovery note + 最老 Ticket 先恢复 + 先存后做 | 批处理 `session/load`；TUI 边界恢复 |
| 巡检 | 独立 Watchdog 会话判断无效循环 | 人在场即巡检 |

---

## 7. 两者各自的优势（避免盲目照搬）

**multiclaw 更成熟的**：交互式权限三态（fail-closed + 统一 `permission_rejected`）、fingerprint 会话复用 + `/retry` 冷启动语义 + `describeResumePlan` 透明说明、`supplement` 的 mid-turn steering、工程化纪律（覆盖率/CI/不变量断言）。

**dsh 更成熟的**：领域模型与事务边界、Assignment 生命周期、输入级已读追踪、prompt 与 Session 解耦、Policy 版本化、人优先并发槽、后台 job 模型。

---

## 8. 可借鉴点（重点，已按"只做编排"过滤）

> 每条给出：dsh 的做法（证据）→ multiclaw 现状 → 建议落地方式 → 预估成本。**全部是编排内部机制，不涉及任何外部组件。** P0 是低风险高收益，P2 是架构级。

### P0-1. 把 `systemPrompt` 从 Session 指纹里拿出来（prompt 与 Session 解耦）
- **dsh**：prompt 是 `systemPrompt.section(...)` 动态注入，Session 身份只由 id/目录决定；改 prompt 只重绑 section，不换 Session（`sessions.ts:244-249`）。
- **multiclaw**：`AgentSessionManager` 的 fingerprint 含 `systemPrompt`，**任何提示词微调都会 close 会话**，丢掉上下文（`AgentSessionManager.ts:46`）。
- **落地**：fingerprint 只保留 `command/args/model/workDir/sessionId/resume/onQuestion`；systemPrompt 改为可热更新的 section（或至少在 prompt 变化时用 `session/load` 续接而非冷启动）。**这是投入产出比最高的一条。**
- **成本**：中（要改 ACP 侧的 session 复用判定与测试）。

### P0-2. 引入"已送达 / 已读"区分（`readAt` / `deliveredTo`）
- **dsh**：`TicketInput.readAt`（`null`=送达未读）+ `deliveredTo`；`inputsRead` 在 Session 真正把消息取入一步时标记（`model.ts:235-248`，`dsh.ts:495`）。崩溃/重启时能精确知道哪些消息被消费。
- **multiclaw**：`supplement` 只报告 `injected/idle/unsupported/error`，不记录"是否被 agent 真正取入 turn"；TUI 重启后无法判断 mid-turn 消息是否已消费。
- **落地**：给 `SupplementReport` 增加 `readAt`（由 runtime 在 turn step 边界回调），或在 `console/session.json` 里记录每条注入消息的 `claimedAt`。TUI restore 时据此决定是否重放。
- **成本**：中。

### P0-3. resume/retry 注入 recovery note
- **dsh**：`RECOVERY_NOTE` 明确要求"先查 worktree / git 历史 / GitHub，再重复外部动作"（`assignments.ts:21`）。
- **multiclaw**：TUI restore 只把 inFlight 标 `interrupted`，不给 agent 任何"你被打断过"的提示；`/retry` 冷启动也不带上下文说明。
- **落地**：`/retry` 与 TUI 恢复时，在 agent prompt 前注入一段 recovery 说明，文案适配为"先检查工作区与 git 历史，不要重复已完成的本地操作"（不涉及任何外部平台）；`describeResumePlan` 已能描述冷启动，可把该说明一并写进 prompt。
- **成本**：低（纯 prompt 拼接）。

### P0-4. resume 时重校验权限模式
- **dsh**：`policy.revalidate(mandate)` 在 resume 前重跑（`policy.ts:213`）；Policy 版本变化会生成 `PolicyEffect` 发给 Ticket。
- **multiclaw**：`permissionMode` 静态，resume/`/replay` 不重校验配置是否已从 `ask` 变 `deny` 等。
- **落地**：resume 前重新 `resolvePermissionMode(config, agent)`，与上次记录比较；变化时在 TUI 提示"权限模式已变（ask→deny），是否继续"。
- **成本**：低。

### P1-5. 人优先并发槽（maxWorkers + 1 for person）
- **dsh**：`WorkerSlots.reserve(ticketId, 'person')` 可超 `max+1`，保证人的消息永远不被新任务堵住（`dsh.ts:192`）。
- **multiclaw**：`maxConcurrency` 无保留槽；TUI 里用户中途追加消息可能排在后续 stage 之后。
- **落地**：`runStage` 的槽位调度区分"用户发起"与"流水线发起"，为用户保留 1 个槽（或至少让 supplement 触发的 continuation 优先）。
- **成本**：中。

### P1-6. mid-turn 消息按"归属 agent"路由，而非广播
- **dsh**：`followupOwners` 精确算出"这条人消息归哪个 Ticket 的 worker 决定"（`model.ts:75`），不属于任何 Ticket 才进 Eval。**注意：我们只借它的"归属判定"思路，不引入 Thread/Subscription 概念。**
- **multiclaw**：`supplement(text)` 广播给**所有** running Session（`AgentSessionManager.ts:180`），可能造成重复处理。
- **落地**：给 `supplement` 增加可选的 `targetAgentId`；TUI 里由用户指定，或按"该 agent 当前任务/最近输出"推断；默认仍广播，定向时只发给目标 agent。归属判定完全在编排层完成，不依赖外部事件源。
- **成本**：中。

### P1-7. 把 TUI 状态机做成显式 stage（person/answer、person/review、blocked、idle…）
- **dsh**：`Ticket` stage 由 Report 推导，第一匹配行胜出（`003-execution.md` 表格）；`person/*` 明确"卡在人"，`idle` 明确"等 Trigger"。
- **multiclaw**：TUI 显示 running/complete/failed/skipped，缺"等人回答 / 等人 review / 阻塞 / 空闲"的区分。
- **落地**：在 `App` 的 agent 视图里增加 `awaiting-answer`（有 pending `onQuestion`）、`awaiting-review`（有未处理的 review 请求）、`blocked` 三态；面板只优先列"等人"的。
- **成本**：中（偏 UI/状态推导）。

### P2-8. Assignment 作为一等对象（retry 不丢 Session）
- **dsh**：retry = 结束旧 Assignment + 新 Assignment，**同 Session/目录**（`tickets.ts:168`）；失败 turn 仍保留 Session，人可继续。
- **multiclaw**：`/retry` 对失败 agent 冷启动（失败无 sessionId），等于丢上下文。
- **落地**：区分"turn 失败"与"agent 不可用"；turn 失败时保留 Session，retry 走同一 Session + recovery note（与 P0-3 联动）。
- **成本**：高（涉及 ACP 失败语义与 sessionId 保留策略）。

### P2-9. 先存后做（durable effects）
- **dsh**：决策后动作先入 `Effects` 队列再执行，保序 + backoff（`sessions.ts:104`，`effects.ts`）。
- **multiclaw**：TUI 只写 `session.json` 边界；side effect（写 report、发通知）不持久化。
- **落地**：对 CLI 可能过重；可先在 `report.json` 落"待执行动作"，重启后补跑，作为轻量版。
- **成本**：高（架构级）。

### P2-10. `observe` 模式（只记录不执行）作为 dry-run
- **dsh**：accept mode `observe` 默认，inferred 候选只记 `would_accept`（`policy.ts:55`）。
- **multiclaw**：有 `preview()` 但不记录"本来会跑谁"。
- **落地**：`multiclaw preview`/`--dry-run` 输出 leader 的路由决策与将运行的 stages，不真正执行；可复用 `orchestration:start` 事件。
- **成本**：低（已有 `preview` 基础）。

---

## 9. 不建议照搬的

- **整套 Source / Trigger / Thread / Subscription / Channel 域模型**：这是为"常驻、从外部事件源收活"设计的。multiclaw 主线是编排、人驱动，引入它会把简单问题复杂化。只借"消息归属判定"（P1-6）这一条思想即可。
- **GitHub / 飞书接入、`git worktree` prepare、事件轮询**：明确不在当前范围，属于外部组件。
- **按工具名白名单（`tools[]`）**：multiclaw 已在 2026-11-02 明确删除，转向 auto/ask/deny；dsh 的 `WORK_TOOLS` 是另一种取舍，两者都承认不是安全边界。不必回退。
- **Watchdog 独立会话**：multiclaw 有人在场，巡检成本收益不划算。
- **常驻进程 / 7×24 在线**：与 CLI/TUI 按需启动的形态冲突，不采纳。

---

## 附 A：术语对照

| dsh | multiclaw | 含义 |
|---|---|---|
| Main Session / orchestrator / Router | leader | 编排者 |
| Executor Session / worker | agent（preset） | 执行者 |
| Ticket | 一轮编排内的 agent 任务 / stage | 授权工作单元 |
| Assignment | 一次 agent 执行（run/retry 的实例） | 执行绑定 |
| Mandate | permissionMode + 任务授权范围 | 授权 |
| Subscription / Thread | supplement（mid-turn 注入） | 后续消息直达 |
| Eval / Decision | leader 的 resolveTurn / OrchestratorResult | 判定与结果 |
| Policy（admission/accept mode） | permissions / defaults.permissions | 谁能发起、怎么做 |
| stored work / 先存后做 | console/session.json 边界恢复 | 持久化容错 |
| Attention / person stage | onQuestion | 显式等人决策 |

## 附 B：关键源码索引

| 关注点 | dsh 文件 | multiclaw 文件 |
|---|---|---|
| 领域模型 | `src/core/model.ts` | `packages/core/src/types/{agent,config,runtime}.ts` |
| 事务入口 | `src/core/engine.ts` | `orchestrator/Orchestrator.ts` |
| Ticket 生命周期 | `src/core/tickets.ts` | （无对应；见 `Orchestrator.run`） |
| Assignment | `src/core/assignments.ts` | `orchestrator/AgentRunner.ts` |
| Session 管理 | `src/app/sessions.ts` | `orchestrator/AgentSessionManager.ts` |
| 权限/策略 | `src/policy.ts` | `config/permissionMode.ts` |
| 执行器/并发 | `src/executor/dsh.ts`、`background.ts` | `Orchestrator.runStage` |
| 编排提示词 | `prompts/{orchestrator,worker,dispatch,handoff}.md` | `agents/leader.ts` + preset agents |
