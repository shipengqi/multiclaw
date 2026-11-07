# multiclaw

[中文](README.zh-CN.md)

Multi-agent orchestration CLI. Define a pipeline of AI agents, give them a requirement, and watch them run in parallel or in sequence based on the dependency graph you declare.

## Prerequisites

multiclaw orchestrates agents from any installed **provider**. Every provider talks
to multiclaw over the same [Agent Client Protocol (ACP)](https://agentclientprotocol.com)
— the underlying *runtime* is always `acp`; the **provider** is the agent product you
choose. Install one or more:

| Provider | CLI | Install |
|----------|-----|---------|
| OpenCode | `opencode` | `npm install -g opencode` |
| Claude | `claude-agent-acp` (bundled) | install the Claude Code CLI (`claude`) and run `claude` to log in |
| Codex | `codex-acp` (bundled) | install the Codex CLI (`codex`) and run `codex login` |
| Cursor | `cursor-agent` | `curl https://cursor.com/install \| bash` |

`multiclaw init` auto-detects which providers are installed and only offers those;
`multiclaw doctor` shows the full picture (installed versions, auth hints, available
models). Codex and Cursor need an API key or login before they can run.

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
- **Provider** — which agent product to use (`claude`, `opencode`, `codex`, `cursor`). Only installed providers are offered; missing ones are listed with install hints.
- **Work directory** — where agents read and write files

Options:

| Option | Description |
|--------|-------------|
| `--force` | Overwrite an existing `multiclaw.config.ts` |

### `multiclaw doctor`

Diagnose the local environment: which providers are installed (with versions), what auth
each needs, how many models each exposes, and whether the current config's agents all
resolve to an installed provider. Exits non-zero if no provider is available.

```bash
multiclaw doctor            # full environment check
multiclaw doctor --config ./multiclaw.config.ts   # also validates the config
```

### `multiclaw run <requirement> [options]`

Runs the orchestration defined in your config file.

| Option | Description |
|--------|-------------|
| `--config <path>` | Path to config file. Auto-discovers `multiclaw.config.ts` if omitted. |
| `--dry-run` | Preview the routed plan without running the pipeline. |
| `--resume [path]` | Resume a previous run, continuing agent sessions. Defaults to the latest run. |

The `<requirement>` string is injected into every agent's prompt as `{{requirement}}`.

Each run creates an isolated timestamped subdirectory inside `workDir` (e.g. `workspace/.multiclaw/runs/run-2026-10-08T12-00-00-<execution-id>`), so a one-shot run can never collide with anything else on disk. The interactive console uses the shared project directory — see [Interactive console](#interactive-console).

### `multiclaw upgrade`

Upgrade multiclaw to the latest version.

### `multiclaw prune`

Interactively clean up saved sessions and old run directories.

| Option | Description |
|--------|-------------|
| `--sessions` | Prune saved sessions only (non-interactive) |
| `--runs` | Prune all run directories only (non-interactive) |
| `--all` | Prune everything (non-interactive) |
| `--dry-run` | Show what would be deleted without deleting |
| `--yes` | Skip the confirmation prompt |


## Providers, models & tiers

Two ideas keep configs short and provider-agnostic:

- **`runtime` vs `provider`.** The *runtime* is the protocol multiclaw uses to talk to an agent — today that is always `acp` (the [Agent Client Protocol](https://agentclientprotocol.com)). The *provider* is the agent product (`claude`, `opencode`, `codex`, `cursor`). So `runtime` is a constant; `provider` is the thing you pick.
- **Model tiers.** Instead of hard-coding a model that only exists on one provider, an agent declares a **tier** — `strong`, `balanced`, or `fast`. The built-in catalog maps each tier to a concrete model id *per provider* (e.g. `strong` → `opus` on Claude, `opencode/exo-free` on OpenCode). That way the same preset runs unchanged on any provider; switching providers just changes the resolved model.

Resolution order for an agent's model (highest to lowest):

1. **`agent.model`** (explicit model ID, highest precedence)
2. **`agent.models[provider]`** (model map entry for the active provider)
3. **`config.defaults.model`** (project-level default model for all agents and Coordinator)
4. **`agent.modelTier`** (catalog-resolved `strong` / `balanced` / `fast` mapped to the active provider)
5. **`agent.models["acp"]`** (legacy model map entry fallback)
6. **The provider's default model** in the catalog (e.g. `opencode/big-pickle` for OpenCode, `sonnet` for Claude)

A single `defaults: { provider, model }` block at the top of the config supplies the default for every agent and the Coordinator, so you rarely repeat yourself.

> **💡 Notes**:
> - **Global default overrides**: Setting `config.defaults.model` automatically applies to all built-in agents and the background Coordinator; only use `{ model: "..." }` on an agent when you want a specific agent to use a different model.
> - **Automatic cross-provider adaptation**: When `config.defaults.model` is omitted, built-in agents adapt across providers using their `modelTier` (e.g. Architect resolves to `opus` on Claude, and `opencode/exo-free` on OpenCode).
> - **Full model IDs**: When using providers like OpenCode, specify full qualified model IDs (e.g. `hai-google/gemini-3.8-flash`).

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


  logDir: "./logs",         // optional; default: workDir/.multiclaw/logs
  continueOnError: false,   // optional; keep running if an agent fails
  maxConcurrency: 4,        // optional; max agents running at once

  // Project-wide defaults applied to every agent that doesn't override them.
  // One line replaces repeating provider/model across all preset agents.
  defaults: {
    provider: "claude",     // which agent product runs the team
    model: "sonnet",        // default model (overridable per agent)
  },

  agents: [
    {
      id: "architect",        // unique identifier, used in dependsOn
      name: "Architect",      // display name
      icon: "◆",              // optional; shown in the console
      provider: "claude",     // optional; default: config.defaults.provider
      modelTier: "strong",    // optional; "strong" | "balanced" | "fast"
      model: "opus",          // optional; overrides tier/default for this agent
      systemPrompt: "You are a software architect.", // optional
      taskPrompt: `Design the system for {{requirement}}.
Read the brief at {{file:brief.md}} and write {{artifact:architecture.md}}.`,
      permissions: { mode: "ask" }, // optional; overrides the project mode here
      dependsOn: [],          // optional; list of agent ids this agent waits for
      timeout: 1_800_000,     // optional; ms, default: 1 800 000 (30 min)
      retries: 0,             // optional; retry count on failure, default: 0
      workDir: "architect",   // optional; subdirectory relative to global workDir
    },
    {
      id: "developer",
      name: "Developer",
      model: "sonnet",        // override model for this agent
      taskPrompt: "Use this design to implement the code: {{file:artifact:architecture.md}}",
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
| `defaults` | object | | Project-wide `{ provider?, model?, command?, permissions? }` applied to every agent that does not override them. Keeps generated configs short. |
| `context` | Record<string, string> | | Variables available as `{{key}}` in every prompt. `requirement` is injected automatically. |
| `logDir` | string | | Log output directory. Default: `workDir/.multiclaw/logs`. |
| `continueOnError` | boolean | | Keep running when an agent fails. Default: `false`. |
| `maxConcurrency` | number | | Max agents running in parallel. Default: unlimited. |
| `permissions` | object | | Permission mode: `{ mode: "auto" \| "ask" \| "deny", onRequest? }`. `"auto"` approves every tool request, `"ask"` escalates each one to `onRequest`, `"deny"` refuses all of them. Default: `"auto"` for `run`, `"ask"` in the console. |

### Multi-round review and repair

Top-level `reviewGates` turns pipeline reviewers into approval gates. Each policy names a `reviewer`, `repairAgents` and `maxRepairRounds`; the reviewer's `dependsOn` locates the gate. Rejected work runs the selected repair agents sequentially and is reviewed again before downstream work starts. Include tester in code-review repairs to revalidate code changes. Each gate retains its own budget across nested retesting and handoff rerouting.

New backend, frontend and fullstack configs enable their review gates with three repair rounds. Existing configs must opt in. The original `review` still supports a reserved final reviewer. Invalid verdicts and exhausted budgets block delivery; reports and console history preserve every gate's verdicts. See the [configuration and verification record](docs/multi-agent-rework.md).

### Agent fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Unique identifier. Used in `dependsOn`. |
| `name` | string | ✓ | Display name shown in the agent list. |
| `taskPrompt` | string | ✓ | Prompt sent to the AI runtime. Supports template variables. |
| `systemPrompt` | string | | Optional system prompt prepended to `taskPrompt`. |
| `icon` | string | | Unicode icon shown next to the agent name. |
| `description` | string | | One-line role, shown beside the agent's name on the console's first screen. Every built-in preset sets one. |
| `provider` | string | | Agent product this agent runs on: `claude`, `opencode`, `codex`, or `cursor`. Defaults to `config.defaults.provider`. All providers speak the same `acp` runtime. |
| `runtime` | string | | **Legacy.** Always `"acp"` today. Use `provider` instead. Retained for backward compatibility. |
| `modelTier` | `"strong"` \| `"balanced"` \| `"fast"` | | Declares the capability this agent needs; the catalog maps each tier to a provider-specific model id. Ignored when `model` is set. |
| `model` | string | | Override the model id for this agent (provider-specific, e.g. `"opus"`, `"sonnet"`, `"haiku"` for Claude). Takes precedence over `modelTier` and `models`. |
| `models` | Record<string, string> | | Map of provider id (or the legacy `"acp"`) to a model id, e.g. `{ claude: "sonnet", opencode: "opencode/big-pickle" }`. Used when `model`/`modelTier` are unset. |
| `permissions` | `{ mode: "auto" \| "ask" \| "deny" }` | | Approval mode for this agent's tool calls. Overrides `permissions` and `defaults.permissions`. |
| `dependsOn` | string[] | | Agent ids that must complete before this agent starts. |
| `timeout` | number | | Per-attempt timeout in ms. Default: `1800000` (30 min); set a larger value for longer tasks. |
| `retries` | number | | Number of retry attempts on failure. Default: `0`. |
| `workDir` | string | | Subdirectory (relative to global `workDir`) for this agent's CWD. |

For longer development tasks, override the agent timeout, for example to 60 minutes:

```ts
agents.backendDeveloper({ timeout: 60 * 60 * 1000 })
```

### Template variables

Task templates support context, workspace files and collaboration artifacts. Artifact path placeholders also work in `systemPrompt`:

| Syntax | Replaced with |
|--------|--------------|
| `{{key}}` | The value of `context.key` (or `requirement` from the CLI). |
| `{{file:path/to/file}}` | The contents of that file, resolved relative to `workDir`. |
| `{{artifact:architecture.md}}` | Absolute output path for a shared design in the current work's `planning/` directory. |
| `{{artifact:implementation-notes.md}}` | Absolute output path for the current agent's own report. |
| `{{file:artifact:architecture.md}}` | Contents of the current work's shared design, independent of the agent's CWD. |
| `{{file:artifact:agents/backend-developer/implementation-notes.md}}` | Contents of another agent's report in the same work. |
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

Run multiclaw to open the Ink terminal UI. It opens a blank chat with sessions on the left; the first message creates the session. --resume <id> opens a specific chat, and --resume focuses the list. Missing IDs are errors.

The central chat always talks to the permanent coordinator. The team panel is hidden by default; viewing an agent never changes the main input recipient. Narrow terminals use temporary session and team viewers.

| Key | Action |
| --- | --- |
| Ctrl+B | Focus sessions; arrows select, Enter opens |
| Ctrl+T | Open/focus team; arrows select an agent |
| Ctrl+G | Focus the current permission, question or checkpoint |
| Esc | Return to chat without answering a request |
| Shift+Tab | Cycle this chat's permission mode |
| Ctrl+C | Cancel the current chat's work |
| Ctrl+D | Stop all work, save and exit |
| Ctrl+V | Paste clipboard text or an image |
| Alt+Backspace | Remove the last attached image |
| Up/Down, PageUp/PageDown | Scroll focused output |
| ? on an empty input | Help |

Pasting or dropping an absolute PNG, JPEG, GIF or WebP path attaches the image, including quoted paths and escaped spaces. The prompt shows an attachment count; type your message and press Enter, or send the image alone. Image paths are never slash commands. Attachments stay with their chat draft when switching sessions.

During execution the coordinator answers progress questions and directs additional requirements to individual agents. Independent new work is queued. Explicit replacement stops current work before dispatching its replacement; ambiguous instructions trigger clarification.

Dependencies still govern execution. Supplements update the requirement revision; affected implementation, downstream tests and reviews are reworked before completion. Providers without live injection receive supplements after the current call. Delivered does not mean implemented. Unknown delivery is retained and never automatically replayed.

Each chat owns its coordinator/worker bindings, queue, drafts and interactions. Switching keeps work running. Chats execute concurrently in the same workDir without file conflict arbitration; maxConcurrency applies per chat. Permissions and structured questions require explicit request controls, not ordinary replies. Background requests mark their original session as needing input.

| Command | Action |
| --- | --- |
| /new | Open a blank chat; other chats continue |
| /focus [agent] | Inspect an agent in the team panel |
| /steer <agent> <text> | Supplement a specific agent |
| /mode auto / ask / deny | Change this chat's live permission mode |
| /retry [agent] | Retry known work with a fixed agent set |
| /replay [turn] | Run a recorded requirement again while idle |
| /edit | Copy the latest requirement into the draft |
| /search [text], /latest | Search output or return to its tail |
| /verbose | Toggle tool details |
| /pause, /continue | Pause or resume queued work |
| /export [path] | Export the chat as Markdown |

Stop running work before deleting its chat; deletion requires confirmation. Exiting waits for cleanup and saving. After interruption, runtime continuity is unknown and queued work stays paused until explicit continuation. Provider RPCs do not survive restart.

Journals use version 2. Older or damaged journals are unsupported and retained without overwriting. No history migration is provided. /sessions and multiclaw sessions are removed; use the sidebar or multiclaw prune.


## Logs

Batch execution workspaces and logs remain under `workDir/.multiclaw/runs/run-<timestamp>-<execution-id>/` (or `logDir` for logs if set):

```
workDir/
└── .multiclaw/
    └── runs/
        └── run-2026-10-08T12-00-00-<execution-id>/
            ├── <project files>        ← source code, tests, README.md, etc.
            └── logs/
                ├── <agentId>.log      ← raw stdout per agent
                └── report.json        ← full orchestration result
```

| File | Contents |
|------|----------|
| `<agentId>.log` | Raw stdout from that agent's process |
| `report.json` | Full orchestration result (status, duration, output per agent) |

The log path is printed to the terminal at the start of every run.

### Collaboration artifacts

Both batch runs and the interactive console keep collaboration documents under the project's `.multiclaw/works/<work-id>/`, separate from source code and formal project documentation:

```text
.multiclaw/
├── sessions/                       # console history and recovery
├── runs/                           # batch execution workspaces and logs
└── works/
    └── <work-id>/
        ├── manifest.json           # current artifact index
        ├── planning/
        │   ├── requirements.md
        │   ├── architecture.md
        │   ├── api-spec.md
        │   ├── ui-design.md
        │   └── task-plan.json
        └── agents/
            ├── backend-developer/implementation-notes.md
            ├── frontend-developer/implementation-notes.md
            ├── tester/test-report.md
            └── code-reviewer/code-review.md
```

Shared requirements/designs have one path for every agent; reports are owned by their producer, so parallel developers cannot overwrite each other's notes. Each agent receives an up-to-date list of files in the current work, and built-in design references inline those files into downstream prompts. Use `dependsOn` to ensure a producer finishes before its consumers run. File existence does not prove successful execution or review approval.

New tasks receive new work IDs. Continuation, retry and review repair reuse the same work directory and read the latest artifacts. `manifest.json` indexes current files, not immutable per-review snapshots. The result's `work.artifactDirectory` records the display location, and batch completion prints it. Storage is Git-ignored by default.

Existing root Markdown files are not moved or deleted. Legacy continuation may read shared designs from its original execution directory when no isolated copy exists; new tasks never use this fallback. An explicit `context.taskPlanPath` still overrides the task-plan location. Custom templates should use the artifact placeholders above; ordinary `{{file:...}}` references retain their workspace-relative meaning. Artifact paths are a collaboration contract, not a filesystem sandbox.

## Presets

Presets are pipeline templates you can pick during `multiclaw init`:

| Preset | Pipeline | Agents |
|--------|----------|--------|
| `backend` | Product Manager → Architect → Arch Design Reviewer → Backend Developer → Tester → Code Reviewer → DevOps | 7 |
| `frontend` | Architect → UI Designer → UI Design Reviewer → Frontend Developer → Tester → Code Reviewer | 6 |
| `fullstack` | Product Manager → Architect → Arch Design Reviewer → Backend Developer + UI Designer → UI Design Reviewer → Frontend Developer → Tester → Code Reviewer → DevOps | 10 |

## Built-in coordinator

The coordinator permanently owns conversation, clarification, routing and summaries, outside the team. It cannot be disabled or customized. Provider, command and model come from project defaults, with normal fallback when absent.

Remove legacy leader and useLeader configuration. agents.leader() and --no-leader are no longer supported. Fixed-agent retry/resume preserves its execution set and still produces a summary. Summary failure never overwrites execution or acceptance facts.


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

Without a selected planner, agents execute their configured dependencies and scope directly. Existing design files may provide context; missing files do not block work or require architecture documents to be created.

## Example

See [`examples/dev-team/`](examples/dev-team/) for a working three-agent pipeline (Architect → Developer → Reviewer) using a single `defaults.provider`.

```bash
cd examples/dev-team
pnpm dev        # opens the interactive console
pnpm run run    # ...or one headless run
```

For a team where each agent runs on a different provider (e.g. OpenCode for
implementation, Claude for architecture and review), see
[`examples/mixed-provider/`](examples/mixed-provider/). The core supports mixing
providers per agent; `multiclaw init` (v1) generates one shared `defaults.provider`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and quality gates.

See [`RELEASING.md`](RELEASING.md) for how the packages are versioned and released — including how
release notes are generated from pull request titles.
