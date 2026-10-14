# Batch 5a 实施计划 —— core 正确性（P2 收尾 · A 组）

> 来源：`multiclaw-implementation-plan-2026-10-13.md` 的 Batch 5
> 范围：**C10 / C8 / C7 / C12 / C13**
> 日期：2026-10-14　状态：开工

## 0. 为什么先做这一组

5 项全在 `packages/core`、全部成本 S、彼此独立，且共同点是**让代码符合它自己写下的承诺**。其中 **C10 是唯一真缺陷**：`retries > 0` 时重试永远拿不到机会。
TUI 会话与可发现性（T9≡E9 / T5 / T6 / T10 / T7）属 5b；交付体验与吞吐（E4 / E5 / E7 / C9）属 5c。

作者已拍板：Batch 5 拆三批全做；`deliverables/` 纳入版本管理、`scripts/` 保持未跟踪。

---

## 1. 逐项规格

### C10 超时分层（唯一真缺陷）

**现状**（两套计时器、同一个值）：

- `AgentRunner.ts:62`　`const timeout = agent.timeout ?? 600_000`
- `AgentRunner.ts:65-67`　`withTimeout((innerSignal) => withRetry(...), timeout, agent.name, signal)` —— 外层包住**整段** `withRetry`
- `AgentRunner.ts:88`　同一个 `timeout` 又传进 `runtime.execute({ timeout })` → `AcpRuntime.ts:313-319` 起内层 timer
- 内层触发链：`timedOut = true` → `stop("SIGTERM")` → 子进程退出时 `settleReject(new Error(\`acp timed out (${task.timeout}ms)\`))`（`AcpRuntime.ts:539-541`）
- 外层触发：`[<agent name>] timed out (Xs)`（`utils/timeout.ts:24`）

**后果**：两层同值 ⇒ 第一次尝试就把外层总预算耗光 ⇒ **`retries > 0` 时重试永远没机会**。

**改法**（选"外层 = 总预算、内层 = 单次"）：

1. `utils/retry.ts`：导出 `DEFAULT_RETRY_DELAY_MS = 2000`（替换 `:31` 的字面量默认值），并新增
   `retryBudgetMs(perAttemptMs, retries, delayMs = DEFAULT_RETRY_DELAY_MS)`，返回**一次完整重试序列的墙钟上界**：
   `perAttemptMs * (retries + 1) + delayMs * retries * (retries + 1) / 2`
   （退避是 `delayMs * attempt`，`attempt` 取 1..retries。）
   **把这段算术放在 retry 循环旁边**——循环是它的唯一定义处，分开放必然会漂移。
2. `AgentRunner.ts:164`　外层预算改为 `retryBudgetMs(timeout, retries)`。
3. `AgentRunner.ts:161`　字面量 `2000` 改用 `DEFAULT_RETRY_DELAY_MS`。
4. 注释写明语义：外层 = 整个 agent（含重试与退避）的**兜底**；内层 = 单次 execute 的预算。
   `retries: 0` 时两者仍相等，但那时只有一次尝试，**相等是正确的**——不要为了"不相等"而人为加偏移。

**必测不变量**：`retries: 1` 时两次尝试**各自**能用满 `timeout`（fake timers：第一次在 `timeout` 处超时，第二次仍能启动并跑完）。
**回退证据**：改回 `timeout` 后该用例必须变红。

### C8 可重试错误分类

**现状**：`withRetry`（`utils/retry.ts:27-51`）对**任何**非 abort 错误都重试。而 `AcpRuntime.ts` 里有两类错误重试一万次也不会变好：

- `:549-551` `child.on("error")` → `Failed to start ${command}: ...`（ENOENT / EACCES）
- `:563-567` `Agent does not support session/load (loadSession=false)`（能力不匹配）

它们会按 `delayMs * attempt` 白白退避（2s + 4s + …），把一次必然失败的运行拖长。

**改法**：

1. `utils/errors.ts`（新）：`class PermanentError extends Error {}` + `isPermanent(err: unknown): boolean`。
   **消息逐字保持原样**——`AgentResult.error` 取 `(err as Error).message`，改消息会破坏结果契约。
2. `AcpRuntime.ts`：**只**把上述两处改成 `PermanentError`。其余（超时、`connectionError`、子进程非零退出）保持可重试。
3. `utils/retry.ts`：`withRetry` 增加**第 6 个可选参数** `shouldRetry?: (error: unknown, attempt: number) => boolean`，默认 `() => true`。
   `catch` 里：`shouldRetry` 返回 false → **立即 throw**，不退避、不调 `onRetry`。
4. `AgentRunner.ts`：传 `shouldRetry: (e) => !isPermanent(e)`。

**前提**：`withRetry` / `withTimeout` **不在** `packages/core/src/index.ts` 的导出清单里（内部函数），所以加参数安全；但仍须保证**不传时行为逐字不变**。

**必测不变量**：不可重试错误 → `fn` 只被调用 1 次、`onRetry` 不被调用；可重试错误 → 调用次数与退避与改动前一致；省略 `shouldRetry` → 行为不变。

### C7 `discoveredModels` 缓存的键

**现状**：`AcpRuntime.ts:20` `const discoveredModels = new Map<string, string[]>()`（**模块级**）；`:600` 以 `command`（`task.command ?? DEFAULT_COMMAND`）为键写入；`:606` 读出用于校验；`:607` 若模型不在缓存列表里 → 只告警并**跳过 `setConfigOption`**，即**配置的模型不会生效**。

**我的独立核查修正了原评审的说法**：原评审称"跨 provider / 跨版本不失效"。但键就是 command，跨 provider 天然是分开的；跨版本需要重启进程，而重启会清空模块级缓存。**这个理由不成立。**

真正站得住的一点是：**这份列表描述的是"某个二进制"的广告，键却是裸 command 字符串**。`resolveExecutable()` 会在 PATH 与 multiclaw 自带 `node_modules` 之间选择，**同一个 command 名可能指向不同二进制**，此时后者的模型清单会污染前者的校验。

**改法（窄口径）**：把缓存键改成**实际启动的那个可执行文件路径**（复用 spawn 用的同一个 `resolveExecutable()` 结果），而非裸 command。**不做 TTL、不加失效逻辑**；缓存规模由"不同二进制数"自然界定，在注释里说明。
**若实现时发现同一个 command 在进程内恒定解析到同一路径**，请**照实回报**，不要硬造改动——那说明这项只值一句注释。

**必测不变量**：不同可执行文件 → 不共享列表；同一可执行文件 → 命中缓存（`session/new` 只问一次）。

### C12 `resolveArgs` 把 provider 的 args 贴到自定义 command 上

**现状**：`providers/resolve.ts:38-40`

```ts
return agent.args ?? specForProvider(resolveProvider(agent, config))?.args
```

自定义 command 不在 catalog 时，`resolveProvider` 会一路回落到 `opencode`，于是自定义二进制被塞进 `["acp"]`。
**而它自己的注释已经承诺了正确行为**："Returns undefined for a truly custom command so the runtime's default still applies." —— **代码没做到**。

**改法**：

```ts
export function resolveArgs(agent: AgentDefinition, config: MultiClawConfig): string[] | undefined {
  if (agent.args) return agent.args
  // The command decides its own args: an explicit command must not inherit the
  // default provider's ["acp"].
  const command = agent.command ?? config.defaults?.command
  if (command) return specForCommand(command)?.args
  return specForProvider(resolveProvider(agent, config))?.args
}
```

**注意**：`resolveArgs` 经 `providers/index.ts` → `index.ts` 的 `export * from "./providers"` **是已发布导出**。签名不变、行为按注释承诺修正；`resolve.test.ts` 既有 3 条断言（`provider:"claude"`→`[]`、`provider:"opencode"`→`["acp"]`、`provider:"unknown"`→`undefined`）**必须全部保持通过，不许改它们**。

**必测不变量**：`command` 为 catalog 外二进制且未设 `args` → 返回 `undefined`（不是 `["acp"]`）。

### C13 `configuredAgents()` 浅拷贝

**现状**：`Orchestrator.ts:319-321` `return this.config.agents.map((a) => ({ ...a }))` —— `dependsOn` 数组仍与 config 同引用。当前无 bug（下游都是重新赋值），但只差一次 `push`。

**改法**（逐字段拷，且**不新增键**）：

```ts
return this.config.agents.map((a) => (a.dependsOn ? { ...a, dependsOn: [...a.dependsOn] } : { ...a }))
```

不要写成 `{ ...a, dependsOn: a.dependsOn ? [...] : undefined }` —— 那会给原本没有该键的对象**加上一个值为 `undefined` 的键**。

**必测不变量**：改动后 `dependsOn` 与 config 不共享引用（改副本不影响 config）；无 `dependsOn` 的 agent 上**不存在**该键。

---

## 2. 约束

- 只在 `packages/core` 内改动；**不动** TUI / cli。
- 断言不变量、不断言结果；每条新回归测试都要"临时回退 → 确认变红 → 恢复"。
- 门禁：`pnpm build`（dashboard 集成测试读的是 core 的 dist）、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:coverage`。
  ⚠️ 本机沙箱跑 `test:coverage` 会在 `cleanAfterRun` 被批量删除保护拦下——**只要覆盖率表格打印出来且没有 threshold 报错，即为通过**（`reportThresholds` 早于 `cleanAfterRun`，见 memory）。
- **不要 commit**，由我提交。

## 3. 交付

逐项报告：改动摘要 + 实测证据（回退前后）+ **是否发现原前提不成立**（C7 尤其要照实说）。
