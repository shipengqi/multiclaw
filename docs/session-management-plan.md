# multiclaw Session 管理改进计划

状态：已按确认范围实现；开发阶段采用新记录格式，不提供旧字段、旧报告或旧历史的迁移兼容层。

## 目标

在已实现的 workId 路由、worker 交回和可选 planner 上，完善 Session 的状态、生命周期事件和恢复记录。让 continue、retry、repair、CLI resume 使用一致的判断规则，并准确解释执行者实际续接了什么。

本轮聚焦 Session 管理，不引入完整 Task/Attempt 台账、持久队列、后台服务、自动跨任务归属、消息投递台账或 systemPrompt 热更新。已有 DAG、checkpoint、review、权限、取消与一次交回重新路由规则继续使用。

## 已有能力与具体缺口

- AgentSessionManager 已按工作身份和运行时配置检查兼容性，支持共享 Session、关闭清理、加载已知 ID 和 mid-turn supplement。
- WorkContext 已保存工作 ID、完整需求、执行者范围、计划、依赖及可靠可知的 Session ID；TUI 历史和 journal 已能保存工作上下文。
- AgentRunner 的异常分支没有 Session 元数据。运行时返回错误时，即使 manager 仍持有可用 Session，历史结果也可能没有其 ID。
- Session 成功打开到执行结束之间缺少结构化绑定事件；进程在此期间退出，journal 可能缺少已经建立的 Session 信息。
- 新建和加载目前主要通过 warning 展示；复用、加载失败、兼容性变化、关闭和清理失败缺少统一的结构化记录。
- RuntimeSession 的 continuation 表示当前句柄可继续；RuntimeInfo.resume 是 adapter 的能力声明。两者不能单独证明某个 provider 已协商支持 session/load，也不能证明某个 ID 确实可恢复。
- describeResumePlan 根据是否有 ID 直接描述“continues its session”，实际加载前存在过早确认。

## 状态与数据约定

### 1. 分开记录执行结果、当前句柄状态和加载候选

执行结果继续使用 success / failed / cancelled / handed_back。执行失败或取消本身不决定 Session 是否失效。

当前句柄状态沿用 RuntimeSession 的 idle / running / cancelling / closing / closed。opening 由 manager 的创建过程表示，不要求所有 runtime 修改现有状态枚举。

持久记录保存“最后观察到的状态”，而不是宣称重启后该进程仍然存活。closed 表示运行时句柄结束，不等于 provider 已删除对话。记录的 Session ID 只能成为加载候选；只有加载返回成功才能报告已恢复。

### 2. 增加可选 SessionRecord

AgentResult 和 WorkContext 的执行者条目使用可选 session: SessionRecord；resume.sessions 使用 agent ID 到 SessionRecord 的映射。删除这些位置的独立 sessionId 和字符串映射，不保留双写或迁移分支。运行时协议中的 sessionId 仍表示 provider 返回或请求加载的 ID。

记录至少包含：

- workId、agentId、provider Session ID（只有实际获得后才填写）。
- host 生成的 bindingId，用于区分同一执行者先后建立的运行时绑定。
- runtime 标识、兼容性摘要、观测到的 continuation 与 load 能力。
- 最后观察的句柄状态与时间。
- 建立方式：created / loaded；每次执行另外记录 reused / loaded / created 等实际动作。
- 失效、加载失败或清理失败的结构化原因及必要说明。

leader 使用明确的 leader 所有者，不绑定 worker workId；reviewer 绑定当前工作，但其会话信息不能作为新修改已获验收的证据。

兼容性摘要复用现有检查项：runtime/provider、command/args、模型、有效工作目录、systemPrompt、协商所需的固定选项。工作身份独立校验，加载目标独立校验。持久摘要采用稳定 hash，不把原始提示词或命令参数复制进历史。保留 systemPrompt 检查，不用提示词版本号替代兼容性检查。

### 3. 区分运行时能力

RuntimeSession.capabilities 明确提供 continuation / load / supplement 三个布尔值。ACP 依据 initialize 协商结果填写 load；未声明 loadSession: true 时填写 false。

“当前句柄可继续”“adapter 有恢复实现”“provider 支持加载”“指定 ID 加载成功”是四个不同事实。运行时实现需要提供完整能力声明。

## 续接决策规则

| 情况 | 动作与说明 |
| --- | --- |
| 新工作 | 关闭旧执行者句柄，再建立新 Session；leader 保留当前对话 |
| 同一工作，live Session 兼容、idle 且支持 continuation | 复用句柄，记录 reused |
| 同一工作，但 live Session 已结束或不支持 continuation | 依据可靠记录和 load 能力判断是否加载；否则新建并携带恢复上下文 |
| 重启后有可靠归属和兼容记录，且支持 load | 尝试加载；成功后记录 loaded |
| 自动延续的记录不兼容、归属不可靠或不支持 load | 新建 Session，明确记录原因并携带恢复上下文 |
| 已实际尝试加载，但 provider 返回失败 | 本次执行失败并说明原因，不悄悄冷启动重做任务；保留之前可靠的加载候选供显式 retry 使用 |
| 正在 running / cancelling / closing | 不启动重叠 prompt，也不在清理未确认时建立替代执行者 |
| Session 关闭清理失败 | 保留并报告清理失败，不以普通执行失败覆盖它 |

补充规则：

- continue、显式 retry 和 repair 共用 core 的 Session 判断。调用方不再用“有 ID 就一定续接”的判断描述结果。
- worker 的一次执行失败后，仍可用的 live Session 可以供明确 retry 使用；异常结果保留可靠的 ID 与状态。运行时创建失败时不能补写请求中的 ID，冒充实际创建成功。
- 取消仍是取消，工作不自动继续；是否还能显式 retry 取决于清理结果和实际 Session 状态。
- CLI --resume / TUI /retry 保持固定 agent 集合。显式 SessionRecord 已知不兼容或不支持加载时报告无法续接，不忽略显式目标。没有实际获得 ID 的创建失败记录不冒充加载候选。
- 不从相邻 turn 或其他工作推断 Session 归属，不提供旧记录格式适配；缺少有效工作身份时不自动猜测目标。
- 无 openSession 的运行时使用 execute 行为；只记录它实际返回的事实，不伪造 live Session、load 或复用成功。
- preview / dry-run 可以展示续接意图及根据已知信息得到的判断，但不加载/重置 worker、不清理计划、不将预测写成实际动作。leader 为完成路由所需的执行保留原行为。

## 生命周期与恢复记录

### 结构化事件

增加 agent:session 生命周期事件，携带 agentId、可选 workId、bindingId、调用关联信息、动作、SessionRecord 和结构化原因。

事件区分：opening、created、load_requested、loaded、reused、load_failed、closing、closed、cleanup_failed。created/loaded 只在运行时实际返回句柄后发出；closed 只在清理获得确认后发出。清理超时使用 cleanup_failed，不能包装成已确认关闭。

同一次执行自动重试使用调用 ID 和 attempt 序号关联事件；仅为事件与结果关联，不建立独立 Attempt 台账。迟到的旧 binding 事件不得覆盖该 agent 的新 binding。

Session 元数据的事实来源归 runtime 与 manager；Orchestrator 负责绑定到工作；TUI/CLI 负责保存和展示，不分析日志文字，也不自己实现兼容性规则。managed 与 execute 单次运行路径都要覆盖，避免只有 TUI 收到事件。

### 保存时机

1. created/loaded 事件到达时即更新工作绑定，供现有 journal 写入，不等待 AgentResult。
2. 每次执行结束，包括异常、取消和交回，结果带回最后可靠的 Session 信息。
3. closing/closed/cleanup_failed 更新绑定观察状态；保留 provider ID 供审计，不直接宣称可加载。
4. 重启恢复将以前观察到的 running 等状态标为进程连续性未知；保留工作身份、provider ID、兼容摘要和执行事实。

沿用现有 journal/history 写入机制；这不是 provider 对话的持久性保证。突发退出仍可能早于 journal 落盘，缺少记录时按未知处理。

### 恢复上下文

无论加载旧对话还是新建，都收到完整需求、此次范围、工作 ID、上一轮执行和验收事实、停止原因，以及此次实际 Session 动作。

新 Session 明确说明旧对话未恢复，要求先检查工作区和 git 状态。失败输出作为部分结果；未完成、未验证和已确认事实分别表述。恢复提示不添加技术目标，不重复授权，权限与提问回调按本轮配置重新传入。

本轮不判断补充消息是否已消费，不自动重放未知投递结果，避免在没有 provider 回执时重复执行。

## 实现顺序

### 第一步：core 生命周期与异常元数据

- 更新 runtime/agent/config/event 类型，移除被 SessionRecord 替代的字段。
- AgentSessionManager 集中产生绑定事实、复用决策与关闭结果。
- ACP 暴露已协商的 load 支持；单次 execute 路径同样传播 Session 生命周期。
- AgentRunner 异常分支保留可靠 SessionRecord，执行异常和清理异常分别记录；不改变失败、取消、成本和重试预算语义。
- 先验证创建失败、执行失败后句柄仍可用、协作取消、进程死亡及清理未确认等场景。

### 第二步：统一续接与持久恢复

- Orchestrator 使用结构化记录处理普通 continue、固定 retry/resume、repair 和交回后重新路由。
- created/loaded 时更新 WorkContext；保持原始需求、完整需求、范围与计划的绑定。
- TUI state、history、journal 增加可选 SessionRecord；中断恢复保留可靠事实，不恢复假 running 状态。
- CLI report/resume 使用相同元数据；拒绝畸形 Session 元数据，不适配旧报告。
- 旧 binding 的关闭事件不得覆盖新 Session，旧工作记录不得因同名 agent 被其他工作更新。

### 第三步：可见性与完整验证

- TUI agent 详情和历史、CLI 报告展示实际复用/加载/新建，以及无法续接的原因。
- resume 预告改为“将尝试加载”，成功事件到达后才说“已恢复”。
- dry-run 展示意图、兼容性判断和未知项，不发出 worker 实际生命周期事件。
- 更新中英文文档，运行相关 core/TUI/CLI 测试，然后 pnpm verify。

## 验收场景

使用假运行时和 ACP mock 作为主要验证手段：

- 单 developer、无 architect 多 agent、architect 已配置但未选中、其他 ID 的 planner 都能正确绑定和续接 Session。
- 新任务新建 worker；连续 continue 复用兼容句柄；中间问答不丢工作目标；leader 保留自己的对话。
- 失败时 Session 仍 idle，明确 retry 复用；失败导致进程关闭时按实际 load 能力处理。
- created 后、结果返回前退出：落盘的 journal 能保留 ID 和归属，重启后尝试加载；未落盘的信息保持未知。
- 协作取消后不自动继续；不协作取消等待清理；清理失败不启动替代 worker。
- runtime/provider、模型、目录、systemPrompt 等变化触发不兼容；自动延续明确新建，显式加载目标明确失败。
- load 成功、load 不支持、协商未声明 load、ID 不存在、load 中取消、load 后再次 continue 均准确展示实际动作。
- repair 与交回重新路由只更新对应工作绑定；第二次交回预算、repair 预算、checkpoint 和最终验收不变。
- 旧 Session 的迟到事件不覆盖新绑定；历史审计保留多次执行使用的 Session；费用不重复统计。
- 新格式历史/CLI 报告能够保存、读取并校验 SessionRecord；可靠元数据缺失时不推断归属；显式 retry/resume 不扩大团队。
- 单次 CLI、共享 manager 的 TUI、execute-only 自定义 runtime 都使用同一条事实记录路径。
- preview/dry-run 不打开或关闭 worker、不加载旧 worker 对话、不删除计划，不能声称实际恢复成功。

真实 provider 联调可在实现后作为补充验证；测试报告区分 mock 覆盖与实际观测。

## 代码落点

- packages/core/src/orchestrator/AgentSessionManager.ts
- packages/core/src/orchestrator/AgentRunner.ts
- packages/core/src/orchestrator/Orchestrator.ts
- packages/core/src/runtime/AcpRuntime.ts
- packages/core/src/types/{runtime,agent,config,event}.ts
- packages/core/src/utils/{work,resumePlan}.ts
- packages/dashboard/src/tui/{state,session,history,App}.ts(x)
- packages/cli/src/commands/{run,resume}.ts 与 reporters/ConsoleReporter.ts

## 借鉴依据

DSH 的 Assignment 与 Session 分离、恢复前核对报告及输入、稳定 worker Session 身份，适合转化为我们的工作绑定与恢复事实。其 inbox 消费回执、持久 Effects 队列和动态 systemPrompt section 依赖 DSH 的原生能力，留待对应 runtime 能力和产品需求明确后再考虑。

参考：DSH src/app/sessions.ts、src/app/delivery.ts、src/core/assignments.ts、src/executor/dsh.ts；现有 multiclaw 路由实现为本计划的基础。
