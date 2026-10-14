# multiclaw 实施计划（基于 2026-10-13 评审决策）

> 输入：`multiclaw-product-review-2026-10-13.md` + `multiclaw-architecture-review-2026-10-13.md` 的待确认问题
> 作者决策：2026-10-13（12 条答复）
> 状态：**待作者确认实施范围后开工**

---

## 1. 决策记录

### 1.1 产品 review 待确认问题（作者已答）

| # | 问题 | 作者决定 | 落地含义 |
|---|------|---------|---------|
| 1 | 成本/用量是否纳入近期？ | **检查可用性，简单就纳入** | 已核查（见 §2.1）：`usage` 两家都有，`cost` 仅 Claude 有 → **纳入**，诚实降级 |
| 2 | `init` 是否默认写 leader？ | **默认写入** | `AGENT_BLOCKS` 增加 `agents.leader()`，不额外提问 |
| 3 | 失败恢复语义？ | **两者都做** | `run --resume` + TUI `/retry <id>` 都实现 |
| 4 | 是否引入 `maxCostUsd` 护栏？ | **可考虑，复杂就先不做** | 依赖成本数据先落地；成本汇总（C2）完成后再评估，本期暂不做 |
| 5 | cursor 真机验证是否阻塞？ | **不阻塞（本机未安装）** | cursor 保持"未验证"标注，不阻塞发布 |

### 1.2 架构 review 待明确事项（作者答复 + 本轮补充结论）

| # | 问题 | 结论 |
|---|------|------|
| 1 | 自定义 agent 的复杂度？ | **低（S）→ 支持**。详见 §2.2 |
| 2 | §3.3 上下文超限策略？ | **不做硬截断，走 compact 式摘要**（类似 Claude Code 的上下文压缩） |
| 3 | C2 成本汇总粒度？ | **先做简单版**（总计）；按 agent + 按模型分档若复杂度不高再做 |
| 4 | 有跨 turn 场景么？ | **有，但只在 leader/对话层**；agent session 目前完全不复用。详见 §2.3 |
| 5 | T4 多行输入？ | **仅在提交时处理**（不改 `Line` 模型为多行） |
| 6 | C10 超时语义？ | **不是故意分离，是缺陷**。详见 §2.4 |
| 7 | RFC Phase 2 是否已验收？ | **同意**（视为已验收）→ 精力转向本轮新发现（C1、§3.3） |

---

## 2. 本轮补充核查结论（回答作者反问）

### 2.1 成本/用量可用性 —— 已从桥的源码查实

核查方法：直接读 `node_modules/.pnpm` 下两个 bundled bridge 的 dist 产物，而非猜测。

| Provider | `usage`（context tokens） | `cost`（USD） | 证据 |
|---|---|---|---|
| **claude**（`claude-agent-acp@0.89.1`） | ✅ `used` / `size` | ✅ **`cost: { amount: total_cost_usd, currency: "USD" }`** | `dist/acp-agent.js:4428-4445` |
| **codex**（`codex-acp@2.2.2`） | ✅ `used` / `size` | ❌ 不发 cost（另有 `rateLimits` 通道，非 USD 计价） | `dist/index.js:31936-31939` |
| **opencode** | 未验证（原生 ACP，本机非 bundled） | 未验证 | — |
| **cursor** | 未验证（未安装） | 未验证 | — |

**结论：纳入。** 理由：
1. 数据通路已在 `AcpRuntime.ts:413-434` 完整实现（`usage_update` → `usage` + `cost` 事件），只是被 `AgentRunner` 丢弃 —— 纯 plumbing。
2. Claude 有真实 USD 成本，codex 至少能给出 context 用量 —— 已足以支撑"谁最烧上下文"的判断。
3. 降级是**诚实**的：没有 cost 的 provider 就不显示 cost，不伪造。

> ⚠️ 一个必须写进 UI 文案的现实：ACP 的 `usage_update` 只带 `used`/`size`（**上下文占用 / 窗口大小**），
> **没有 input/output token 分项**。所以 TUI 应显示 `ctx 45.2k/200k · $0.42`，
> 而不是评审文档里举例的 `12.3k tok`（那个数字形态 ACP 给不出来）。

### 2.2 自定义 agent 的复杂度 —— 低（S）

需要区分两件事：

**(a) 自定义 agent 定义** —— **零工作量，现在就支持**。`MultiClawConfig.agents` 是 `AgentDefinition[]`，
12 个 `agents.xxx()` preset 只是语法糖。用户完全可以手写任意 agent 对象，`defineConfig` 不做白名单校验。

**(b) 自定义"规划者"（architect）标识** —— **S，建议支持**。当前 `Orchestrator.ts:118` 硬编码
`a.id === "architect"`，一旦用户的架构师 agent 叫别的 id，task-plan 机制就静默失效。

**改法**（随 C1 一起做）：
```ts
// packages/core/src/types/agent.ts —— AgentDefinition 加一个可选字段
/** Marks the agent that owns task decomposition (writes task-plan.json). */
role?: "planner"
```
`AgentDefinition` 虽是已发布导出，但**新增可选字段是向后兼容的**（结构类型，加宽入参不破坏调用方）。
`Orchestrator` 判定改为 `a.role === "planner" || a.id === "architect"`（保留旧 id 作为兜底，
现有 preset 与配置**零改动**继续工作）。

**成本**：S。**破坏性**：否。

### 2.3 跨 turn 场景 —— 有，但只在 leader/对话层

| 层 | 是否跨 turn | 证据 |
|---|---|---|
| **leader / 对话** | ✅ 是 | `history: TurnRecord[]`（`types/config.ts:26-33`）→ `renderConversation()` → leader 提示词的 `{{conversation}}`；TUI 每轮共用 `config.workDir`，`task-plan.json` 每轮清空（`Orchestrator.ts:209-213`） |
| **agent session** | ❌ 否 | `AgentRunner` 构造 `AgentTask` 时**从不传 `sessionId`**（`AgentRunner.ts:73-105`）→ 每个 agent 每轮都是冷启动新会话 |
| **headless `run`** | ❌ 否 | 一次性批处理，每轮独立时间戳目录（`run.ts:23-24`） |

**因此 C6 的"同一 agent 在不同需求间串味"风险，是由 C6 自己引入的，不是现状。**
**建议设计**：session 复用**只服务于"续跑"**（显式 `--resume` / `/retry <id>`），**不默认跨 turn 复用**。
这样既拿到"失败不用重跑"的收益，又不引入串味风险。跨 turn 的记忆继续由 leader 的 `history` 承担。

### 2.4 超时语义 —— 不是故意分离，是缺陷

| 层 | 位置 | 语义 |
|---|---|---|
| 外层 `withTimeout` | `AgentRunner.ts:55-128` | 包住**整段 `withRetry`** → 总预算（含重试） |
| 内层 `setTimeout` | `AcpRuntime.ts:307-314` | 单次 `execute` 的预算 |

**两层用的是同一个值**（`agent.timeout ?? 600_000`）。所以：
- `retries: 0`（默认）时两者毫秒数相同、几乎同时触发，靠 `settled` 守卫二选一 —— 冗余但无害；
- **`retries > 0` 时是真缺陷**：外层总预算 == 单次尝试预算，第一次尝试就会把总预算耗光，
  **重试永远拿不到机会**。

**建议改法**：明确分层语义 —— 外层 = 整个 agent（含重试）的总预算，内层 = 单次 `execute` 的预算，
且外层应 `> timeout × (retries + 1)`，或在有重试时**只保留内层**。二选一，不要两套同值。

---

## 3. 实施批次（按依赖与风险排序）

> 约定：每批次自带测试；覆盖率门槛 core 90/85/90/90、cli 50/45/40/50、dashboard 90/85/90/90；
> 断言不变量不断言结果；写完回归测试先临时回退修复确认它变红。

### Batch 1 — 止血修复（P0，全部已拍板，低风险）

| 项 | 内容 | 文件 | 成本 |
|---|------|------|------|
| B1-1 | **C1**：`applyTaskPlan` 触发条件从"第 0 个 stage"改为"首次遇到含 planner 的 stage 之后" | `Orchestrator.ts:116-135` | S |
| B1-2 | **Q1**：`AgentDefinition` 加可选 `role?: "planner"`，判定改为 `role === "planner" \|\| id === "architect"` | `types/agent.ts`、`Orchestrator.ts` | S |
| B1-3 | **Q2**：`init` 生成的配置默认写入 `leader: agents.leader()` | `cli/commands/init.ts:8-34,76-91` | S |
| B1-4 | **新发现**：修 `init` 里 ★ Leader 覆盖被静默丢弃（正则匹配不到 `agents.leader(`） | `cli/commands/init.ts:61-74,163` | S |
| B1-5 | **T1**：TeamPanel / StreamPanel 运行中显示 `taskTitle`（依赖 B1-1） | `dashboard/tui/components/panels.tsx:46-49,152-163` | S |

**验收**：新增回归测试覆盖"`[productManager, architect(dep=pm), dev(dep=architect)]` 下 dev 收到 taskTitle"；
`init` 生成的配置含 leader 且可用；dashboard 集成测（注意先 `pnpm build` core）。

### Batch 2 — 可观测性（P1，Q1 已确认可做）

| 项 | 内容 | 文件 | 成本 |
|---|------|------|------|
| B2-1 | **C2**：`AgentResult` 加可选 `usage`/`costUsd`；`OrchestratorResult` 加汇总（简单版：总计） | `types/agent.ts`、`types/config.ts`、`AgentRunner.ts`、`Orchestrator.ts` | M |
| B2-2 | **C4**：`AgentTask` 加可选 `onWarning`，model 告警改走 `orchestration:warning`（去掉裸 stderr） | `types/runtime.ts`、`AcpRuntime.ts:588-593`、`AgentRunner.ts` | S |
| B2-3 | **T2**：`tool_call`/`tool_result` 进流面板（默认折叠） | `AgentRunner.ts:89-104`、`panels.tsx` | M |
| B2-4 | **TUI**：team 面板行尾显示 `ctx 45.2k/200k · $0.42` | `panels.tsx`、`format.ts` | S |
| B2-5 | **C3**：`ModelSelectionMode` 收窄为 `"config-option" \| "none"`（去掉死枚举 `"arg"`） | `providers/catalog.ts:16` | S |
| B2-6 | **C5/T8**：`AgentStatus` 加 `cancelled` + TUI `STATUS` 表补 glyph | `types/agent.ts:62`、`theme.ts` | S |
| B2-7 | **T3**：错误改为可展开的多行呈现（不再单行 truncate） | `App.tsx:79-84,247-250` | S |

### Batch 3 — 续跑（P0-2 / E2，Q3「两者都做」）

| 项 | 内容 | 文件 | 成本 |
|---|------|------|------|
| B3-1 | **C6**：`AgentRunner` 维护 `Map<agentId, sessionId>`，**仅用于续跑**，不默认跨 turn | `AgentRunner.ts` | M |
| B3-2 | **E2a**：`run --resume <runId>`（复用上轮 session + 已完成 stage 检查点） | `cli/commands/run.ts`、`Orchestrator.ts` | M |
| B3-3 | **E2b**：TUI `/retry <id>` 只重跑失败 agent | `tui/commands.ts`、`App.tsx` | M |
| B3-4 | 前置验证：各 bridge 的 `loadSession` 真实支持度（`AcpRuntime.ts:543` 要求 `loadSession === true`） | 真机 | — |

### Batch 4 — 上下文传递（Q2「compact 式」）

| 项 | 内容 | 文件 | 成本 |
|---|------|------|------|
| B4-1 | **§3.3**：stage 完成后把成功 agent 的 output 摘要写入 `ContextManager`（key `output:<id>` + `upstreamOutputs` 汇总） | `Orchestrator.ts`、`ContextManager.ts` | M |
| B4-2 | **Q2**：超限走 **compact 式摘要**（调 leader/轻模型压缩，而非硬截断）；内置模板加 `{{upstreamOutputs}}`，构造时 `set(key,"")` 兜底 | `Orchestrator.ts`、`agents/*.ts` | M |
| B4-3 | **Q5/T4**：多行粘贴仅在提交时处理（保留换行结构，不改 `Line` 模型） | `App.tsx:630` | S |

### Batch 5 — P2 收尾

`C7`（缓存失效）· `C8`（可重试错误分类）· `C9`（真并发池）· `C10`（超时去重，见 §2.4）·
`C12`（`resolveArgs` 边界）· `C13`（深拷贝）· `T5`（`/retry` `/fork`）· `T6`（`/focus` 补全）·
`T7`（流内搜索）· `T9`（历史落盘）· `T10`（帮助派生）· `E4`（交付物摘要）· `E5`（dry-run）·
`E7`（`/export`）· `E9`（会话持久化）

**暂不做**：`E8 maxCostUsd` 护栏（等 C2 成本数据稳定后再评估）· 权限审批 UI（P2，需单独设计）·
cursor 真机验证（本机未安装，保持"未验证"标注）

---

## 4. 建议开工顺序

```
Batch 1（止血）→ Batch 2（可观测性）→ Batch 3（续跑）→ Batch 4（上下文）→ Batch 5（收尾）
```

Batch 1 与 Batch 2 的 B2-2/B2-5/B2-6 互不冲突，可并行；Batch 2 的 B2-1 与 B2-3 应同批做（同一处改动）。
