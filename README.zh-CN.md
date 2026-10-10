# multiclaw

[English](README.md)

多 Agent 编排 CLI。在配置文件中声明 Agent 流水线，指定需求，multiclaw 即可根据依赖关系并行或串行地驱动多个 AI Agent 完成任务。

## 前置条件

至少需要安装以下 AI Runtime 之一：

| Runtime | 安装命令 |
|---------|---------|
| `claude`（默认）| `npm install -g @anthropic-ai/claude-code` |

> **未来计划**：我们计划在后续版本中支持更多 Runtime（Codex、OpenCode、Cursor）。

## 安装

```bash
npm install -g multiclaw
```

## 快速开始

```bash
# 1. 在当前目录生成配置文件
multiclaw init

# 2. 运行编排任务
multiclaw run "构建一个 Todo 列表 REST API" --ui
```

`--ui` 会在浏览器中打开实时 Dashboard。不加该参数则在终端静默运行。

## 命令

### `multiclaw init`

交互式脚手架，在当前目录创建 `multiclaw.config.ts`。

交互提示：
- **项目名称** — 默认使用当前目录名
- **预设模板** — 选择流水线模板（见[预设模板](#预设模板)）
- **工作目录** — Agent 读写文件的目录

### `multiclaw run <requirement> [options]`

按配置文件运行编排任务。

| 选项 | 说明 |
|------|------|
| `--config <path>` | 配置文件路径。省略时自动查找 `multiclaw.config.ts`。 |
| `--ui` | 启动 Dashboard 服务并在浏览器中打开。 |
| `--port <port>` | Dashboard 端口。需配合 `--ui` 使用，默认 `3210`。 |
| `--server-url <url>` | 将事件推送到已运行的 `multiclaw serve` 实例。 |
| `--no-leader` | 跳过 leader agent，直接使用默认流水线。 |

`<requirement>` 字符串会以 `{{requirement}}` 的形式注入到每个 Agent 的 prompt 中。

每次运行都会在 `workDir` 下创建一个带时间戳的隔离子目录（如 `workspace/run-2026-10-08T12-00-00`）。

### `multiclaw serve [options]`

启动持久化 Dashboard 服务，适合 CI 环境或需要固定 URL 监控运行状态的场景。

| 选项 | 说明 |
|------|------|
| `--port <port>` | 监听端口，默认 `3210`。 |

通过 `multiclaw run "..." --server-url http://localhost:3210` 将某次运行连接到该服务。

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

  // 可选：在主流水线执行前，由 leader 决定需要运行哪些 agent。
  // leader 会读取需求并检查代码库，然后输出要运行的 agent ID 列表。
  leader: agents.leader(),

  logDir: "./logs",         // 可选；默认：workDir/.multiclaw/logs
  continueOnError: false,   // 可选；某个 Agent 失败后是否继续
  maxConcurrency: 4,        // 可选；同时运行的最大 Agent 数

  dashboard: {
    port: 3210,
    autoOpen: true,
  },

  agents: [
    {
      id: "architect",        // 唯一标识，用于 dependsOn 引用
      name: "架构师",          // 展示名称
      icon: "◆",              // 可选；在终端和 Dashboard 中展示
      runtime: "claude",      // 可选；默认 "claude"
      model: "opus",          // 可选；指定此 Agent 的模型
      systemPrompt: "你是一名软件架构师。", // 可选
      taskPrompt: `为 {{requirement}} 设计系统架构。
读取 {{file:brief.md}} 中的需求说明，并输出 architecture.md。`,
      tools: ["Read", "Write"],
      dependsOn: [],          // 可选；此 Agent 等待哪些 Agent 完成后再启动
      timeout: 600_000,       // 可选；超时时间（毫秒），默认 600 000（10 分钟）
      retries: 0,             // 可选；失败后重试次数，默认 0
      workDir: "architect",   // 可选；相对于全局 workDir 的子目录
    },
    {
      id: "developer",
      name: "开发者",
      model: "sonnet",        // 指定此 Agent 的模型
      taskPrompt: "读取 architecture.md 并实现代码。",
      tools: ["Read", "Write", "Bash"],
      dependsOn: ["architect"],
    },
  ],
})
```

### 顶层配置字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✓ | 项目名称，在 Dashboard 中展示。 |
| `workDir` | string | ✓ | Agent 读写文件的基础目录。 |
| `agents` | AgentDefinition[] | ✓ | Agent 流水线（见下方 Agent 字段说明）。 |
| `leader` | AgentDefinition | | 可选的路由 Agent（见 [Leader](#leader)）。 |
| `useLeader` | boolean | | 是否启用 leader agent。默认当配置了 leader 时为 `true`。 |
| `context` | Record<string, string> | | 可在每个 prompt 中通过 `{{key}}` 引用的变量，`requirement` 由 CLI 自动注入。 |
| `logDir` | string | | 日志输出目录，默认 `workDir/.multiclaw/logs`。 |
| `continueOnError` | boolean | | 某个 Agent 失败后是否继续运行，默认 `false`。 |
| `maxConcurrency` | number | | 最大并行 Agent 数，默认不限制。 |
| `dashboard.port` | number | | Dashboard 端口，默认 `3210`。 |
| `dashboard.autoOpen` | boolean | | 是否自动在浏览器中打开 Dashboard，默认 `true`。 |

### Agent 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | 唯一标识，在 `dependsOn` 中引用。 |
| `name` | string | ✓ | 在终端和 Dashboard 中展示的名称。 |
| `taskPrompt` | string | ✓ | 发送给 AI Runtime 的 prompt，支持模板变量。 |
| `systemPrompt` | string | | 可选的系统 prompt，会拼接在 `taskPrompt` 前面。 |
| `icon` | string | | Agent 名称旁展示的 Unicode 图标。 |
| `runtime` | string | | `claude`（默认）。更多 Runtime 支持敬请期待。 |
| `model` | string | | 指定此 Agent 使用的模型。例如 `"opus"`、`"sonnet"`、`"haiku"`。优先级高于 `models`。 |
| `models` | Record<string, string> | | Runtime 名称到模型名称的映射。当未设置 `model` 时使用。例如 `{ claude: "opus", openai: "gpt-4" }`。 |
| `tools` | string[] | | 允许使用的工具列表，默认 `["Read", "Write", "Bash"]`。 |
| `dependsOn` | string[] | | 必须在此 Agent 启动前完成的 Agent id 列表。 |
| `timeout` | number | | 单个 Agent 超时时间（毫秒），默认 `600000`（10 分钟）。 |
| `retries` | number | | 失败后的重试次数，默认 `0`。 |
| `workDir` | string | | 此 Agent 的工作目录（相对于全局 `workDir`）。 |

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

## Dashboard

实时 Web UI 展示内容：

- Stage 时间线及各 Agent 状态（运行中 / 完成 / 失败 / 已跳过）
- 每个 Agent 的实时日志流
- 每个 Agent 的耗时和重试次数
- 运行中显示已用时；完成后切换为总耗时

通过 `run --ui` 启动，或使用 `multiclaw serve` 运行持久化实例。

## 日志

每次运行结束后，所有生成文件统一写入 `workDir/.multiclaw/runs/run-<时间戳>/`（若设置了 `logDir` 则写入该目录）：

```
workDir/
└── .multiclaw/
    └── runs/
        └── run-2026-10-08T12-00-00/
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
| `simple` | 架构师 → 架构评审 → 后端开发 → 代码评审 | 4 |
| `backend` | 产品经理 → 架构师 → 架构评审 → 后端开发 → 测试 → 代码评审 + DevOps | 7 |
| `fullstack` | 产品经理 → 架构师 → 架构评审 → 后端开发 + UI 设计师 → UI 评审 → 前端开发 → 代码评审 + DevOps | 9 |

## Leader

`leader` 字段用于在主流水线执行前，加入一个路由 Agent。它会读取需求并检查代码库，然后决定本次任务实际需要运行哪些 Agent，未被选中的 Agent 会被跳过。

```typescript
export default defineConfig({
  leader: agents.leader(),
  agents: [
    agents.architect(),
    agents.archDesignReviewer({ dependsOn: ["architect"] }),
    agents.backendDeveloper({ dependsOn: ["arch-design-reviewer"] }),
    agents.codeReviewer({ dependsOn: ["backend-developer"] }),
  ],
})
```

对于简单的 bug 修复，leader 可能只选择 `backend-developer` 和 `code-reviewer`，跳过设计阶段；对于全新功能，则运行完整流水线。

如果 leader 执行失败或输出无效内容，multiclaw 会回退到运行所有 Agent。

### 禁用 Leader Agent

可以通过以下三种方式跳过 leader 并直接使用默认流水线：

1. **CLI 选项**（针对单次运行）：
   ```bash
   multiclaw run "你的需求" --no-leader
   ```

2. **配置文件**（运行时可通过环境变量或配置覆盖）：
   ```typescript
   export default defineConfig({
     leader: agents.leader(),
     useLeader: false, // 禁用 leader
     agents: [...],
   })
   ```

3. **从配置文件移除 leader**（始终使用默认流水线）：
   ```typescript
   export default defineConfig({
     // 不配置 leader 字段
     agents: [...],
   })
   ```

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

如果流水线中没有 architect Agent，开发者 Agent 会直接读取 `architecture.md` 和 `api-spec.md`。

## 示例

参见 [`examples/dev-team/`](examples/dev-team/)，这是一个完整的三 Agent 流水线（架构师 → 开发者 → 评审者）。

```bash
cd examples/dev-team
pnpm dev
```

## 贡献

开发流程与质量门禁见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

包的版本管理与发布流程见 [`RELEASING.zh-CN.md`](RELEASING.zh-CN.md) —— 其中明确了**什么情况下 Pull
Request 必须附带 changeset**。
