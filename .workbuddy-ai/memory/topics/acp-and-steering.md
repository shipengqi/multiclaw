# ACP 接入 / steering 细节

## SDK 与桥
- SDK 2.0.2（peer zod 4.6.7）**必须懒加载**。根导出指向 `dist/v1/stable/acp.js`（PROTOCOL_VERSION 仍 1）；裸脚本 import `dist/acp.js` 会 ERR_MODULE_NOT_FOUND。
- 两个桥是 multiclaw 自己的依赖（core+cli 都列）：`claude-agent-acp`、`codex-acp`；`resolveExecutable()` 先 PATH 后 bundled `node_modules`。opencode 是原生 ACP（用户自装，无桥）。
- `BRIDGES` 按 basename 分派 `_meta` 与 `tools` 能力位；未登记 bridge 无 `meta` → 角色提示词降级为 prompt 前缀。**投递互斥**：只有 `meta === undefined` 才前缀。
- `_meta`：claude = `_meta.systemPrompt` + `_meta.claudeCode.options.tools`（`tools: true`；可用性 ≠ `--allowedTools` 预授权）；codex = `_meta.jetbrains.air.customInstructions` → `developerInstructions`（无条件读取，非 string 静默忽略；**无工具限制落点** → `tools: false`，allowlist 丢弃）。刻意不声明 AIR 客户端能力（会把输出切成 diffPatch/subagent/asyncTasks，都没映射）。
- `describe().capabilities.tools` 随 command 变化；`permissions` 恒 true。
- 续接：`session/load` 需 runtime 广告 `loadSession`，否则 `PermanentError`。

## 权限请求
- `session/request_permission`：name 优先 → kind 启发式 → 拒绝（fail-closed），`delete`/`move`/`think`/`switch_mode`/`other` 一律拒。
- **流里 `✗ User refused permission to run tool` 是桥 `deny()` 的默认文案，不是真有人点拒绝**；我们发 `permission_rejected` raw（人工拒绝带 `source:"user"`）+ 一句点名工具的警告。
- 白名单外的工具在 `auto` 模式下只留一条 `Tool permission denied by the configured tools policy: <tool>` 警告（`AcpRuntime.ts` 约 720 行），turn 不会因此直接失败；要当场放行得把 `permissions.mode` 设为 `ask`。

## 工具参数迟到
- 桥先发 `tool_call`（input 空 `{}`），随后 `tool_call_update` 补 `rawInput`。`AcpRuntime` 在 update 首次带非空 `rawInput` 时**补发一次同 id 的 `tool_call`**（`argsSurfaced` 去重）；`AgentRunner` 按 id 只打一行，空参数时**延后**到参数到达（或结果）再打，不再出现 `› Read {}`。`summarizeToolInput({})` 返回 `""`。
- `usage_update` → `usage` + `cost` 事件（contextTokens/contextSize/amount/currency）。

## steering（非 ACP 标准）
- 来自 codex-acp@2.2.2 / claude-agent-acp@0.93.0 dist：`_session/steering`，params `{sessionId, prompt, _meta:{steering:{idleBehavior}}}`，由 `initialize._meta.steering.supported === true` 广告。改桥版本要重核。
- `outcome`：`injected`/`promptRequired`/`startedNewTurn`/`failed`（codex 另有 `noRunningTurn`）。**一律带 `idleBehavior:"promptRequired"`**。
- **最危险**：两个桥在空闲会话收到 steer 都会自起新 turn（没有 `prompt()` owner 来 settle/归因/取消）→ ① 只给 `state==="running"` 的会话发；② 回了 `startedNewTurn` 立刻 `session/cancel` 清场（cancel 必须以**通知**发，request 会 -32601）。
- 2026-10-31 实测：Claude 0.89.1/0.95.0、Codex 2.2.2/2.5.0 广告；OpenCode 1.19.0 不广告。裸空闲仅测 Claude 0.93.0（promptRequired）与 Codex 2.2.2（startedNewTurn 并真开跑）；**未在 0.95.0/2.5.0 重跑裸空闲与取消**。提示只能说"送达"。
- `RuntimeSession.capabilities.supplement` 是协商结果（initialize 晚于会话对象创建 → getter）。`AgentSessionManager.supplement()` 返回 `SupplementReport[]`（injected|idle|unsupported|error，每 agent 独立）；无 running 会话 → `[]`。
- TUI"永不丢"：有 agent 收到 → `stream:note` 写 `[steer] …` 到 live turn + 点名；都没收到 → 转成排队后续并说明时机变了；空闲时 `/steer` 直接拒（`availability:"running"`）。
