# Batch 4「上下文」实施计划

> 作者决策：§3.3 超限走 **compact 式摘要**（不做硬截断）；「如果复杂度高，就暂时不引入」。
> T4 多行输入：**仅在提交时处理**（明确**不**把 `Line` 模型升级为多行）。

## 1. §3.3 —— agent 之间没有产物传递（架构评审 P0）

**缺陷**：`ContextManager` 只被写入三类键 —— `conversation`（构造时）、`pipelineAgents`、
`availableAgents`。**从不写任何 agent 的产出**。`AgentRunner` 把 `contextManager.snapshot()` 拼进
prompt，所以下游 agent 的上下文里**没有上游说过什么**；agent 之间唯一的通道是共享文件系统（下游得自己
`Read`）。与 leader 的跨轮 `history` 形成不对称：**跨轮有对话历史，跨 agent 没有**。

**成本**：下游重复发现上游成果（token 与时间双浪费）；上游的关键结论（架构决策、PRD 摘要）没进下游
prompt，模型可能做出与上游矛盾的选择。

### 设计（最小改动，不加接口）

1. **新 util `packages/core/src/utils/upstream.ts`**，导出：
   ```ts
   export interface UpstreamOutput { agentId: string; name: string; output: string }
   export const MAX_UPSTREAM_ENTRY_CHARS = 600
   export const MAX_UPSTREAM_CHARS = 4000
   export function renderUpstreamOutputs(outputs: readonly UpstreamOutput[]): string
   ```
   - **空输入 → 返回 `""`**，且**块自带换行**（首行 `\n`），照抄 `conversation.ts:60-79` 的约定：
     「换行属于块，不属于模板 —— 不存在的段落不能留下空行」。模板里 `{{upstreamOutputs}}` 独占一行、
     **不写 section 标题**（否则空值时标题悬空）。
   - 头部形如 `\n## What upstream produced\n\n`，每条 `- <name> (<agentId>):` + 正文缩进。
   - **单条超限走「compact 式」压缩，不是硬截断**：保留**开头 + 结尾**，中间用显式省略标记
     （形如 `… (N characters elided) …`）。理由：上游结论通常在尾部，需求框架在头部，硬切会把两者
     都切掉。**这是确定性的压缩，不是 LLM 摘要** —— 命名为 `compact` 时要在注释里写清这一点，
     并把「LLM 摘要」列为后续可选项。
   - **总量超限丢最旧**（与 `conversation.ts:73-75` 同策略：保留最新的，因为最新的最相关）。
   - 全部为纯函数，逐条单测。

2. **`Orchestrator`**：
   - 构造里加 `this.contextManager.set("upstreamOutputs", "")` —— 遵守「**占位符必须无条件设值**」
     （`Orchestrator.ts:35-38` 已有 `conversation` 的先例；缺键会让 `{{upstreamOutputs}}` 以字面量
     进提示词）。
   - 在 `run()` 的 stage 循环里，`results.push(...stageResults)` **之后**、
     下一轮 `runStage` 之前，更新：
     ```ts
     this.contextManager.set(
       "upstreamOutputs",
       renderUpstreamOutputs(results.filter((r) => r.status === "success"))
     )
     ```
     只取 `success` 的（失败的产出不可信）。**不改 `ContextManager`** —— 它已是通用 KV。
     ⚠️ 注意与 `planApplied` 分支的先后：计划应用后会 `stages` 重算，但 `results` 不变，所以放在
     `results.push` 之后即可，不必关心 plan 分支。

3. **内置 preset 的 `taskPrompt`**：除 `leader` 外，每个 preset 的 `TASK` 模板都要引用
   `{{upstreamOutputs}}`（否则这个能力对内置团队就是死代码）。位置建议紧跟 `## Plan` 之后。
   - **新增不变量测试**（`agents/index.test.ts`，沿用该文件已有的 `it.each` 风格）：
     「每个 preset **除 leader 外**的 `taskPrompt` 都包含 `{{upstreamOutputs}}`」。
   - 同时断言 **leader 的 `taskPrompt` 不含**它（leader 跑在任何 stage 之前，没有上游）。

### 已知限制（写进注释，如实记录）
`renderPrompt` 先做 `{{file:...}}` 再做 context 键替换（`prompt.ts:43-45`），且 `AgentRunner` 的
`agentContext` 里 `agentScope`/`agentPlan` **排在 snapshot 之后** —— 所以若某个上游 agent 的**输出正文**
里恰好含字面量 `{{agentScope}}`，它会被下游自己的 scope 替换。属既有的替换顺序特性（`conversation`
有同样性质），本批**不修**（修法需要清洗 agent 输出，会破坏合法内容），只记录。

---

## 2. T4 —— 多行粘贴被压成一行（架构评审 P2）

**现状**：`App.tsx` 的 `insert` 做 `char.replace(/[\r\n]+/g, " ")`，把换行**全替换成空格**。
而 `conversation.ts:14-18` 的注释明确说「requirement 可能是一段粘贴的 stack trace」→ 粘进来后换行结构
被抹掉，可读性大损。

**作者决策**：**不**把 `Line` 模型升级为多行（那会影响 `Prompt` 组件与所有 caret 逻辑），
**仅在提交时处理**。

### 设计：缓冲区保留换行，显示用 1:1 的可见标记

关键洞察：`Prompt` 是**按字符索引**把 `value` 切成 `before` / `cell` / `tail` 三段 `<Text>`
（`prompt.tsx:30-36`）。所以只要把 `\n` 换成**恰好 1 个字符宽**的可见标记，**所有 caret 算术零改动**，
`Line` 仍是 `{ text, cursor }`。

1. **`theme.ts` 的 `GLYPH`** 加 `newline`（建议 `"↵"`）。注释必须写明：**该标记必须是 1 列宽** ——
   caret 位置依赖 1:1 替换；若某终端把它渲染成 2 列，改这里一处即可。
2. **`App.tsx` 的 `insert`**：不再替换为空格，改为**保留换行**（只归一化行尾：
   `char.replace(/\r\n?/g, "\n")`）。这样粘贴的 stack trace 结构完整保留。
3. **`Prompt` 组件**：先把 `\n` 替换为 `GLYPH.newline` **再切片**（替换是 1:1，长度不变，
   所以 `cursor` 索引仍然正确）。`\r` 一并清掉。
4. **`submit`** 无需改：它已经只 `trim()` 外层空白，内部换行自然保留 → 交给编排的 requirement
   是**真实的多行文本**。
5. **不新增裸键**；`enter` 仍然提交（用户只能通过**粘贴**引入换行，不能键入换行）—— 与
   「仅在提交时处理」一致。

### 测试
- `Prompt` 渲染：含 `\n` 的 value → 输出里出现 `GLYPH.newline` 且**不出现真实换行**（不破单行布局）；
  caret 落在 `\n` 上时 `inverse` 标记正确。
- `App` 提交：粘贴 `"a\nb"` → 提交的 requirement 是 `"a\nb"`（换行保留），**不是** `"a b"`。
- 回归：普通单行输入行为不变（含中间插入、backspace 后光标位置）。

---

## 3. 验收
- `pnpm lint` / `build` / `typecheck` / `test` / `test:coverage` 全绿，不破线。
- 每条回归测试做「临时回退 → 确认变红 → 恢复」。
- 关键不变量：**不涉及上游的路径行为不变**（`renderUpstreamOutputs([]) === ""`；`upstreamOutputs`
  缺省为 `""` 时 `{{upstreamOutputs}}` 不留悬空标题）；**单行输入行为不变**。
- 不 commit（由 lead 统一提交）。

## 4. 本批不做
- LLM 摘要式 compact（确定性压缩够用；复杂度过高时作者已同意暂不引入）。
- `{{output:<agentId>}}` 逐 agent 键 —— 会让引用未运行 agent 的模板留下未解析占位符，收益不抵风险。
- `renderPrompt` 的替换顺序加固（见 §1 已知限制）。
- T6/T7/T9/T10 等其余 TUI P2（不在 Batch 4 范围）。
