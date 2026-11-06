# multiclaw

[English](README.md)

多 Agent 编排 CLI。在配置文件中声明 Agent 流水线，指定需求，multiclaw 即可根据依赖关系并行或串行地驱动多个 AI Agent 完成任务。

## 前置条件

multiclaw 可从任意已安装的 **Provider（提供方）** 编排 Agent。每个 Provider 都通过同一套
[Agent Client Protocol（ACP）](https://agentclientprotocol.com) 与 multiclaw 通信——底层
**runtime 永远都是 `acp`**；你选择的是 **Provider**，即具体的 Agent 产品。安装一个或多个：

| Provider | CLI | 安装命令 |
|----------|-----|---------|
| OpenCode | `opencode` | `npm install -g opencode` |
| Claude | `claude-agent-acp`（已内置） | 安装 Claude Code CLI（`claude`）并运行 `claude` 登录 |
| Codex | `codex-acp`（已内置） | 安装 Codex CLI（`codex`）并运行 `codex login` |
| Cursor | `cursor-agent` | `curl https://cursor.com/install \| bash` |

`multiclaw init` 会自动检测已安装的 Provider 并只提供这些选项；`multiclaw doctor` 则展示完整情况
（已安装版本、鉴权提示、可用模型）。Codex 和 Cursor 在运行前需要配置 API Key 或登录。

## 安装

```bash
npm install -g multiclaw
```

## 快速开始

```bash
# 1. 在当前目录生成配置文件
multiclaw init

# 2. 打开交互式控制台
multiclaw

# ……或单次无头运行
multiclaw run "构建一个 Todo 列表 REST API"
```

不带子命令的 `multiclaw` 会打开全屏终端控制台；需要无头执行（CI、管道输出）时用 `multiclaw run`。

## 命令

### `multiclaw init`

交互式脚手架，在当前目录创建 `multiclaw.config.ts`。

交互提示：
- **项目名称** — 默认使用当前目录名
- **预设模板** — 选择流水线模板（见[预设模板](#预设模板)）
- **Agent 产品** — 选择使用哪个 Provider（`claude`、`opencode`、`codex`、`cursor`）。只提供已安装的 Provider；未安装的项会附带安装提示。
- **工作目录** — Agent 读写文件的目录

选项：

| 选项 | 说明 |
|------|------|
| `--force` | 覆盖已存在的 `multiclaw.config.ts` |

### `multiclaw doctor`

诊断本地环境：哪些 Provider 已安装（含版本）、各自需要什么鉴权、各暴露多少模型，以及当前配置中的 Agent 是否都能解析到已安装的 Provider。若没有任何可用 Provider，退出码为非 0。

```bash
multiclaw doctor                                      # 完整环境检查
multiclaw doctor --config ./multiclaw.config.ts       # 同时校验配置
```

### `multiclaw run <requirement> [options]`

按配置文件运行编排任务。

| 选项 | 说明 |
|------|------|
| `--config <path>` | 配置文件路径。省略时自动查找 `multiclaw.config.ts`。 |
| `--dry-run` | 预览路由计划，不实际运行流水线。 |
| `--resume [path]` | 续跑上一次运行（继续 Agent 会话），可指定具体运行目录，默认为最新一次运行。 |

`<requirement>` 字符串会以 `{{requirement}}` 的形式注入到每个 Agent 的 prompt 中。

每次运行都会在 `workDir` 下创建带时间戳的隔离子目录（如 `workspace/.multiclaw/runs/run-2026-10-08T12-00-00-<execution-id>`），因此单次运行永远不会和磁盘上的其他内容互相干扰。交互式控制台则刻意不同——见 [交互式控制台](#交互式控制台)。

### `multiclaw upgrade`

将 multiclaw 升级到最新版本。

### `multiclaw prune`

交互式清理已保存的会话和旧运行目录。

| 选项 | 说明 |
|------|------|
| `--sessions` | 仅清理已保存的会话（非交互式） |
| `--runs` | 仅清理所有运行目录（非交互式） |
| `--all` | 清理全部（非交互式） |
| `--dry-run` | 仅展示将被删除的内容，不实际删除 |
| `--yes` | 跳过确认提示 |


## Provider、模型与层级

两个概念让配置保持简洁且与 Provider 无关：

- **`runtime` 与 `provider`**。*runtime* 是 multiclaw 与 Agent 通信所用的协议——目前始终是 `acp`（[Agent Client Protocol](https://agentclientprotocol.com)）。*provider* 是具体的 Agent 产品（`claude`、`opencode`、`codex`、`cursor`）。因此 `runtime` 是常量；`provider` 是你需要选择的那个。
- **模型层级（Model Tiers）**。Agent 无需硬编码某个仅存在于特定 Provider 的模型 id，而是声明一个**层级**——`strong`、`balanced` 或 `fast`。内置目录会将每个层级映射到*各 Provider* 对应的具体模型 id（例如 Claude 上的 `strong` → `opus`，OpenCode 上的 `strong` → `opencode/exo-free`）。这样同一份预设配置可在任意 Provider 上直接运行，切换 Provider 只会改变解析出的模型。

Agent 模型的解析优先级（从高到低）：

1. **`agent.model`**（显式指定的具体模型 ID，最高优先级）
2. **`agent.models[provider]`**（当前 Provider 对应的模型映射）
3. **`config.defaults.model`**（项目全局默认模型，适用于所有未显式覆盖模型的 Agent 和 Coordinator）
4. **`agent.modelTier`**（通过当前 Provider Catalog 将 `strong` / `balanced` / `fast` 自动映射为该 Provider 的对应模型）
5. **`agent.models["acp"]`**（兼容旧版配置的历史全局别名兜底）
6. **Provider Catalog 的默认模型**（例如 OpenCode 为 `opencode/big-pickle`，Claude 为 `sonnet`）

在配置顶部写一行 `defaults: { provider, model }` 即可为项目内所有 Agent（包括 Coordinator）提供统一默认模型，极少需要重复配置。

> **💡 说明**：
> - **全局默认覆盖**：设置 `defaults.model` 后，所有内置 Agent 和后台协调器（Coordinator）均会自动采用该模型；仅当某个特定 Agent 需要使用不同模型时，才需在该 Agent 参数中传入 `model` 覆盖。
> - **自动跨平台适配**：当未设置 `defaults.model` 时，内置 Agent 会根据自身的 `modelTier` 自动匹配各 Provider 的最佳模型（例如 Claude 上架构师自动选用 `opus`，OpenCode 上自动选用 `opencode/exo-free`）。
> - **Provider 模型 ID 格式**：使用 OpenCode 时，模型 ID 需遵循 `<provider>/<model>` 完整格式（如 `hai-google/gemini-3.8-flash`）。

## 配置文件

```typescript
// multiclaw.config.ts
import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: "我的项目",
  workDir: "./workspace",

  // 可在每个 Agent 的 taskPrompt 中通过 {{key}} 引用。
  // `requirement` 由 CLI 参数自动注入。
  context: {
    projectName: "我的应用",
  },


  logDir: "./logs",         // 可选；默认：workDir/.multiclaw/logs
  continueOnError: false,   // 可选；某个 Agent 失败后是否继续
  maxConcurrency: 4,        // 可选；同时运行的最大 Agent 数

  // 项目级默认值，应用到所有未单独覆盖的 Agent。
  // 一行即可替代在十二个预设 Agent 间重复填写 Provider 与模型。
  defaults: {
    provider: "claude",     // 团队运行在哪个 Agent 产品上
    model: "sonnet",        // 默认模型（可被单个 Agent 覆盖）
  },

  agents: [
    {
      id: "architect",        // 唯一标识，用于 dependsOn 引用
      name: "架构师",          // 展示名称
      icon: "◆",              // 可选；在控制台中展示
      provider: "claude",     // 可选；默认取 config.defaults.provider
      modelTier: "strong",    // 可选；"strong" | "balanced" | "fast"
      model: "opus",          // 可选；覆盖此 Agent 的层级/默认模型
      systemPrompt: "你是一名软件架构师。", // 可选
      taskPrompt: `为 {{requirement}} 设计系统架构。
读取 {{file:brief.md}} 中的需求说明，并输出 architecture.md。`,
      permissions: { mode: "ask" }, // 可选；在此 Agent 上覆盖项目级模式
      dependsOn: [],          // 可选；此 Agent 等待哪些 Agent 完成后再启动
      timeout: 1_800_000,     // 可选；超时时间（毫秒），默认 1 800 000（30 分钟）
      retries: 0,             // 可选；失败后重试次数，默认 0
      workDir: "architect",   // 可选；相对于全局 workDir 的子目录
    },
    {
      id: "developer",
      name: "开发者",
      model: "sonnet",        // 指定此 Agent 的模型
      taskPrompt: "读取 architecture.md 并实现代码。",
      dependsOn: ["architect"],
    },
  ],
})
```

### 顶层配置字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✓ | 项目名称，在控制台标题栏展示。 |
| `workDir` | string | ✓ | Agent 读写文件的基础目录；控制台的每一轮共用它。 |
| `agents` | AgentDefinition[] | ✓ | Agent 流水线（见下方 Agent 字段说明）。 |
| `defaults` | object | | 项目级 `{ provider?, model?, command?, permissions? }` 默认值，应用到所有未单独覆盖的 Agent，使生成的配置更简洁。 |
| `context` | Record<string, string> | | 可在每个 prompt 中通过 `{{key}}` 引用的变量，`requirement` 由 CLI 自动注入。 |
| `logDir` | string | | 日志输出目录，默认 `workDir/.multiclaw/logs`。 |
| `continueOnError` | boolean | | 某个 Agent 失败后是否继续运行，默认 `false`。 |
| `maxConcurrency` | number | | 最大并行 Agent 数，默认不限制。 |
| `permissions` | object | | 权限模式：`{ mode: "auto" \| "ask" \| "deny", onRequest? }`。`"auto"` 批准所有工具请求，`"ask"` 把每个请求交给 `onRequest`，`"deny"` 全部拒绝。默认：`run` 为 `"auto"`，控制台为 `"ask"`。 |

### 多轮评审与返工

用顶层 `reviewGates` 把架构评审、UI 评审、测试和代码评审设为流水线关卡。每个策略指定 `reviewer`、`repairAgents` 和 `maxRepairRounds`；位置由 reviewer 的 `dependsOn` 决定。不通过时串行修复并重新验收，通过后才执行下游。代码评审的修复列表应包含 tester，确保修改后重新测试；tester 再次调用时仍沿用本轮已消耗的预算。

新生成的团队配置启用对应关卡，每个关卡最多修复三轮；已有配置需要加入 `reviewGates`。原有 `review` 仍用于流水线末尾的最终验收。内置验收角色保留报告并返回结构化结论；预算耗尽或无效结论会停止流水线。详见[配置与验证证据](docs/multi-agent-rework.md)。

### Agent 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | 唯一标识，在 `dependsOn` 中引用。 |
| `name` | string | ✓ | 在 Agent 列表中展示的名称。 |
| `taskPrompt` | string | ✓ | 发送给 AI Runtime 的 prompt，支持模板变量。 |
| `systemPrompt` | string | | 可选的系统 prompt，会拼接在 `taskPrompt` 前面。 |
| `icon` | string | | Agent 名称旁展示的 Unicode 图标。 |
| `description` | string | | 一句话角色说明，展示在控制台首屏的 Agent 名称旁。内置预设均已设置。 |
| `provider` | string | | 此 Agent 运行在哪个 Agent 产品上：`claude`、`opencode`、`codex` 或 `cursor`。默认取 `config.defaults.provider`。所有 Provider 都使用同一套 `acp` runtime。 |
| `runtime` | string | | **已废弃。** 当前永远是 `"acp"`，请改用 `provider`。保留仅为兼容旧配置。 |
| `modelTier` | `"strong"` \| `"balanced"` \| `"fast"` | | 声明此 Agent 所需的能力层级；目录会把每个层级映射到该 Provider 对应的具体模型 id。设置了 `model` 时此项被忽略。 |
| `model` | string | | 指定此 Agent 的模型 id（与 Provider 相关，例如 Claude 的 `"opus"`、`"sonnet"`、`"haiku"`）。优先级高于 `modelTier` 和 `models`。 |
| `models` | Record<string, string> | | Provider id（或旧别名 `"acp"`）到模型 id 的映射，例如 `{ claude: "sonnet", opencode: "opencode/big-pickle" }`。当未设置 `model`/`modelTier` 时使用。 |
| `permissions` | `{ mode: "auto" \| "ask" \| "deny" }` | | 该 Agent 工具调用的审批模式。覆盖 `permissions` 与 `defaults.permissions`。 |
| `dependsOn` | string[] | | 必须在此 Agent 启动前完成的 Agent id 列表。 |
| `timeout` | number | | 单个 Agent 每次尝试的超时时间（毫秒），默认 `1800000`（30 分钟）；长任务可配置更大的值。 |
| `retries` | number | | 失败后的重试次数，默认 `0`。 |
| `workDir` | string | | 此 Agent 的工作目录（相对于全局 `workDir`）。 |

开发类 Agent 可以单独配置更长的超时时间，例如 60 分钟：

```ts
agents.backendDeveloper({ timeout: 60 * 60 * 1000 })
```

### 模板变量

`taskPrompt` 和 `systemPrompt` 中支持两种语法：

| 语法 | 替换内容 |
|------|---------|
| `{{key}}` | `context.key` 的值（`requirement` 由 CLI 参数自动注入）。 |
| `{{file:path/to/file}}` | 该文件的内容，路径相对于 `workDir` 解析。 |
| `{{pipelineAgents}}` | 本次运行中参与的所有 Agent 列表（id: name）。自动注入；主要用于 Architect 根据实际参与的 Agent 分解任务。 |

## 并行执行

multiclaw 对 Agent 依赖关系进行拓扑排序，将无依赖关系的 Agent 归入同一 Stage 并发执行。`maxConcurrency` 限制全局同时运行的 Agent 数量上限。

```
Stage 1:  product-manager
Stage 2:  architect
Stage 3:  backend-developer  │  ui-designer      ← 并行
Stage 4:  code-reviewer      │  devops            ← 并行
```

## 交互式控制台

运行 multiclaw 打开 Ink 终端 UI。启动显示空白主聊天和左侧 sessions，首次发送才保存 session。--resume <id> 打开指定聊天，无 ID 时聚焦列表；不存在的 ID 明确报错。

中央输入框始终与当前 session 的内置协调者对话。右侧 team 默认隐藏，选择 agent 只改变查看内容。窄终端使用临时查看器。

| 按键 | 操作 |
| --- | --- |
| Ctrl+B | 聚焦 sessions，方向键选择，Enter 打开 |
| Ctrl+T | 打开或聚焦 team，方向键选择 agent |
| Ctrl+G | 进入当前权限请求、提问或 checkpoint |
| Esc | 返回主聊天，不回答请求 |
| Shift+Tab | 切换当前聊天的权限模式 |
| Ctrl+C | 停止当前聊天的工作 |
| Ctrl+D | 停止全部执行，保存后退出 |
| Ctrl+V | 粘贴文本或图片 |
| Alt+Backspace | 移除最后一张附件图片 |
| 方向键、PageUp/PageDown | 滚动当前输出 |
| 空输入时 ? | 帮助 |

粘贴或拖入 PNG、JPEG、GIF、WebP 的绝对路径会识别为图片附件，支持引号及转义空格。输入框显示附件数量，可以继续输入文字后按 Enter，也可以只发送图片。图片路径不会被当成 `/` 命令。切换聊天时，附件随各自的草稿保留。

team 执行期间，协调者继续回答进度、澄清需求并定向传达补充。独立新任务进入执行队列；明确替换先停止旧任务，含义不明确时追问。

依赖关系继续约束执行。追加要求更新需求版本，受影响的实现、下游测试和评审重新执行后才能完成。不支持运行中追加的 provider 在当前调用结束后处理补充；已投递不代表已实现，结果未知的投递不会自动重发。

每个 session 独立拥有运行时、草稿、队列与交互。切换不停止工作；不同聊天共享 workDir 并行执行，不提供文件冲突仲裁，maxConcurrency 按每个聊天生效。后台提问在原 session 标记“需要输入”，普通聊天回复不会批准权限或回答结构化请求。

| 命令 | 操作 |
| --- | --- |
| /new | 新建空白聊天，其他工作继续 |
| /focus [agent] | 在右侧查看 agent |
| /steer <agent> <text> | 显式补充指定 agent |
| /mode auto / ask / deny | 切换实时权限模式 |
| /retry [agent] | 固定 agent 集合续跑已知工作 |
| /replay [turn] | 空闲时重跑历史需求 |
| /edit | 将最近需求复制到输入框 |
| /search [text]、/latest | 搜索或回到最新输出 |
| /verbose | 切换工具详细输出 |
| /pause、/continue | 暂停或恢复队列 |
| /export [path] | 导出聊天 Markdown |

运行中的 session 先停止再删除，删除前确认。退出停止全部执行并等待清理和保存。重启恢复中断事实与暂停队列，明确继续后才执行；旧 RPC 不恢复为可回答状态。

journal 使用版本 2。旧历史或损坏数据标记为不支持，保留原文件且不覆盖，不提供迁移。/sessions 与 multiclaw sessions 已移除，通过侧栏管理或 multiclaw prune 批量清理。


## 日志

每次运行结束后，所有生成文件统一写入 `workDir/.multiclaw/runs/run-<时间戳>/`（若设置了 `logDir` 则写入该目录）：

```
workDir/
└── .multiclaw/
    └── runs/
        └── run-2026-10-08T12-00-00-<execution-id>/
            ├── <agent 产出文件>        ← agent 写的文件（如 architecture.md）
            └── logs/
                ├── <agentId>.log      ← 该 agent 进程的原始标准输出
                └── report.json        ← 完整编排结果
```

| 文件 | 内容 |
|------|------|
| `<agentId>.log` | 该 Agent 进程的原始标准输出 |
| `report.json` | 完整编排结果（每个 Agent 的状态、耗时、输出） |

每次运行开始时，日志路径会打印到终端。


## 预设模板

执行 `multiclaw init` 时可选择以下预设模板：

| 模板 | 流水线 | Agent 数 |
|------|--------|---------|
| `backend` | 产品经理 → 架构师 → 架构评审 → 后端开发 → 测试 → 代码评审 → DevOps | 7 |
| `frontend` | 架构师 → UI 设计师 → UI 评审 → 前端开发 → 测试 → 代码评审 | 6 |
| `fullstack` | 产品经理 → 架构师 → 架构评审 → 后端开发 + UI 设计师 → UI 评审 → 前端开发 → 测试 → 代码评审 → DevOps | 10 |

## 内置协调者

协调者负责对话、澄清、派工和结果汇总，始终存在且不属于 team。协调者采用项目 defaults 的 provider、command 和 model，缺省沿用 provider 解析规则。

移除旧 leader 和 useLeader 配置；agents.leader() 和 --no-leader 不再支持。固定 agent 的 retry/resume 保留执行集合，完成后仍汇总。汇总失败不覆盖执行或验收结果。


## 架构师与任务分解

当 **architect**（架构师）Agent 在流水线中时，它会产出三个输出文件：

1. **architecture.md** — 架构设计与模块分解
2. **api-spec.md** — 完整的 API 规范
3. **task-plan.json** — 针对流水线中所有实现类 Agent 的结构化任务分解

`task-plan.json` 文件帮助多个并行 Agent 明确分工，每个实现类 Agent（backend-developer、frontend-developer、ui-designer、devops、tester 等）读取该文件来了解自己的具体职责和依赖关系。

**task-plan.json 示例：**
```json
{
  "projectName": "我的应用",
  "requirement": "构建一个 Todo 列表 REST API 和 React UI",
  "tasks": [
    {
      "id": "backend-developer",
      "title": "实现 REST API",
      "scope": "根据 api-spec.md 实现全部端点",
      "dependsOn": []
    },
    {
      "id": "frontend-developer",
      "title": "实现 React UI",
      "scope": "根据 ui-design.md 实现 React 组件",
      "dependsOn": []
    },
    {
      "id": "devops",
      "title": "容器化与 CI/CD",
      "scope": "编写 Dockerfile、docker-compose 和 CI 流水线",
      "dependsOn": ["backend-developer", "frontend-developer"]
    }
  ]
}
```

未选中 planner 时，执行者直接按配置依赖和职责工作。已有设计文件可供参考；缺失文件不阻塞执行，也不要求补写架构文档。

## 示例

参见 [`examples/dev-team/`](examples/dev-team/)，这是一个完整的三 Agent 流水线（架构师 → 开发者 → 评审者）。

```bash
cd examples/dev-team
pnpm dev        # 打开交互式控制台
pnpm run run    # ……或单次无头运行
```

## 贡献

开发流程与质量门禁见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

包的版本管理与发布流程见 [`RELEASING.zh-CN.md`](RELEASING.zh-CN.md) —— 其中说明了 release notes
是如何从 Pull Request 标题生成的。
