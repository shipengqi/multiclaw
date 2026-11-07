# 聚焦编排：multiclaw 可以向 dsh-superagent 借鉴什么

日期：2026-11-02。依据两个本地项目当前源码、docs、graft 卡片和 codegraph 调用图。本文是设计评估，建议尚未实现；未运行真实 provider 或测试，不据此判断整体可靠性或成熟度。

## 判断

**借任务连续性、消息归属与状态一致性，保留 multiclaw 的 ACP 多 provider、DAG 分工和人在场的交互方式。**

dsh 面向长期处理外部请求的自主工作系统；multiclaw 面向用户启动的一轮需求内多 agent 协作。dsh 的许多复杂度来自外部事件、授权策略与交付渠道，不是编排的必要条件。无需引入整套 Ticket / Trigger / Thread 模型。

## 当前能力对照

| 维度 | dsh-superagent | multiclaw | 取舍 |
| --- | --- | --- | --- |
| 调度 | Ticket 的 Assignment；多个工作单元并发 | leader 选团队、planner 可更新任务与依赖、按 stage 执行 | 保留 DAG，补足任务与执行尝试身份 |
| 角色 | 主会话路由，worker 自己调查、实现、验证 | leader 路由、architect 规划、开发/测试/reviewer 分工 | 不必复制其提示词或合并角色 |
| 连续性 | Ticket、Assignment、Session 分开 | agent 定义、AgentResult、控制台 turn 与 live session | 明确关联同一任务的多次执行 |
| 后续输入 | 归属任务；上下文 note 与请求分开；可 handback | supplement 发给所有 running session；全部未注入时转下一轮队列 | 优先定向投递与消息事实记录 |
| 结果与等待 | report 驱动 person / working / idle 分类 | 执行结果、验收结果、问题/权限交互、checkpoint 已存在 | 汇总等待原因，复用既有事实 |
| 恢复 | Assignment 恢复、未读输入重投、recovery note | 成功 session 可续接；进行中 turn 恢复为 interrupted；队列暂停恢复 | 先改善恢复上下文与执行记录 |
| 持久化 | 领域变更事务提交，effects 先存后执行 | core 驱动流程，TUI journal/history 与 CLI report 保存状态 | 先做共用记录，再考虑 durable effects |
| 运行时 | DSH Session、inbox、持久化、后台 job 事件 | ACP 与 provider 能力协商 | DSH 内部能力不能视为 ACP 通用保证 |

multiclaw 已有 DAG、槽位补位、范围/计划传递、checkpoint、review/repair、取消清理、会话历史和成本信息。reviewDelivery 已区分执行成功与验收批准，应保留这套反馈闭环。

## 第一批建议

### 1. 恢复说明：最小的独立改进

借鉴 Assignments.interrupted 的 recovery note，用于用户明确触发的 retry/resume，不自动唤醒中断任务。

提供原始需求、当前 scope、上次结束原因、可靠的已完成事实、最后错误，并说明此次是续接还是新建 session。让执行者先检查工作区与 git 状态，再继续未完成工作。失败的输出应标为部分结果，不能当成验证过的结论。

可复用 resume plan 与历史结果，不需要完整领域模型。它能减少重复工作，不能保证工具操作只执行一次。

### 2. 定向输入与投递记录：最直接的协作提升

借输入归属，不借 Thread/Subscription 体系。先允许显式指定一个 agent，保留明确的团队广播；不要默认增加一次模型调用猜归属。

当前 AgentSessionManager.supplement 广播给所有 running session。TUI 只有完全没有 agent 注入成功才排入下一轮，部分成功只记录成功者，不能表达指定收件人还待处理。

每条输入记录 messageId、所属 turn/task、目标、来源，以及每个目标的 queued / acknowledged / failed / unknown 状态。投递超时可能是结果不明，不能直接视为未送达并自动重发。协作事实与用户指令应区分：architect 的设计说明提供上下文，不自动扩张 developer 的任务或权限。

**ACP 当前 injected 表示投递确认，不证明模型已读或遵从。** dsh 的 readAt 依赖 inbox/session-history 事件；我们的 RuntimeSession 没有等价能力。先记录可观察事实，只有 provider 提供可靠关联回执时才增加 consumed。主机记录 messageId 本身也不能保证 provider 去重。

### 3. 轻量 Task/Attempt：编排内核的基础

借 Ticket/Assignment/Session 解耦思想，采用最小模型：

| 对象 | 职责 |
| --- | --- |
| AgentDefinition | 可复用角色、provider、模型、默认提示词 |
| Task | 本轮具体工作：稳定 id、scope、依赖、验收要求、所属 turn |
| Attempt | 一次执行：id、序号、sessionId、起止、结束原因、结果 |
| Session | provider 对话上下文，按能力复用或加载 |

AgentResult.attempts 是次数，repair 也会追加结果；它们不等同于有独立身份和关系的 Attempt。

先增加 taskId/attemptId 与失败时仍可靠可知的 sessionId，保持配置和结果格式兼容，再统一普通执行、retry、repair、resume 的记录规则。尝试失败不应覆盖任务历史；session 能否继续由真实 runtime 状态与能力决定。

让调度、输入归属、结果记录与恢复规则集中于 core 的 module。TUI 与 CLI 使用同一 interface，避免可靠性规则只存在于 App。先提取真正共用的行为，不增加纯转发的抽象层。

### 4. 状态推导：让用户知道卡在哪里

借 ticketStage，由事实推导状态，而不是各处手动赋值。分开执行生命周期、等待原因、验收结果。

复用现有权限请求、问题、checkpoint 与 review，汇总“等回答 / 等权限 / 等检查点 / 正在验收 / 依赖未满足 / 运行中 / 已结束”。同一推导供 TUI、CLI 报告、leader 历史上下文使用。

结构化 blocked/ready worker report 可后续评估，但需明确传输和校验契约，不能从自然语言猜确定状态。

## 后续评估

- **先存后做。** dsh Effects 与事务配合，按 key 去重、保序、重试，generation 避免旧执行删除新 payload。先持久化执行意图与结果，恢复时列出不明动作；需要自动恢复投递/启动时再引入队列。report.json 中增加待执行动作不等价于事务性 durable effects，更不能保证 agent 内部工具恰好执行一次。
- **用户输入优先。** dsh 提供额外一个 worker slot；我们的 steering 不需新槽。等 continuation 可独立调度后，先考虑在现有上限内提高优先级，不直接改变 maxConcurrency。
- **工作区策略。** dsh 每 Ticket 一个目录，multiclaw 控制台共享工作区、repair 已串行。先明确任务写入范围，需要隔离时再提供可选目录/worktree adapter，并同时设计汇合。worktree 属于编排隔离，不等于外部业务接入。
- **按依赖就绪调度。** runStage 内及时补槽，但 run 等整个 stage 结束才启动下一层。例如 A→C、B→D，A 快而 B 慢，C 仍等 B。可评估 ready queue，这是我们的 DAG 优化，不是 dsh 的现成方案。必须兼顾失败传播、planner 重建、checkpoint 与共享工作区写入约束。
- **摘要与按需展开。** 借主会话接收短摘要、按需读详情的方式，避免所有日志反复注入每个 agent。现有 upstreamOutputs 与历史预算是自然落点。

## 对早期对比结论的修正

以下结论修正早期 dsh-superagent 对比分析中的对应建议（该文已移除）：

1. **不直接删除 systemPrompt fingerprint。** systemPrompt 是 openSession 创建选项，RuntimeSession 无热更新 interface。dsh 动态 prompt section 不能直接移植；删除指纹可能沿用旧指令。
2. **不新增 resume 权限解析。** AgentRunner.run 已调用 resolvePermissionMode，当前模式与回调每次传入 session.prompt。Mandate revalidate 是授权范围校验，和工具权限模式不是同一层含义。
3. **readAt 不是低成本字段。** 当前 ACP interface 无可靠消费回执，不能制造已读事实。
4. **retry 不一定全部冷启动。** manager 保留仍可用的 session，关闭/创建失败时删除。失败结果缺 sessionId 影响跨进程续接，但进程内复用应单独评估。
5. **TUI 并非完全不能续会话。** continuationResume 在没有 live session 时使用已记录 sessionId；已完成 turn 的续接和中断进行中的执行不同。进行中 turn 仍按 interrupted 恢复。
6. **dry-run 已存在。** CLI 支持 --dry-run；dsh observe 针对长期事件 admission，与计划预览不同。
7. **不凭源码和测试数量判断成熟度。** 本次没有真实运行验证。

## 范围与实施顺序

不引入外部 Source、Trigger intake、订阅、外部回复 Outbox、自动合并、主动接活 Policy 的完整体系。常驻服务、后台 job、独立 watchdog 暂不作为必需能力。

建议顺序：**恢复说明 → 定向输入 → Task/Attempt 记录与状态推导 → 有真实需求再做持久队列与调度升级。**

## 源码入口

| 关注点 | dsh，相对于项目根目录 | multiclaw，相对于项目根目录 |
| --- | --- | --- |
| 任务与尝试 | src/core/model.ts；tickets.ts:168 | packages/core/src/types/agent.ts；orchestrator/AgentRunner.ts:31 |
| 恢复 | src/core/assignments.ts:83 | packages/dashboard/src/tui/session.ts:307；App.tsx:251 |
| 消息投递 | src/app/delivery.ts:66；core/tickets.ts:234 | packages/core/src/orchestrator/AgentSessionManager.ts:180；packages/dashboard/src/tui/App.tsx:1140 |
| 指纹与能力 | src/app/sessions.ts | packages/core/src/orchestrator/AgentSessionManager.ts:46；packages/core/src/types/runtime.ts:213；runtime/AcpRuntime.ts:839 |
| 状态推导 | src/core/stage.ts:9 | packages/dashboard/src/tui/state.ts；interaction.ts |
| 持久副作用 | src/app/effects.ts:61；core/engine.ts:160 | packages/dashboard/src/tui/session.ts；packages/cli/src/reporters/FileLogWriter.ts |
| 调度 | src/executor/dsh.ts:171 | packages/core/src/orchestrator/Orchestrator.ts:181、757；StageBuilder.ts:3 |
| 验收 | src/core/assignments.ts:99 | packages/core/src/orchestrator/Orchestrator.ts:376 |

表中同格省略目录的后续文件路径相对于前一个文件所在目录；明确重新写出 core/ 或 runtime/ 的路径相对于对应 src 目录。

graft 用于定位 module 与 interface，codegraph 核对当前源码与调用关系。部分 graft 行号落后于源码，本次判断以 codegraph 返回的当前源码为准。两个索引是分析工具，不构成运行时协调能力。
