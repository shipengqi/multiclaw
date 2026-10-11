# multiclaw 未完成计划

> 创建于 2026-10-11。本文件记录当前会话结束后仍需继续的工作项。

---

## 已完成（当前会话）

| Commit | 内容 | 状态 |
|--------|------|------|
| 3169260 | 加宽 `AgentRuntime`（事件 union / `describe()` / `onEvent`） | ✅ 已提交 |
| 4d355ac | stdout 分块用有状态 `StringDecoder`；超时也升级 SIGKILL | ✅ 已提交 |
| 1eb7e6d | stderr 同样修有状态解码 | ✅ 已提交 |
| 0439747 | `ClaudeRuntime` 边界用例套件 | ✅ 已提交 |
| 81d9bed | 删除评审/调研文档 | ✅ 已提交 |
| 4b3e432 | 新增 `AcpRuntime`（ACP client over stdio） | ✅ 已提交 |
| 8c6ae66 | 可用性认 `command` + 3 个 ACP 缺陷 | ✅ 已提交 |
| 3f2ee81 | 修正两个不合格的 cli 测试 | ✅ 已提交 |
| 526a462 | 角色提示词 + 工具经 `_meta` 投递 | ✅ 已提交 |
| 73c10c4 | 空工具列表改 fail-closed | ✅ 已提交 |
| 9a5b0f0 | 独立验证测试套件纳入版本管理 | ✅ 已提交 |
| 38e1b84 | 项目记忆刷新 | ✅ 已提交 |
| 009a0e3 | `session/request_permission` 处理器 | ✅ 已提交 |

当前 HEAD：`009a0e3` on `main`。全部未推送到 `origin`。

---

## 未完成（按优先级排序）

### 🔴 P0 — 退役 `ClaudeRuntime`（三步走）

**目标**：完全切换到 ACP，移除旧的 `ClaudeRuntime`，避免两套运行时并存导致的维护负担。

**步骤**：

1. **改默认值**  
   `packages/core/src/AgentRunner.ts:20,47` 和 `packages/core/src/Orchestrator.ts:57` 的 `?? "claude"` 默认值必须改掉。12 个内置 agent 都没设 `runtime` 字段，直接删会打断所有配置。策略：先让内置 preset 显式声明 `"runtime": "acp"`（或等价的新的默认），再改默认值。需要确认 `AgentDefinition` 的 `runtime` 字段是否允许 `"acp"`，以及 `AgentRunner.ts` 的 `resolveRuntime` 逻辑。

2. **映射 `usage_update` → `usage` 事件**  
   `ClaudeRuntime` 声明了 `usage: true`，它把 `usage_update` NDJSON 行映射成 `usage` 事件。`AcpRuntime` 没有这个映射，`usage` 声明为 `false`。退役前必须补上，否则调用方失去 cost/token 可见性。要调研 ACP 是否暴露 usage/cost 信息（`_meta`？`session/update` 的某个 variant？），如果 ACP 不暴露，则 `AcpRuntime` 的 `usage` 保持 `false`，但需要在文档里明确说明这是功能回退。

3. **删除 `ClaudeRuntime.ts` + 三个测试套件**  
   共约 34 个测试。删除后确认 `pnpm verify` 仍然绿。

**阻塞**：步骤 1 和 2 必须先做，步骤 3 最后做。步骤 1 需要确认 preset 修改不会破坏现有用户的配置迁移。

---

### 🟡 P1 — `availableRuntimes()` 残留

**问题**：`packages/cli/src/lib.ts` 的 `availableRuntimes()` 不带 `command` 调 `describe()`，只装 `codex-acp` 的用户跑 `multiclaw init` 会看到「No AI runtime detected」。

**修复**：
- `availableRuntimes()` 应接受可选的 `command` 参数；
- 或改为调用 `loadSession` 检查（因为 `loadSession` 已经返回 `supported`）。

需要确认 `init` 流程是否只需要「有一个可用 runtime」，还是真正需要列出所有可用的。

---

### 🟡 P1 — codex 是否一起迁移到 ACP（开放问题）

**现状**：`codex-acp`（即 `codex` CLI 的 ACP bridge）完全不读 `_meta`。这意味着 codex agent 会**同时丢掉角色提示词和工具限制**。

**选项**：
- A. 也退役 codex，只保留 `claude-agent-acp`；
- B. 给 codex 写 `_meta` 支持（需要上游改动，不可控）；
- C. 在 `AcpRuntime` 里检测 command 为 codex 时走特殊路径（比如把 system prompt 塞进 prompt 消息里，但这会污染对话上下文）。

**用户尚未拍板**。需要一次真机验证：用 codex-acp 跑一个带角色和工具的 agent，看实际行为是什么。

---

### 🟢 P2 — `QUALITY_REVIEW.md` 的 11 项

`QUALITY_REVIEW.md`（repo root）是一份质量审计计划，记录了 7 个 Finding + 3 个 Wave。用户从未要求执行，但文件还在。

**状态**：部分可能已经过时（因为 ACP 工作的优先级更高），但需要确认哪些仍然有效。

**建议**：先把 P0/P1 做完，再决定是否值得审计这份计划。

---

## 真机验证清单

以下验证需要在有实际 API 密钥的环境中执行，不能用 mock：

- [ ] `session/request_permission` 处理器：同一个「默认 tools + 读 secret.txt」的配置必须真的返回文件内容，不再是 `PERMISSION_DENIED`
- [ ] codex-acp 的角色提示词和工具限制行为（用于拍板 P1 codex 问题）
- [ ] 退役后的 `multiclaw init` 在无 claude CLI 但有 claude-agent-acp 的环境中的表现

---

## 技术债务 / 已知局限

1. **`kind` 映射是启发式的**：`delete` / `move` / `think` / `switch_mode` / `other` 在 Claude 工具集里没有对应项，会被拒绝。MCP 工具和某些内置工具走 ACP 时可能仍然被挡。这是 fail-closed 的代价，已写入 `AcpRuntime.ts` 注释。
2. **ACP 无 `system-prompt` 字段**：必须走 `_meta`，依赖 bridge 的实现。`claude-agent-acp` 支持，`codex-acp` 不支持。
3. **`usage` / `cost` 事件**：ACP 协议未暴露，当前映射为 `raw`。如果后续协议版本增加，需要升级 `AcpRuntime` 的映射。
4. **TUI 路线图中的 `ask` 回答没有上下文**：leader 问「用哪个数据库」用户答「Postgres」→ 下轮 requirement 就是孤零零的 `Postgres`。修法是把最近几轮（需求+回答）拼成 context 变量喂 leader prompt，但属于新设计决策（塞多少、token 预算），需用户拍板。
