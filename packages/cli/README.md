# multiclaw

[![npm](https://img.shields.io/npm/v/multiclaw)](https://www.npmjs.com/package/multiclaw)
[![GitHub](https://img.shields.io/badge/GitHub-shipengqi%2Fmulticlaw-blue?logo=github)](https://github.com/shipengqi/multiclaw)

[中文](https://github.com/shipengqi/multiclaw/blob/main/README.zh-CN.md)

Multi-agent orchestration CLI. Define a pipeline of AI agents, give them a requirement, and watch them run in parallel or in sequence based on the dependency graph you declare.

## Prerequisites

At least one AI runtime must be installed:

| Runtime | Install |
|---------|---------|
| `claude` (default) | `npm install -g @anthropic-ai/claude-code` |

> **Future support:** We plan to add support for additional runtimes (Codex, OpenCode, Cursor) in upcoming releases.

## Install

```bash
npm install -g multiclaw
```

## Quick start

```bash
# 1. Scaffold a config in the current directory
multiclaw init

# 2. Run an orchestration
multiclaw run "Build a REST API for a todo list" --ui
```

`--ui` opens a real-time Dashboard in the browser. Omit it to run headless.

## Commands

### `multiclaw init`

Interactive scaffold. Creates `multiclaw.config.ts` in the current directory.

Prompts:
- **Project name** — defaults to the current directory name
- **Preset** — pipeline template (see [Presets](#presets))
- **Work directory** — where agents read and write files

### `multiclaw run <requirement> [options]`

Runs the orchestration defined in your config file.

| Option | Description |
|--------|-------------|
| `--config <path>` | Path to config file. Auto-discovers `multiclaw.config.ts` if omitted. |
| `--ui` | Start the Dashboard server and open it in the browser. |
| `--port <port>` | Dashboard port. Requires `--ui`. Default: `3210`. |
| `--server-url <url>` | Stream events to a running `multiclaw serve` instance. |
| `--no-leader` | Skip the leader agent and use the default pipeline directly. |

The `<requirement>` string is injected into every agent's prompt as `{{requirement}}`.

Each run creates an isolated timestamped subdirectory inside `workDir` (e.g. `workspace/run-2026-10-08T12-00-00`).

### `multiclaw serve [options]`

Start a persistent Dashboard server. Useful for CI or when you want a permanent URL to monitor runs.

| Option | Description |
|--------|-------------|
| `--port <port>` | Port to listen on. Default: `3210`. |

Connect a run to it with `multiclaw run "..." --server-url http://localhost:3210`.

## Config file

```typescript
// multiclaw.config.ts
import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: "My Project",
  workDir: "./workspace",

  // Variables available as {{key}} in every agent's taskPrompt.
  // `requirement` is automatically injected from the CLI argument.
  context: {
    projectName: "My App",
  },

  // Optional: runs before the main pipeline to decide which agents are needed.
  // The leader reads the requirement and the codebase, then outputs the agent IDs to run.
  leader: agents.leader(),

  logDir: "./logs",         // optional; default: workDir/.multiclaw/logs
  continueOnError: false,   // optional; keep running if an agent fails
  maxConcurrency: 4,        // optional; max agents running at once

  dashboard: {
    port: 3210,
    autoOpen: true,
  },

  agents: [
    {
      id: "architect",        // unique identifier, used in dependsOn
      name: "Architect",      // display name
      icon: "◆",              // optional; shown in terminal and dashboard
      runtime: "claude",      // optional; default: "claude"
      model: "opus",          // optional; override default model for this agent
      systemPrompt: "You are a software architect.", // optional
      taskPrompt: `Design the system for {{requirement}}.
Read the brief at {{file:brief.md}} and write architecture.md.`,
      tools: ["Read", "Write"],
      dependsOn: [],          // optional; list of agent ids this agent waits for
      timeout: 600_000,       // optional; ms, default: 600 000 (10 min)
      retries: 0,             // optional; retry count on failure, default: 0
      workDir: "architect",   // optional; subdirectory relative to global workDir
    },
    {
      id: "developer",
      name: "Developer",
      model: "sonnet",        // override model for this agent
      taskPrompt: "Read architecture.md and implement the code.",
      tools: ["Read", "Write", "Bash"],
      dependsOn: ["architect"],
    },
  ],
})
```

### Top-level config fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✓ | Project name, shown in the dashboard. |
| `workDir` | string | ✓ | Base directory where agents read and write files. |
| `agents` | AgentDefinition[] | ✓ | The agent pipeline (see Agent fields below). |
| `leader` | AgentDefinition | | Optional routing agent (see [Leader](#leader)). |
| `useLeader` | boolean | | Enable or disable the leader agent. Default: `true` when leader is configured. |
| `context` | Record<string, string> | | Variables available as `{{key}}` in every prompt. `requirement` is injected automatically. |
| `logDir` | string | | Log output directory. Default: `workDir/.multiclaw/logs`. |
| `continueOnError` | boolean | | Keep running when an agent fails. Default: `false`. |
| `maxConcurrency` | number | | Max agents running in parallel. Default: unlimited. |
| `dashboard.port` | number | | Dashboard port. Default: `3210`. |
| `dashboard.autoOpen` | boolean | | Open the dashboard in a browser automatically. Default: `true`. |

### Agent fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Unique identifier. Used in `dependsOn`. |
| `name` | string | ✓ | Display name shown in terminal and dashboard. |
| `taskPrompt` | string | ✓ | Prompt sent to the AI runtime. Supports template variables. |
| `systemPrompt` | string | | Optional system prompt prepended to `taskPrompt`. |
| `icon` | string | | Unicode icon shown next to the agent name. |
| `runtime` | string | | `claude` (default). Additional runtimes coming soon. |
| `model` | string | | Override the default model for this agent. E.g. `"opus"`, `"sonnet"`, `"haiku"`. Takes precedence over `models`. |
| `models` | Record<string, string> | | Map of runtime names to model names. Used when `model` is not set. E.g. `{ claude: "opus", openai: "gpt-4" }`. |
| `tools` | string[] | | Allowed tools. Default: `["Read", "Write", "Bash"]`. |
| `dependsOn` | string[] | | Agent ids that must complete before this agent starts. |
| `timeout` | number | | Per-agent timeout in ms. Default: `600000` (10 min). |
| `retries` | number | | Number of retry attempts on failure. Default: `0`. |
| `workDir` | string | | Subdirectory (relative to global `workDir`) for this agent's CWD. |

### Template variables

Two syntaxes are supported in `taskPrompt` and `systemPrompt`:

| Syntax | Replaced with |
|--------|--------------|
| `{{key}}` | The value of `context.key` (or `requirement` from the CLI). |
| `{{file:path/to/file}}` | The contents of that file, resolved relative to `workDir`. |
| `{{pipelineAgents}}` | List of all agents running in this pipeline (id: name). Auto-injected; useful for the architect to decompose tasks per agent. |

## Parallelism

Agents are grouped into stages by their dependency graph (topological sort). All agents within the same stage run concurrently. `maxConcurrency` caps how many run at once globally.

```
Stage 1:  product-manager
Stage 2:  architect
Stage 3:  backend-developer  │  ui-designer      ← parallel
Stage 4:  code-reviewer      │  devops            ← parallel
```

## Dashboard

The real-time web UI shows:

- Stage timeline with agent status (running / done / failed / skipped)
- Live streaming logs per agent
- Per-agent duration and retry count
- Elapsed time while running; total time on completion

Start it with `--ui` on `run`, or run `multiclaw serve` for a persistent instance.

## Logs

After each run, all generated files are written under `workDir/.multiclaw/runs/run-<timestamp>/` (or `logDir` if set):

```
workDir/
└── .multiclaw/
    └── runs/
        └── run-2026-10-08T12-00-00/
            ├── <agent output files>   ← files agents write (e.g. architecture.md)
            └── logs/
                ├── <agentId>.log      ← raw stdout per agent
                └── report.json        ← full orchestration result
```

| File | Contents |
|------|----------|
| `<agentId>.log` | Raw stdout from that agent's process |
| `report.json` | Full orchestration result (status, duration, output per agent) |

The log path is printed to the terminal at the start of every run.

## Presets

Presets are pipeline templates you can pick during `multiclaw init`:

| Preset | Pipeline | Agents |
|--------|----------|--------|
| `simple` | Architect → Arch Design Reviewer → Backend Developer → Code Reviewer | 4 |
| `backend` | Product Manager → Architect → Arch Design Reviewer → Backend Developer → Tester → Code Reviewer + DevOps | 7 |
| `fullstack` | Product Manager → Architect → Arch Design Reviewer → Backend Developer + UI Designer → UI Design Reviewer → Frontend Developer → Code Reviewer + DevOps | 9 |

## Leader

The `leader` field adds a routing agent that runs **before** the main pipeline. It reads the requirement and inspects the codebase, then decides which agents are actually needed for this task. Agents the leader omits are skipped.

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

For a minor bug fix the leader might decide only `backend-developer` and `code-reviewer` are needed, skipping the design stages. For a greenfield feature it runs the full pipeline.

If the leader fails or produces invalid output, multiclaw falls back to running all agents.

### Disabling the leader

You can skip the leader and use the default pipeline directly in three ways:

1. **CLI option** (for a single run):
   ```bash
   multiclaw run "your requirement" --no-leader
   ```

2. **Config file** (per-run, via environment variable or config override):
   ```typescript
   export default defineConfig({
     leader: agents.leader(),
     useLeader: false, // disable leader
     agents: [...],
   })
   ```

3. **Remove the leader from config** (always use the default pipeline):
   ```typescript
   export default defineConfig({
     // leader field omitted
     agents: [...],
   })
   ```

## Architect and Task Decomposition

When the **architect** agent is in your pipeline, it produces three outputs:

1. **architecture.md** — architecture plan and module breakdown
2. **api-spec.md** — complete API specification
3. **task-plan.json** — structured task breakdown for all implementation agents in the pipeline

The `task-plan.json` file helps coordinate work across parallel agents by explicitly assigning scope to each agent. Each implementation agent (backend-developer, frontend-developer, ui-designer, devops, tester, etc.) reads this file to understand its specific responsibilities and dependencies.

**Example task-plan.json:**
```json
{
  "projectName": "My App",
  "requirement": "Build a todo list API with React UI",
  "tasks": [
    {
      "id": "backend-developer",
      "title": "REST API",
      "scope": "Implement all endpoints per api-spec.md",
      "dependsOn": []
    },
    {
      "id": "frontend-developer",
      "title": "React UI",
      "scope": "Build React components following ui-design.md",
      "dependsOn": []
    },
    {
      "id": "devops",
      "title": "Deployment",
      "scope": "Containerize and set up CI/CD",
      "dependsOn": ["backend-developer", "frontend-developer"]
    }
  ]
}
```

If the architect is not in your pipeline, dev agents fall back to reading `architecture.md` and `api-spec.md` directly.

## Example

See [`examples/dev-team/`](https://github.com/shipengqi/multiclaw/tree/main/examples/dev-team) for a working three-agent pipeline (Architect → Developer → Reviewer).

```bash
cd examples/dev-team
pnpm dev
```

## License

[MIT](https://github.com/shipengqi/multiclaw/blob/main/LICENSE)
