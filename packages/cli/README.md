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

# 2. Open the interactive console
multiclaw

# ...or run a single orchestration headlessly
multiclaw run "Build a REST API for a todo list"
```

`multiclaw` with no subcommand opens a full-screen terminal console. Use `multiclaw run` for
headless execution (CI, piped output).

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
| `--no-leader` | Skip the leader agent and use the default pipeline directly. |

The `<requirement>` string is injected into every agent's prompt as `{{requirement}}`.

Each run creates an isolated timestamped subdirectory inside `workDir` (e.g. `workspace/.multiclaw/runs/run-2026-10-08T12-00-00`).

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

  agents: [
    {
      id: "architect",        // unique identifier, used in dependsOn
      name: "Architect",      // display name
      icon: "◆",              // optional; shown in the console
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
| `name` | string | ✓ | Project name, shown in the console header. |
| `workDir` | string | ✓ | Base directory where agents read and write files. Every console turn shares it. |
| `agents` | AgentDefinition[] | ✓ | The agent pipeline (see Agent fields below). |
| `leader` | AgentDefinition | | Optional routing agent (see [Leader](#leader)). |
| `useLeader` | boolean | | Enable or disable the leader agent. Default: `true` when leader is configured. |
| `context` | Record<string, string> | | Variables available as `{{key}}` in every prompt. `requirement` is injected automatically. |
| `logDir` | string | | Log output directory. Default: `workDir/.multiclaw/logs`. |
| `continueOnError` | boolean | | Keep running when an agent fails. Default: `false`. |
| `maxConcurrency` | number | | Max agents running in parallel. Default: unlimited. |

### Agent fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Unique identifier. Used in `dependsOn`. |
| `name` | string | ✓ | Display name shown in the agent list. |
| `taskPrompt` | string | ✓ | Prompt sent to the AI runtime. Supports template variables. |
| `systemPrompt` | string | | Optional system prompt prepended to `taskPrompt`. |
| `icon` | string | | Unicode icon shown next to the agent name. |
| `description` | string | | One-line role, shown beside the agent's name on the console's first screen. Every built-in preset sets one. |
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

## Interactive console

`multiclaw` with no subcommand opens a full-screen terminal console. It is a **turn-based
conductor loop**, not a chat: each turn you type is one complete orchestration run of the whole
pipeline, and the console stays open so you can run the next one.

```
◆ multiclaw · dev-team                                          turn 2 · 00:12
────────────────────────────────────────────────────────────────────────────
✓ ◆ Leader  ──▸ ① ⠹ ◇ Architect  ──▸ ② ○ ◇ Developer  ──▸ ③ ○ ◇ Reviewer

TEAM                1/4 │ Architect · sonnet-4 · ⠹ running          4.2s ▼
  ✓ ◆ Leader       3.1s │ Read packages/core/src/orchestrator/…
› ⠹ ◇ Architect    4.2s │ Grep "withTimeout" in packages/core/src
  ○ ◇ Developer       — │ Edit utils/timeout.ts — abort-safe
  ○ ◇ Reviewer        — │ Bash pnpm -r test

» also add tests
› type to queue a follow-up…
⠹ running 4.2s · 1/4 agents · 1 queued          enter queues · ctrl+c cancel
```

| Region | Shows |
|--------|-------|
| Header | Project name, turn number, and the phase or elapsed time |
| Pipeline rail | The leader, then each stage in order, joined by `──▸` |
| Team panel | One row per agent: status glyph, name, live time, and progress (`1/4`) |
| Stream panel | Live output of the focused agent, with a `▼` live / `⏸` parked marker |
| Reply panel | What the leader answered, when a turn needed no pipeline |
| Review banner | `viewing turn N …` while a past turn is open |
| Queue strip | Follow-ups typed mid-run, in the order they will run |
| Prompt | Where you type — live even while a turn is running |
| Hint bar | Aggregate status on the left, the keys that work *right now* on the right |

Status glyphs: `○` queued · `◐` running (a spinner while live) · `↻` retrying · `✓` done ·
`✗` failed · `⊘` skipped.

**First run.** Before the first turn the body shows the team from your config — each agent with the
`description` of what it is for — rather than an empty pane. `tab` moves the `›` caret down the list;
once a turn is running the caret follows whichever agent is speaking.

**Not every turn needs the team.** The leader decides that first. Ask it a question, or say hello,
and it answers in prose: the body swaps to the reply, the footer reads `✓ answered`, and no agent
runs. When the request is a real task but too vague to plan, the leader asks instead — the footer
reads `? needs your input` and your next line is the answer.

### Keys

The prompt always holds focus, so exactly two keys are reserved: `?` and `/`, and only while the
line is empty *and* the console is idle. Everything else is a named key or an ordinary character,
which is what keeps typing a requirement from tripping over shortcuts.

| Key | Action |
|-----|--------|
| `enter` | Run the typed requirement — or queue it while a turn is running |
| `tab` / `shift+tab` | Cycle the focused agent |
| `↑` `↓` `pgup` `pgdn` | Scroll the focused agent's stream |
| `←` `→` `home` `end` | Move the caret |
| `esc` | Stop reading a past turn, clear the line, or close an overlay |
| `?` | Key map (idle, empty line only) |
| `/` | Command menu (empty line only) |
| `ctrl+l` | Clear the focused agent's log |
| `ctrl+c` | Cancel the running turn *and its queue*; again when idle to quit |

Scrolling up parks the stream and scrolling back to the bottom resumes it, so there is no follow
toggle to remember. While a turn runs the pane follows whichever agent starts next, until you cycle
the focus by hand.

**Typing while the team works.** The prompt stays live. Anything you submit mid-run joins the queue
strip above it and starts as the next turn the moment the console goes idle — so a thought you have
while watching the output is never lost. Cancelling drops the queue with the turn, since "cancel"
should mean stop.

Cancelling aborts the in-flight agents and their child processes rather than leaving them running in
the background.

### Commands

Type `/` on an empty line for a filtered list.

| Command | Action |
|---------|--------|
| `/agents` | List the configured team |
| `/focus <id>` | Focus an agent by id |
| `/clear` | Clear the focused agent's log |
| `/history` | Browse finished turns |
| `/cancel` | Cancel the running turn and its queue |
| `/help` | Key map |
| `/quit` | Exit |

The console renders on the alternate screen buffer, so your shell scrollback is preserved.

### Workspace

The console is iterative, so every turn runs against the **same** `workDir` — a follow-up like "now
add tests for that" sees the files the previous turn wrote. `task-plan.json` is cleared at the start
of each turn so a plan left over from an earlier requirement can never be re-applied. Only the logs
are per-run: `workDir/.multiclaw/runs/run-<timestamp>/logs/`.

`multiclaw run` is deliberately different: it sandboxes each invocation in its own
`run-<timestamp>/` directory.

### History

`/history` lists finished turns newest first, with each turn's outcome, duration, agent count and
requirement. `↑` `↓` select and `enter` opens one for reading — the panes render that turn behind a
`viewing turn N` banner, and `esc` returns to the live turn. Scrolling and `tab` apply to what you
are reading, never to the turn that is still running. The turn on screen is not listed, and the last
20 finished turns are kept.

On a narrow terminal (under 72 columns) the team panel is dropped and the stream takes the full
width; on a short one (under 16 rows) the pipeline rail goes too. The header, prompt and hint bar are
never dropped.

> **No TTY?** The console needs an interactive terminal. In CI, in a pipe, or over a non-TTY SSH
> session it exits with a message pointing at `multiclaw run`, which runs the same pipeline headless.

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

The `leader` field adds a routing agent that runs **before** the main pipeline. It reads the requirement and inspects the codebase, then decides what the turn actually needs:

| Decision | Meaning |
|----------|---------|
| `run` | It is a task the leader can scope — name the minimum set of agents needed |
| `reply` | A greeting or a question it can answer on the spot; no agent runs |
| `ask` | A real task, but too vague to plan; it asks the one question that unblocks it |

The leader is asked for a single JSON object:

```json
{"mode": "run", "run": ["backend-developer", "code-reviewer"]}
{"mode": "reply", "message": "Hi — ask me for a change to this project."}
{"mode": "ask", "message": "Which database should I target?"}
```

A bare `{"run": [...]}` with no `mode` is still accepted as a run. Anything else the leader writes is
treated as its answer, so a leader that replies in prose still ends the turn in words.

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

For a minor bug fix the leader might decide only `backend-developer` and `code-reviewer` are needed, skipping the design stages. For a greenfield feature it runs the full pipeline. For `hello` it answers, and nobody is spent on it.

Agent IDs are always a **subset** of the configured team: an invented id is reported and dropped, never added. A `run` naming no configured agent is a failure, not a green "done". If the leader cannot be reached at all, multiclaw warns and falls back to the full configured team.

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
pnpm dev        # opens the interactive console
pnpm run run    # ...or one headless run
```

## License

[MIT](https://github.com/shipengqi/multiclaw/blob/main/LICENSE)
