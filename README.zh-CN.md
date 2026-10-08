# multiclaw

[English](README.md)

多 Agent 编排 CLI。在配置文件中声明 Agent 流水线，指定需求，multiclaw 即可根据依赖关系并行或串行地驱动多个 AI Agent 完成任务。

## 前置条件

至少需要安装以下 AI Runtime 之一：

| Runtime | 安装命令 |
|---------|---------|
| `claude`（默认）| `npm install -g @anthropic-ai/claude-code` |
| `codex` | `npm install -g @openai/codex` |
| `opencode` | `npm install -g opencode` |
| `cursor` | `curl https://cursor.com/install \| bash` |

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
import { defineConfig } from "multiclaw"

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
      taskPrompt: "读取 architecture.md 并实现代码。",
      tools: ["Read", "Write", "Bash"],
      dependsOn: ["architect"],
    },
  ],
})
```

### Agent 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | 唯一标识，在 `dependsOn` 中引用。 |
| `name` | string | ✓ | 在终端和 Dashboard 中展示的名称。 |
| `taskPrompt` | string | ✓ | 发送给 AI Runtime 的 prompt，支持模板变量。 |
| `systemPrompt` | string | | 可选的系统 prompt，会拼接在 `taskPrompt` 前面。 |
| `icon` | string | | Agent 名称旁展示的 Unicode 图标。 |
| `runtime` | string | | `claude` \| `codex` \| `opencode` \| `cursor`，默认 `claude`。 |
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

## 示例

参见 [`examples/dev-team/`](examples/dev-team/)，这是一个完整的三 Agent 流水线（架构师 → 开发者 → 评审者）。

```bash
cd examples/dev-team
pnpm dev
```
