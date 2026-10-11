# RFC 0001 — Agent Provider 目录、本机探测与 init 向导重构

> 状态：**待评审**（Draft）  
> 日期：2026-10-11  
> 覆盖需求：① Cursor/ACP ② 本机 agent 自动感知 ③ init 询问 model ④ runtime/agent 概念拆分 ⑤ `--no-leader` 重新定位

---

## 0. 决策摘要（先看这里）

| # | 结论                                                                                                                                            | 代价            |
| - | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| ① | **Cursor 值得支持，但属于"低成本接入 + 高验证成本"**：目录里加一项即可，不动 `AgentRuntime` 接口。真正的工作量在验证 `_meta` 落点与 auth 前置。建议排在 Phase 3，不阻塞其余四项。                          | 低（先做，真机验证后置）  |
| ② | 现状已有**半个**自动感知（`availableRuntimes()` + 硬编码 `KNOWN_ACP_COMMANDS`）。升级为 **Provider 目录驱动的 `detectProviders()`**，三态降级为二态 + 认证提示字符串（见 §4.3 的刻意取舍）。  | 中             |
| ③ | **必须先修一个硬伤：今天配置的 model 根本没下发给 agent**（`task.model` 只进了事件负载）。不修，init 里问 model 就是纯摆设。修法：ACP 的 `session/set_config_option`（`configId: "model"`）。 | **高优先级，阻塞 ③** |
| ④ | 引入 **`provider`（agent 产品）** 与 **`runtime`（协议）** 两层。`runtime` 保持 `"acp"` 不变，`provider` 新增。用 `command` 反查 provider 保证 100% 向后兼容。                | 中             |
| ⑤ | `--no-leader` **保留但收紧为 run-only**，TUI 里若 `useLeader:false` 则常驻一行醒目提示（让降级可见而不是静默）。                                                             | 低             |

**Q1–Q6 已拍板，见 §9。**

---

## 1. 现状盘点（带证据）

### 1.1 Runtime 层

| 事实                                                      | 位置                                                 |
| ------------------------------------------------------- | -------------------------------------------------- |
| registry 里**只有一个** runtime：`acp`                        | `packages/core/src/runtime/index.ts:7`             |
| `AgentDefinition.runtime` 默认 `"acp"`                    | `packages/core/src/orchestrator/AgentRunner.ts:47` |
| 启动二进制由 `command` 指定，默认 `opencode` + `["acp"]`           | `AcpRuntime.ts:30-31`                              |
| 每个 bridge 一套 `_meta` 命名空间，按 **basename** 分派             | `AcpRuntime.ts:54-96`、`bridgeFor()` 295            |
| 未登记 bridge → 无 `meta` → 角色提示词降级为 **prompt 前缀**          | `AcpRuntime.ts:351-359`                            |
| `tools` 是否生效**随 bridge 变化**（claude=true / codex=false）  | `AcpRuntime.ts:336`、`describe()` 318-338           |
| `describe()` **刻意不 import SDK**（zod ≈5s），只做 PATH 查找     | `AcpRuntime.ts:319-327`                            |
| session 生命周期全部走裸 `ctx.request(methods.agent.session.*)` | `AcpRuntime.ts:633-669`                            |

### 1.2 硬编码的"自动感知"

```ts
// packages/cli/src/lib.ts:44
const KNOWN_ACP_COMMANDS = ["opencode", "claude-agent-acp", "codex-acp"]
```

这是初具形状的探测，但四个问题：

1. **在 CLI 里，不在 core 里** —— core 是库，探测能力不该只属于 CLI。
2. **硬编码数组**，加一个 agent 要改代码；且 `KNOWN_ACP_COMMANDS.slice(1)` 这种下标写法已经脆弱。
3. **返回的是 runtime 名（`["acp"]`）而不是"哪个 agent"** —— 语义错位，`init` 拿到它只能判断"有没有"。
4. 只在 init **写完之后**打一行 warning，没有参与决策。

### 1.3 ⚠️ 硬伤：model 从未下发

```ts
// AcpRuntime.ts:636 —— 唯一一处用到 task.model 的地方
emit({ type: "run_started", model: task.model })
```

`session/new`、`session/load`、`session/prompt` 三个请求**都不带 model**。  
`CAPABILITIES.models = false`（`AcpRuntime.ts:128`）也印证了这点：**适配器从没实现过模型选择。**

后果：

- 12 个 preset 里的 `models: { acp: "opus" | "sonnet" | "haiku" }` 全是**装饰**。
- `examples/dev-team/multiclaw.config.ts` 里那 5 个 `{ model: "haiku" }` 也是装饰。
- **需求 ③（init 让用户选 model）如果不先修这个，生成出来的配置是骗人的。**

**修法已确认可行**：ACP 的 Session Config Options 是模型选择的标准落点。

```
session/new 响应 → configOptions: [{ id: "model", category: "model", type: "select",
                                     currentValue: "...", options: [...] }]
客户端设置   → session/set_config_option { sessionId, configId: "model", value: "<model id>" }
```

SDK 1.8.0 已暴露方法常量 `methods.agent.session.setConfigOption`  
（`dist/acp.d.ts:61`、`dist/acp.js:75`），无高层封装 —— 但我们本来就全用裸 `ctx.request`，加一行即可。

**额外收益**：模型清单可以**从 agent 运行时发现**，不必硬编码。init 仍需要一份静态清单做默认值（离线 + 无会话），但运行期可以做"配置值不在清单里就告警"。

### 1.4 概念混淆（需求 ④ 的根源）

现在一个字段 `runtime` 同时被期待表达两件事：

```
"runtime" 在过去 = claude / opencode / codex / cursor   （哪个 agent 产品）
"runtime" 在今天 = "acp"                                （哪种协议）
```

后果落在 `models` 上：

```ts
// AgentRunner.ts:20
const model = agent.model ?? agent.models?.[agent.runtime ?? "acp"]
```

键是 **runtime 名**，而所有 agent 的 runtime 都是 `acp` → **无法表达"这个 agent 跑在 codex 上用模型 X"**。  
而且 preset 里写的是 `opus/sonnet/haiku` —— **Anthropic 别名**，对 opencode / codex / cursor 无意义。

### 1.5 init 现状

`packages/cli/src/commands/init.ts`：3 个问题（project name / preset / workDir），  
最后 `checkRuntime()` 打一行"没装 runtime"的警告。生成的配置里 **没有任何 model / command / runtime 痕迹**。

### 1.6 `--no-leader` 现状

| 事实                                                     | 位置                                   |
| ------------------------------------------------------ | ------------------------------------ |
| 只在 `run` 子命令上                                          | `cli/src/index.ts:34`                |
| 实现就是 `config.useLeader = false`                        | `cli/src/commands/run.ts:19-21`      |
| core 里 leader 缺失或 `useLeader===false` → 直接跑全队          | `Orchestrator.ts:224-226`            |
| TUI **没有开关**，但 `activeLeader()` 一样遵守 `useLeader:false` | `dashboard/src/tui/state.ts:176-178` |
| 也就是说：**TUI 里关掉 leader 是"静默降级"** —— 界面上完全看不出来           | —                                    |

TUI 里 leader 是三态路由器（run / reply / ask）。关掉它 = 用户每敲一句话都要跑满 10 个 agent，  
且失去"问一句就得到回答"的能力。**你的判断是对的：TUI 里 leader 事实上不可或缺。**

### 1.7 附带债：README 是错的

```
README.md:13   | `claude` (default) | npm install -g @anthropic-ai/claude-code
README.md:15   > **Future support:** We plan to add support for additional runtimes (Codex, OpenCode, Cursor)...
README.md:139  | `runtime` | string | | `claude` (default). Additional runtimes coming soon.
```

ClaudeRuntime 已于 2026-10-11 退役，唯一 runtime 是 `acp`。文档与代码已经脱节。

---

## 2. 概念模型：两层，不是一层（需求 ④）

```
┌─ runtime  ── 协议 / 传输层 ──  "acp"（registry 里唯一；未来可能有别的）─ 不变
└─ provider ── agent 产品 ─────  "claude" | "opencode" | "codex" | "cursor" | 自定义 ─ 新增
                                   └─ 决定：二进制名、args、模型名、_meta 命名空间、
                                      是否吃 tool allowlist、认证前置条件
```

`command` 是第三层（具体二进制路径），通常由 provider 推导，允许显式覆盖。

### 2.1 类型改动（全部向后兼容）

```ts
// packages/core/src/types/agent.ts
export interface AgentDefinition {
  // 语义不变，只有文档要改：这是"协议"，不是"产品"
  runtime?: string
  /** 新增：agent 产品。缺省时从 `command` 反查，再缺省用项目 defaults。 */
  provider?: ProviderId
  /** 保留：显式覆盖 catalog 推导出的二进制 */
  command?: string
  /** 键的语义由 runtime 名改为 provider id；"acp" 作为 legacy 别名永久保留 */
  models?: Partial<Record<string, string>>
  /** 新增：角色对模型档位的诉求，跨 provider 生效。见 §5.2 */
  modelTier?: "strong" | "balanced" | "fast"
  // ...其余不动
}

// packages/core/src/types/config.ts
export interface MultiClawConfig {
  // ...
  /** 新增：项目级默认，让 10 个 agent 一行搞定 */
  defaults?: { provider?: ProviderId; model?: string; command?: string }
}
```

### 2.2 解析顺序（新增单点纯函数，禁止各处自己写）

```
provider = agent.provider
        ?? providerForCommand(agent.command)        // basename 反查 catalog
        ?? config.defaults?.provider
        ?? providerForCommand(DEFAULT_COMMAND)      // "opencode"

command  = agent.command
        ?? config.defaults?.command
        ?? catalog[provider].command

model    = agent.model                              // 显式覆盖最高
        ?? agent.models?.[provider]
        ?? agent.models?.["acp"]                    // legacy 别名，保老配置
        ?? tierModel(provider, agent.modelTier)     // 角色档位
        ?? config.defaults?.model
        ?? catalog[provider].defaultModel
```

**向后兼容性论证**：老配置 `{ runtime:"acp", command:"opencode", models:{ acp:"sonnet" } }`  
→ provider 反查得 `opencode`，`models?.["opencode"]` 未命中 → 落到 legacy 别名 `models?.["acp"]` → `"sonnet"`。  
**结果与今天完全一致。**

`packages/core/src/agents/index.test.ts:42` 的 it.each 不变量  
（`agent.models?.[agent.runtime ?? "acp"]` 必须 truthy）**不用改也能继续绿**。

### 2.3 命名：我推荐 `provider`

| 候选                 | 优点                                      | 缺点                                 |
| ------------------ | --------------------------------------- | ---------------------------------- |
| **`provider`（推荐）** | 行业通用（"model provider"）；不与 `agents` 数组混淆 | 略长                                 |
| `agent`            | 最贴合用户心智（"选哪个 agent"）                    | **和 `config.agents[]` 撞名**，读代码必然困惑 |
| `vendor`           | 无歧义                                     | 偏采购语义                              |
| `backend`          | 无歧义                                     | 与前后端 backend 撞                     |

> **CLI/UI 文案一律说 "agent"（"Which agent?"），代码字段名用 `provider`。**  
> 用户心智与代码精确性各取所需。

---

## 3. Provider 目录：一张表取代两张

现状是两张表：`BRIDGES`（`AcpRuntime.ts:54`，按 basename）和 `KNOWN_ACP_COMMANDS`（`cli/src/lib.ts:44`）。  
它们会各自膨胀且必然不同步。**合并为一张 catalog。**

```ts
// packages/core/src/providers/catalog.ts  （新增）

export type ProviderId = "claude" | "opencode" | "codex" | "cursor" | (string & {})

export interface ProviderModel {
  id: string
  label: string
  tier?: "strong" | "balanced" | "fast"
  /** 该 tier 在同 provider 内的默认选择（每个 tier 恰好一个） */
  defaultForTier?: boolean
}

export interface ProviderSpec {
  id: ProviderId
  label: string

  /** 启动 ACP 的二进制 + 参数 */
  command: string
  args: string[]
  /** 历史名 / 备选名：既用于探测，也用于 bridge 反查（如 cursor 的 agent vs cursor-agent） */
  aliases?: string[]

  /** ACP 官方 ACP 之外，`_meta` 是角色提示词的唯一落点；没有就走 prompt 前缀 */
  meta?: (task: AgentTask) => Record<string, unknown> | undefined
  /** 这个 provider 是否真的吃 tool allowlist（诚实报告，不许虚报） */
  tools: boolean
  /** 模型如何下发 —— 决定 capabilities.models */
  modelSelection: "config-option" | "arg" | "none"

  models: ProviderModel[]
  defaultModel: string

  install: { hint: string; url?: string }
  /** 认证前置。目前只作为提示字符串，不参与判定（见 §4.3） */
  auth: { kind: "ambient" | "login" | "api-key" | "none"; hint: string }
  /** 可选：二进制名有歧义时，用 `--version` 输出确认身份（cursor 的 `agent` 必需） */
  confirm?: (versionOutput: string) => boolean
}

export const PROVIDERS: readonly ProviderSpec[] = [ /* claude, opencode, codex, cursor */ ]
```

### 3.1 与 `BRIDGES` 的衔接（不丢鲁棒性）

`BRIDGES` 按 **命令 basename** 分派，这个特性要保留：用户写死  
`command: "/opt/bin/claude-agent-acp"` 时，反查必须仍然命中。

```ts
// 由 catalog 派生，不是手写第二张表
const byCommand = new Map<string, ProviderSpec>()   // command + aliases → spec
export function specForCommand(command: string): ProviderSpec | undefined
export function specForProvider(id: ProviderId): ProviderSpec | undefined
```

`bridgeFor(command)` 改为查 `byCommand`；查不到 → `{ tools: false }`（无 meta → prompt 前缀降级）。  
**行为与今天逐字节一致。**

### 3.2 Cursor 条目（需求 ①）

已核实的事实（Cursor 官方文档，2026-10-11 查）：

- ACP 模式：`agent acp`，stdio + newline-delimited JSON-RPC。二进制官方名 **`agent`**；  
  社区适配器与旧文档用 **`cursor-agent`**。**两个名字都要探测。**
- 安装：`curl https://cursor.com/install | bash`。
- **认证必须前置**：`agent login`，或 `--api-key` / `CURSOR_API_KEY` / `--auth-token` / `CURSOR_AUTH_TOKEN`。  
  `-e`、`--api-key` 等参数要**写在 `acp` 之前**（`agent --api-key "$K" acp`）。
- 该命令官方定位是"隐藏、面向自建客户端"。
- 会读取项目根的 `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` 作为规则 —— 与我们的角色提示词可能冲突，需验证。

拟写入 catalog（**标注为待验证**）：

```ts
{
  id: "cursor",
  label: "Cursor",
  command: "cursor-agent",
  aliases: ["agent"],
  args: ["acp"],
  confirm: (v) => /cursor/i.test(v),      // `agent` 是极易撞名的通用词，必须确认
  meta: undefined,                        // 待验证；未确认前走 prompt 前缀降级
  tools: false,                           // 待验证
  modelSelection: "config-option",        // 待验证
  models: [ /* 待真机拉取 */ ],
  install: { hint: 'curl https://cursor.com/install | bash', url: "https://cursor.com/docs/cli/acp" },
  auth: { kind: "login", hint: "run `agent login` first (or set CURSOR_API_KEY)" },
}
```

**结论：有必要做。** 理由：

1. 接入成本极低 —— 目录一项 + 探测一项，不动任何已发布接口。
2. 它是 4 个目标里唯一我们还没覆盖的主流 agent，缺了它 init 的选择题就少一个答案。
3. 真正的不确定性（`_meta` 落点、auth）**不影响架构** —— 未知 provider 已经有明确的降级路径（prompt 前缀 + tools:false），  
   这和 opencode 今天的处境完全一样，而 opencode 是能用的。


**风险（必须写进文档）**：`agent` 是个极通用的名字，PATH 上撞名概率不低。  
`confirm` 校验是**强制项**，不是可选项 —— 否则我们会把用户的某个随机 `agent` 当成 Cursor 启动并 hang 在 stdio 上。

---

## 4. 本机探测（需求 ②）

### 4.1 API 形状

```ts
// packages/core/src/providers/detect.ts  （新增）
export type ProviderStatus = "present" | "missing"
export interface DetectedProvider {
  id: ProviderId
  label: string
  command: string          // 实际探测到的二进制名（可能是 alias）
  status: ProviderStatus
  version?: string         // 尽力而为，拿不到就 undefined
  note?: string            // 例如 "needs `agent login`"
}
export async function detectProviders(opts?: { withVersion?: boolean }): Promise<DetectedProvider[]>
```

### 4.2 三条硬约束

1. **可用性的唯一实现仍然是 `describe()`**。  
   `detectProviders()` 内部调 `runtimeRegistry.get("acp").describe({ command })` —— 不再有第二处 `execSync("which")`。  
   这条纪律是 `lib.ts:9-14` 的注释明确立下的，不能破。
2. **不能给 `AgentRuntime` 接口加方法。**  
   `AgentRuntime` 是已发布导出，加宽是破坏性变更。探测是**自由函数**，不是接口方法。
3. **`describe()` 必须保持"不 import SDK + 不 spawn"**。  
   它在 `run`/`tui` 的启动热路径上（`assertRuntimesAvailable`）。  
   `detectProviders({ withVersion: true })` 才允许 spawn `--version`，且**只在 init / doctor 里调用**。

### 4.3 刻意不做三态（important）

我**不建议** v1 做 `"ready" | "needs-auth" | "missing"` 三态。

理由：判定 "已认证" 要摸 `~/.claude/...`、`~/.codex/auth.json`、`~/.cursor/...` 这类**私有文件路径**，  
我们没有验证过任何一个，写进去就是编造。一个误报 "needs-auth" 会让用户去做本不需要的登录，  
比不报更糟。

**v1 做法**：二态 `present` / `missing` + 每个 provider 一行 `auth.hint` **提示字符串**，  
在 init 选中该 provider 后无条件打印：

```
✓ Cursor — cursor-agent 0.4.2
  Before your first run: run `agent login` (or set CURSOR_API_KEY)
```

真机验证把路径摸清之后，再升级为三态（Phase 5 的开放项）。

### 4.4 替换现有调用点

| 现在                                            | 改为                                             |
| --------------------------------------------- | ---------------------------------------------- |
| `cli/src/lib.ts:44 KNOWN_ACP_COMMANDS`        | 删除，改由 `PROVIDERS` 派生                           |
| `cli/src/lib.ts:47 availableRuntimes()`       | 删除，改为 `detectProviders({ withVersion: true })` |
| `cli/src/lib.ts:15 assertRuntimesAvailable()` | **保留**（硬门禁），内部 dedupe key 改用解析后的 command       |
| `cli/src/commands/init.ts:136 checkRuntime()` | 改为 `detectProviders()` 驱动，见 §5                 |

> `multiclaw doctor` 是否新增为一个子命令？→ §9 Q4。

---

## 5. init 交互设计（需求 ②+③+④）

### 5.1 问题流（典型 5 问，最少 4 问）

```
1  Project name            [input]    默认 = cwd basename                    （已有）
2  Team preset             [select]   backend / frontend / fullstack          （已有）
3  Which agent?            [select]   只列 present 的；missing 的仍列出并标 "(not installed)"
4  Model for the team      [select]   选项来自 ③ 选中 provider；末项 "Type a model id…"
5  Per-agent overrides?    [confirm]  默认 No  ← 关键，见 5.3
   5a [checkbox] 选要覆盖的 agent（含 Leader）
   5b 对每个选中的 agent 问 model
6  Work directory          [input]    默认 "."                                （已有）
```

**排序依据**：把新问句插在既有 1、2 之后，改动最小、用户肌肉记忆不被打断。  
provider 必须在 model 之前 —— 模型清单是 provider 的函数。

**第 3 问的细节**：

- 全都没装 → 全部列出、标 `(not installed)`、选择后打印 `install.hint`，**不阻断**（写配置不依赖二进制）。
- 装了多个 → 把 present 的排前面，默认选中第一个。
- `agent`(cursor) 只有 `confirm` 通过才计入 present。

### 5.2 核心设计：12 个 preset 不要问 12 遍

12 个角色 preset 现在各自写死了 claude 别名：  
`architect=opus`、`archDesignReviewer=haiku`、`backendDeveloper=sonnet`、`codeReviewer=haiku` …  
这是一份**现成的、有价值的"角色档位"知识**，只是被固化成了某家的模型名。

**方案 A（推荐）：把别名升级为档位声明。**

```ts
// 现在                              →  改成
models: { acp: "opus" }             →  models: { acp: "opus" },  modelTier: "strong"
models: { acp: "sonnet" }           →  models: { acp: "sonnet" }, modelTier: "balanced"
models: { acp: "haiku" }            →  models: { acp: "haiku" },  modelTier: "fast"
```

catalog 给每个 provider 标好 tier：

| tier     | claude   | codex            | opencode                         | cursor |
| -------- | -------- | ---------------- | -------------------------------- | ------ |
| strong   | `opus`   | `gpt-5-codex`(?) | `anthropic/claude-opus-4.5`(?)   | 待验证    |
| balanced | `sonnet` | `gpt-5`(?)       | `anthropic/claude-sonnet-4.5`(?) | 待验证    |
| fast     | `haiku`  | `gpt-5-mini`(?)  | `anthropic/claude-haiku-4.5`(?)  | 待验证    |

（非 claude 的模型 id **必须真机拉取**，不要照抄我的占位值。）

**收益**：用户只回答 1 个问题（团队默认档位），10 个 agent 各得其所，且**跨 provider 自动正确**。  
对 claude 而言解析结果与今天逐字一致 → 现有测试不受影响。

**方案 B（备选）：一个模型打天下 + 可选逐 agent 覆盖。**  
更简单，但丢掉了"架构师用强模型、评审用快模型"这份知识，10 个 agent 全跑 opus 会很贵。

### 5.3 逐 agent 覆盖：默认不问

12 个角色 × 1 个模型问题 = 12 问，任何人都会崩溃。**默认关掉。**

```
? Per-agent model overrides? (y/N)   ← 默认 N
```

选 y 才展开，且是 **checkbox 先筛**再问：

```
? Override which agents?  (space to select, enter to confirm)
❯◯ ★ Leader
 ◯ Architect
 ◯ Product Manager
 …
```

只对勾选的 agent 提问。**最坏情况 12 问，典型情况 0 问。**

### 5.4 生成的配置文件

目标：可读、可改、可 diff，**默认值不写进每个 agent**。

```ts
import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: "my-app",
  workDir: ".",
  context: { projectName: "my-app" },

  // 一行决定全队；删掉它就回到 preset 的档位默认值
  defaults: { provider: "codex", model: "gpt-5-codex" },

  agents: [
    agents.productManager(),
    agents.architect({ dependsOn: ["product-manager"] }),
    // 只有被显式覆盖的角色才带参数
    agents.archDesignReviewer({ dependsOn: ["architect"], model: "gpt-5-mini" }),
    …
  ],
})
```

收尾打印摘要（替换现在的 4 行）：

```
✓ Created multiclaw.config.ts
  preset     fullstack (10 agents)
  agent      codex  (codex-acp 2.2.2)
  model      gpt-5-codex  (strong: opus-equivalent tier per role)
  workDir    .
  Before your first run: `codex` login required — see `codex login --help`
```

> 若选中的 provider 状态是 missing，摘要里直接给 `install.hint`。

---

## 6. model 真正下发（需求 ③ 的前置，Phase 2 必做）

### 6.1 发送

```ts
// AcpRuntime.ts，session 建立之后、prompt 之前
if (task.model && spec?.modelSelection === "config-option") {
  try {
    await ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: "model", value: task.model,
    })
  } catch (err) { /* 见下 */ }
}
```

失败策略：**warn，不 fail**。模型选择是优化项不是正确性项 —— 因为一个模型 id 把整轮跑挂是本末倒置。  
发 `orchestration:warning`（已有该事件类型，不用新增事件，符合项目约定）。

### 6.2 发现清单并校验

`session/new` 响应里读 `configOptions`，取 `category === "model"`（或 `id === "model"`）那一项：

- 拿到清单 → 按 `command` 缓存进一个 `Map<string, ProviderModel[]>`（进程内，避免每轮重问）。
- 配置的 model 不在清单里 → 发 `orchestration:warning`：`Model "X" not offered by codex-acp; running with its default.`
- 没清单（agent 不支持 configOptions）→ 静默跳过，不刷屏。

### 6.3 capabilities 更新

`CAPABILITIES.models` 从常量 `false` 改为**随 provider 变化**：

```ts
models: spec?.modelSelection !== "none"
```

这与现有 `tools` 随 bridge 变化的做法一致（`AcpRuntime.ts:336`），是同一个模式的第二例。

### 6.4 有些 provider 可能根本不吃 configOptions

若验证发现某家不支持，落到 `modelSelection: "arg"` —— 在 `args` 里追加 CLI flag  
（如 `--model <id>`）。catalog 已经为这个留了字段。**不要在 AcpRuntime 里写 provider 特有分支**。

---

## 7. `--no-leader` 的重新定位（需求 ⑤）

### 7.1 事实

- `run` 是一次性批处理：**用户已经知道要跑谁**，跳过一次路由 LLM 调用是合理诉求。
- TUI 是迭代对话：leader 是路由器（run / reply / ask）。**关掉它 = 每条消息都跑满全队，且失去"问一句就有回答"的能力。**
- TUI 今天没有开关，但会静默遵守 config 里的 `useLeader:false`。

### 7.2 三个方案

|           | 做法                                                                                                                                                                                                            | 评价                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **A（推荐）** | `--no-leader` 保留、**仅限 `run`**，help 文案写明 "batch only；跳过路由，直接跑全队"。TUI **不提供**该开关；若 config 里 `useLeader:false`，TUI 顶部常驻一行 `⚠ leader off — every message runs the full team`。core 的 `useLeader?: boolean` **不动**。 | 改动最小；保留一次性覆盖能力；让 TUI 的降级**可见**而非静默                           |
| B         | 彻底删除 flag，只留 config `useLeader: false`。                                                                                                                                                                       | 表面最干净；但失去一次性覆盖（`--config` 是可接受的变通）。**`run` 的一次性诉求真实存在**，不建议砍 |
| C         | 升级为 `--leader auto\|on\|off`，`auto` = TUI 强制 on、run 按 config 走。                                                                                                                                               | 语义最准（把"TUI 不可或缺"编码进类型），但为一个布尔量引入三态枚举，性价比偏低                   |

**推荐 A**，另附一条硬要求：**init 不增加任何 leader 相关问题**。  
leader 是架构决策不是配置项，把它变成向导里的一问只会制造噪音。

### 7.3 若选 A，具体改动

```ts
// cli/src/index.ts:34
-.option("--no-leader", "Skip the leader agent and use the default pipeline")
+.option("--no-leader", "Batch mode only: skip routing and run the full team")

// dashboard: 新增一行提示（复用 StatusLine 上方区域），非 TTY / 测试不受影响
```

TUI 提示走现有 `TuiState` 的一个新可选字段（或直接从 `config.useLeader` 派生，不新增状态更好 ——  
**优先派生，不存**，符合项目"history 只存被顶替的轮次"那类克制）。

---

## 8. 落地计划

> 每阶段自带测试。**测试策略遵循项目约定：断言不变量不断言结果；写完回归测试先临时回退修复确认它变红。**  
> 覆盖率门槛是防倒退基线：core 90/85/90/90，cli 50/45/40/50，dashboard 90/85/90/90。

### Phase 0 — 止血文档（0.5h，可独立合并）

- `README.md` / `README.zh-CN.md` / `packages/cli/README.md`：runtime 默认从 `claude` 改为 `acp`；  
  删掉 "Future support: Codex, OpenCode, Cursor"；补 `provider` 与 `defaults` 说明。
- 不涉及代码，零风险。

### Phase 1 — Provider 目录（core）

- 新增 `packages/core/src/providers/catalog.ts`、`resolve.ts`（provider/command/model 解析的单一实现）。
- `AcpRuntime.ts`：`BRIDGES` → 由 catalog 派生的 `byCommand`；`bridgeFor` 改名 `specForCommand`。
- `cli/src/lib.ts`：删 `KNOWN_ACP_COMMANDS`，改由 catalog 派生。
- 测试：
  - `catalog.test.ts` —— 每个 provider 的 command/aliases 唯一；`defaultForTier` 每 tier 恰好一个。
  - `resolve.test.ts` —— §2.2 解析顺序的每一级；**老配置 `{command:"opencode", models:{acp:"sonnet"}}` 结果与改动前一致**（回归锚点）。
  - `specForCommand` 对路径、`.exe`/`.cmd` 后缀、大小写的行为与旧 `bridgeFor` 一致。
- **风险**：`agents/index.test.ts:42` 的 it.each 依赖 `models?.[runtime ?? "acp"]`，改动后必须仍绿（它是向后兼容的守卫，不要"顺手更新"。）

### Phase 2 — model 真下发（**阻塞需求 ③**）

- `AcpRuntime.ts`：session 建立后 `session/set_config_option`；读 `session/new` 的 `configOptions` 做校验与缓存。
- `CAPABILITIES.models` 改为随 provider 变化。
- 测试：fake agent 断言请求**被发出**（不变量）；清单不匹配时发 warning 且**不 fail**；不支持时静默跳过。
- **前置验证**（阻塞，需真机）：claude-agent-acp / codex-acp / opencode / cursor 各自是否返回 `configOptions`。  
  若某家不返回 → 该项 `modelSelection` 降级为 `"arg"` 或 `"none"`，并如实写进 catalog。

### Phase 3 — 探测 + Cursor 接入

- 新增 `packages/core/src/providers/detect.ts`；`availableRuntimes()` → `detectProviders()`。
- catalog 增加 cursor 条目（先标 `待验证`）。
- `assertRuntimesAvailable` 保持 SDK-free、不 spawn。
- 测试：PATH 打桩下 present/missing；`confirm` 拒绝非 cursor 的 `agent`；`describe()` 被调用的次数与命令集合（不变量）。
- **风险**：`agent` 撞名。`confirm` 为强制。

### Phase 4 — init 重构

- 新增 provider / model / 档位 / 逐 agent 覆盖；`defaults` 写进生成配置。
- `AgentDefinition.modelTier` + 12 个 preset 补 tier（若选方案 A）。
- 测试：`init` 目前**零测试**（`codegraph` 确认 "no tests found within 3 caller hops"）——  
  本次必须补：`generateConfig()` 是纯函数，最好测；把交互问句抽成 `planInit(answers)` 纯函数 + 薄薄的 inquirer 外壳，  
  就能在不 mock 终端的情况下覆盖全部组合。
- **风险**：`generateConfig` 现在靠 `JSON.stringify` 防注入（`init.ts:60` 注释），新模板必须保持这个性质。

### Phase 5 — no-leader 收敛

- 按 §7.3 改；TUI 加一行派生提示。
- 测试：TUI 提示来自 `config.useLeader` 派生；`run --no-leader` 仍设置 `useLeader=false`。

### Phase 6 — 文档与示例

- README / CONTRIBUTING / 两份 RELEASING 不受影响（发布流程没动）。
- `examples/dev-team` 补 `defaults` 示例 + 一个"混合 provider"示例（architect 用 claude，reviewer 用 codex 省钱）。

---

## 9. Q1–Q6 已拍板

| #      | 问题                                      | 决议 |
| ------ | --------------------------------------- | --- |
| **Q1** | 字段名用 `provider` / `agent` / `vendor`？     | `provider`（代码字段名）；UI 文案对用户说 "agent" |
| **Q2** | 12 个 preset 跨 provider 模型：方案 A（档位 tier）还是方案 B（单一模型）？ | **方案 A（档位 tier）** — 保留 preset 的强弱模型知识，跨 provider 自动正确 |
| **Q3** | `--no-leader`：A（run-only + TUI 提示）/ B（删除）/ C（三态 auto）？ | **A** — run-only；TUI 不暴露开关，若 `useLeader:false` 则常驻一行轻提示（非阻塞，小字） |
| **Q4** | 是否新增 `multiclaw doctor` 子命令？              | **做**，排 Phase 3 之后 |
| **Q5** | Cursor 现在就进 catalog，还是等真机验证完？           | **现在进**，标 `modelSelection: "config-option"` 待验证，降级路径已就绪 |
| **Q6** | 是否允许一个团队里混用 provider？                    | **core 支持，init v1 不暴露**，README 给手写示例 |

**本机探测结果（2026-10-11）**：`opencode` (1.19.0) ✓、`claude-agent-acp` (0.89.1) ✓、`codex-acp` (2.2.2) ✓、`claude` (2.1.278) ✓、`codex` (0.162.1) ✓、`cursor-agent` / `agent` ✗。

---

## 10. 必须在动手前验证的事实（阻塞项清单）

| #  | 待验证                                                       | 阻塞谁                | 怎么验                                         |
| -- | --------------------------------------------------------- | ------------------ | ------------------------------------------- |
| V1 | 各家是否返回 `configOptions`（category `model`），模型 id 长什么样       | **Phase 2 / 需求 ③** | 起一个最小 ACP client，逐个跑 `session/new` 打印响应     |
| V2 | cursor 的二进制是 `agent` 还是 `cursor-agent`（或两者都在）             | Phase 3            | `which agent cursor-agent` + `--version` 输出 |
| V3 | cursor 是否有 `_meta` 落点可放 system prompt                     | Phase 3            | 抓包 `session/new`，试几个命名空间                    |
| V4 | cursor 的 auth 前置（`agent login` 状态 / `CURSOR_API_KEY`）如何检测 | Phase 3 / §4.3     | 登出状态下跑一次，看报什么错                              |
| V5 | cursor 是否吃 tool allowlist                                 | Phase 3            | 同 V3                                        |
| V6 | opencode / codex-acp 的模型 id 真实取值                          | Phase 2            | 同 V1                                        |

> V1 是唯一"不做就整个需求 ③ 空转"的项，建议优先。

---

## 11. 明确不做（避免范围膨胀）

- 不动 `AgentRuntime` 接口（已发布导出，加宽即破坏性变更）。探测用自由函数。
- 不给 `describe()` 加 spawn / SDK import（在启动热路径上）。
- v1 不做三态认证判定（§4.3）。
- v1 不在 init 里暴露"混合 provider"（Q6）。
- 不改发布流程（RELEASING 两份 + trusted publisher 的 `release.yml` 文件名约束不受影响）。
