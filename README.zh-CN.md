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
- **工作目录** — Agent 读写文件的目录

### `multiclaw run <requirement> [options]`

按配置文件运行编排任务。

| 选项 | 说明 |
|------|------|
| `--config <path>` | 配置文件路径。省略时自动查找 `multiclaw.config.ts`。 |
| `--no-leader` | 跳过 leader agent，直接使用默认流水线。 |

`<requirement>` 字符串会以 `{{requirement}}` 的形式注入到每个 Agent 的 prompt 中。

每次运行都会在 `workDir` 下创建带时间戳的隔离子目录（如 `workspace/.multiclaw/runs/run-2026-10-08T12-00-00`），因此单次运行永远不会和磁盘上的其他内容互相干扰。交互式控制台则刻意不同——见 [工作区](#工作区)。

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

  agents: [
    {
      id: "architect",        // 唯一标识，用于 dependsOn 引用
      name: "架构师",          // 展示名称
      icon: "◆",              // 可选；在控制台中展示
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
| `name` | string | ✓ | 项目名称，在控制台标题栏展示。 |
| `workDir` | string | ✓ | Agent 读写文件的基础目录；控制台的每一轮共用它。 |
| `agents` | AgentDefinition[] | ✓ | Agent 流水线（见下方 Agent 字段说明）。 |
| `leader` | AgentDefinition | | 可选的路由 Agent（见 [Leader](#leader)）。 |
| `useLeader` | boolean | | 是否启用 leader agent。默认当配置了 leader 时为 `true`。 |
| `context` | Record<string, string> | | 可在每个 prompt 中通过 `{{key}}` 引用的变量，`requirement` 由 CLI 自动注入。 |
| `logDir` | string | | 日志输出目录，默认 `workDir/.multiclaw/logs`。 |
| `continueOnError` | boolean | | 某个 Agent 失败后是否继续运行，默认 `false`。 |
| `maxConcurrency` | number | | 最大并行 Agent 数，默认不限制。 |

### Agent 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | 唯一标识，在 `dependsOn` 中引用。 |
| `name` | string | ✓ | 在 Agent 列表中展示的名称。 |
| `taskPrompt` | string | ✓ | 发送给 AI Runtime 的 prompt，支持模板变量。 |
| `systemPrompt` | string | | 可选的系统 prompt，会拼接在 `taskPrompt` 前面。 |
| `icon` | string | | Agent 名称旁展示的 Unicode 图标。 |
| `description` | string | | 一句话角色说明，展示在控制台首屏的 Agent 名称旁。内置预设均已设置。 |
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

## 交互式控制台

不带子命令执行 `multiclaw` 会打开全屏终端控制台。它是**轮次式的指挥循环**，而不是聊天：你输入的每一轮就是整条流水线的一次完整编排，跑完后控制台保持打开，可以直接开始下一轮。

```
◆ multiclaw · dev-team                                          turn 2 · 00:12
────────────────────────────────────────────────────────────────────────────
✓ ◆ Leader  ──▸ ① ⠹ ◇ Architect  ──▸ ② ○ ◇ Developer  ──▸ ③ ○ ◇ Reviewer

TEAM                1/4 │ Architect · sonnet-4 · ⠹ running          4.2s ▼
  ✓ ◆ Leader       3.1s │ 读取 packages/core/src/orchestrator/…
› ⠹ ◇ Architect    4.2s │ 搜索 "withTimeout" in packages/core/src
  ○ ◇ Developer       — │ 编辑 utils/timeout.ts — 支持取消
  ○ ◇ Reviewer        — │ 执行 pnpm -r test

» 再补一下测试
› 输入以加入队列…
⠹ running 4.2s · 1/4 agents · 1 queued          enter queues · ctrl+c cancel
```

| 区域 | 内容 |
|------|------|
| 页眉 | 项目名、轮次编号，以及当前阶段或已用时 |
| 管线栏 | leader，随后按顺序排列各 Stage，用 `──▸` 连接 |
| 团队面板 | 每个 Agent 一行：状态符号、名称、实时耗时、进度（`1/4`） |
| 日志面板 | 当前聚焦 Agent 的实时输出，`▼` 表示跟随中、`⏸` 表示已定格 |
| 回复面板 | 这一轮无需流水线时，leader 给出的回答 |
| 回看横幅 | 打开历史轮次时显示 `viewing turn N …` |
| 队列条 | 运行期间输入的后继需求，按将要执行的顺序排列 |
| 输入行 | 输入位置——运行期间同样可输入 |
| 提示栏 | 左侧是汇总状态，右侧是**此刻可用**的按键 |

状态符号：`○` 排队 · `◐` 运行中（实时显示 spinner）· `↻` 重试中 · `✓` 完成 · `✗` 失败 · `⊘` 已跳过。

**首次启动**：第一轮开始之前，主体区域展示配置里的团队——每个 Agent 连同它的 `description`（这个 Agent 是做什么的）——而不是一片空白。`tab` 会让 `›` 光标在列表中下移；一旦某一轮开始运行，光标会自动跟随当前正在输出的 Agent。

**不是每一轮都需要动用团队。** 这由 leader 先做判断。你问它一个问题、或者只是打个招呼，它会直接用文字回答：主体区域切换为回复面板，页脚显示 `✓ answered`，没有任何 Agent 被启动。当需求确实是任务、但含糊到无法规划时，它会反过来提问——页脚显示 `? needs your input`，你接下来输入的那行就是回答。

### 按键

输入行始终持有焦点，因此只有两个键被保留：`?` 和 `/`，且仅在输入行为空**且控制台空闲**时生效。其余要么是具名按键，要么是普通字符——这正是"输入需求时不会误触快捷键"的原因。

| 按键 | 作用 |
|------|------|
| `enter` | 执行输入的需求；若当前有轮次在跑，则改为加入队列 |
| `tab` / `shift+tab` | 切换聚焦的 Agent |
| `↑` `↓` `pgup` `pgdn` | 滚动当前 Agent 的输出 |
| `←` `→` `home` `end` | 移动光标 |
| `esc` | 退出历史回看，清空输入行，或关闭浮层 |
| `?` | 快捷键帮助（空闲、且输入行为空时） |
| `/` | 命令面板（仅输入行为空时） |
| `ctrl+l` | 清空当前 Agent 的日志 |
| `ctrl+c` | 取消当前轮次**及其队列**；空闲时再按一次退出 |

向上滚动即定格日志，滚回底部自动恢复跟随——所以不需要记"跟随开关"。轮次运行期间，日志面板会自动跟随下一个启动的 Agent，直到你手动切换聚焦项为止。

**运行中输入**：输入行保持可用。运行期间提交的内容会进入输入行上方的队列条，并在控制台空闲的那一刻作为下一轮启动——所以看日志时冒出的想法不会被丢掉。取消会连同队列一起丢弃，因为"取消"就该意味着停下来。

取消会中止正在执行的 Agent 及其子进程，而不是把它们留在后台继续跑。

### 命令

在空输入行上输入 `/` 会弹出可筛选的命令列表。

| 命令 | 作用 |
|------|------|
| `/agents` | 列出配置的团队 |
| `/focus <id>` | 按 id 聚焦某个 Agent |
| `/clear` | 清空当前 Agent 的日志 |
| `/history` | 浏览已完成的轮次（见 [历史](#历史)） |
| `/cancel` | 取消当前轮次及其队列 |
| `/help` | 快捷键帮助 |
| `/quit` | 退出 |

控制台在备用屏幕缓冲区（alternate screen buffer）中渲染，因此终端的 scrollback 不会被破坏。

### 工作区

控制台是迭代式的，因此每一轮都跑在**同一个** `workDir` 上。像"给这个再补上测试"这样的后继需求，能看到上一轮写下的文件；同时 `task-plan.json` 会在每轮开始时清除，所以上一轮遗留的任务计划绝不会被重新套用到新需求上。

只有日志是按轮次隔离的：每一轮写入 `workDir/.multiclaw/runs/run-<时间戳>/logs/`，与 `multiclaw run` 的形状一致。运行目录是"发生过什么"的记录，而不是干活的地方。

### 历史

`/history` 会列出已完成的轮次，最新的在最上面，每轮带上结果、耗时、Agent 数量与需求原文。`↑` `↓` 选择，`enter` 打开某一轮进行回看：面板会渲染那一轮的团队、日志与管线，并显示 `viewing turn N` 横幅，按 `esc` 返回当前轮次。回看是无副作用的：滚动和 `tab` 只作用于你正在看的那一轮，绝不会影响仍在运行的轮次。

当前屏幕上那一轮不会被列出——它已经在你眼前了。控制台保留最近 20 个已完成的轮次。

终端较窄（不足 72 列）时会收起团队面板，让日志占满宽度；终端较矮（不足 16 行）时连管线栏也一并收起。页眉、输入行和提示栏永不收起。

> **没有 TTY？** 控制台需要交互式终端。在 CI、管道或非 TTY 的 SSH 会话中，它会直接退出并提示改用 `multiclaw run`——后者以无头方式运行同一条流水线。

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

`leader` 字段用于在主流水线执行前，加入一个路由 Agent。它会读取需求并检查代码库，然后决定这一轮究竟需要什么：

| 决策 | 含义 |
|------|------|
| `run` | 这是 leader 能划定范围的任务——列出最少需要哪些 Agent |
| `reply` | 一句问候、或一个它能当场回答的问题；不运行任何 Agent |
| `ask` | 确实是任务，但含糊到无法规划——它只问那个能解锁的问题 |

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

对于简单的 bug 修复，leader 可能只选择 `backend-developer` 和 `code-reviewer`，跳过设计阶段；对于全新功能，则运行完整流水线；而对于一句 `hello`，它直接回答，不为此花费任何 Agent。

leader 被要求输出单个 JSON 对象：

```json
{"mode": "run", "run": ["backend-developer", "code-reviewer"]}
{"mode": "reply", "message": "你好——告诉我你想改这个项目的哪一部分。"}
{"mode": "ask", "message": "目标数据库用哪个？"}
```

不带 `mode` 的 `{"run": [...]}` 仍然会被当作一次 `run`。除此之外 leader 写下的任何内容都会被当成它的回答——因此即使 leader 无视格式、直接用散文回复，这一轮也会以文字收尾，而不会把整支团队拖进一句问候里。

Agent ID 永远只是配置团队的**子集**。leader 编造出来的 id 会被当作警告丢弃，绝不会被添加。如果一次 `run` 没有命中任何已配置的 Agent，会作为失败上报，而不是渲染成一个"其实没人在干活"的绿色 done。

如果完全联系不上 leader——运行时失败，或没有任何输出——multiclaw 会给出警告并回退到运行完整的配置团队，因为需求本身可能仍然完全可执行。

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
pnpm dev        # 打开交互式控制台
pnpm run run    # ……或单次无头运行
```

## 贡献

开发流程与质量门禁见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

包的版本管理与发布流程见 [`RELEASING.zh-CN.md`](RELEASING.zh-CN.md) —— 其中说明了 release notes
是如何从 Pull Request 标题生成的。
