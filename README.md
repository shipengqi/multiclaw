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
| `--no-leader` | (Batch mode only) Skip the leader and run the full configured team. Has no effect in the interactive console — the leader is always used there. |
| `--dry-run` | Preview the routed plan without running the pipeline. |
| `--resume [path]` | Resume a previous run, continuing agent sessions. Defaults to the latest run. |

The `<requirement>` string is injected into every agent's prompt as `{{requirement}}`.

Each run creates an isolated timestamped subdirectory inside `workDir` (e.g. `workspace/.multiclaw/runs/run-2026-10-08T12-00-00`), so a one-shot run can never collide with anything else on disk. The interactive console is deliberately different — see [Workspace](#workspace).

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

### `multiclaw sessions`

Manage saved console sessions.

```bash
multiclaw sessions ls                 # List saved sessions, newest first
multiclaw sessions rm <id>            # Delete a session by id (or unique prefix)
```

## Providers, models & tiers

Two ideas keep configs short and provider-agnostic:

- **`runtime` vs `provider`.** The *runtime* is the protocol multiclaw uses to talk to an agent — today that is always `acp` (the [Agent Client Protocol](https://agentclientprotocol.com)). The *provider* is the agent product (`claude`, `opencode`, `codex`, `cursor`). So `runtime` is a constant; `provider` is the thing you pick.
- **Model tiers.** Instead of hard-coding a model that only exists on one provider, an agent declares a **tier** — `strong`, `balanced`, or `fast`. The built-in catalog maps each tier to a concrete model id *per provider* (e.g. `strong` → `opus` on Claude, `opencode/exo-free` on OpenCode). That way the same preset runs unchanged on any provider; switching providers just changes the resolved model.

Resolution order for an agent's model:

1. `agent.model` (explicit id) → 2. `agent.models[provider]` → 3. legacy `agent.models["acp"]` →
4. `agent.modelTier` (catalog-resolved) → 5. `config.defaults.model` → 6. the provider's default model.

A single `defaults: { provider, model }` block at the top of the config supplies steps 2/5 for every agent, so you rarely repeat yourself.

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
Read the brief at {{file:brief.md}} and write architecture.md.`,
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
      taskPrompt: "Read architecture.md and implement the code.",
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
| `defaults` | object | | Project-wide `{ provider?, model?, command?, permissions? }` applied to every agent that does not override them. Keeps generated configs short. |
| `context` | Record<string, string> | | Variables available as `{{key}}` in every prompt. `requirement` is injected automatically. |
| `logDir` | string | | Log output directory. Default: `workDir/.multiclaw/logs`. |
| `continueOnError` | boolean | | Keep running when an agent fails. Default: `false`. |
| `maxConcurrency` | number | | Max agents running in parallel. Default: unlimited. |
| `permissions` | object | | Permission mode: `{ mode: "auto" \| "ask" \| "deny", onRequest? }`. `"auto"` approves every tool request, `"ask"` escalates each one to `onRequest`, `"deny"` refuses all of them. Default: `"auto"` for `run`, `"ask"` in the console. |

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
| Stream panel | The focused agent's output across every turn of this session, with a `▼` live / `⏸` parked marker |
| Reply panel | What the leader answered, when a turn needed no pipeline |
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
| `tab` | Cycle the focused agent |
| `shift+tab` | Toggle the permission mode (`auto` ↔ `ask`) |
| `↑` `↓` `pgup` `pgdn` | Scroll the focused agent's stream |
| `←` `→` `home` `end` | Move the caret |
| `esc` | Clear the line, or close an overlay |
| `?` | Key map (idle, empty line only) |
| `/` | Command menu (empty line only) |
| `ctrl+l` | Clear the focused agent's output for the current turn |
| `ctrl+c` | Cancel the running turn *and its queue*; again when idle to quit |

Scrolling up parks the stream and scrolling back to the bottom resumes it, so there is no follow
toggle to remember. While a turn runs the pane follows whichever agent starts next, until you cycle
the focus by hand.

**Typing while the team works.** The prompt stays live. Anything you submit mid-run joins the queue
strip above it and starts as the next turn the moment the console goes idle — so a thought you have
while watching the output is never lost. Cancelling drops the queue with the turn, since "cancel"
should mean stop.

**Steering the turn that is running.** A queued follow-up waits for the current turn to end.
`/steer <text>` does the opposite: it delivers the message *into* the agents that are inside a turn
right now, which is how you correct course without throwing the run away. The agents it reached get a
`[steer] …` marker in their stream, so the log shows what you said and when.

It is timing-dependent by nature — an agent that has not started yet will not see the message — and
the console is explicit about the outcome instead of guessing:

- Reached at least one running agent: the notice names them, and any agent that was between turns is
  named as such.
- Nobody was mid-turn, or the provider's bridge does not support mid-turn input: the text becomes a
  queued follow-up and the notice says the timing changed. It is never silently dropped, and it never
  makes an idle session start a turn of its own.
- While no turn is running there is nothing to steer into, so `/steer` is refused and points at
  ordinary input instead.

Delivery is not the same as obedience, and response timing is not guaranteed. In our counting
probes, Claude bridges 0.89.1 and 0.95.0 and Codex bridge 2.5.0 stopped counting before the original
target and answered the new instruction; Codex bridge 2.2.2 reached the target first. These are
version-specific observations, not a guarantee for other tasks or versions. The marker says the
message landed, not that the agent has already acted on it.

Cancelling aborts the in-flight agents and their child processes rather than leaving them running in
the background.

### Commands

Type `/` on an empty line, select an operation and press Enter. Commands that need an
agent, mode or turn open a selector; search and steering open an input field. `Esc`
cancels the operation. The menu only offers actions relevant to the current state.

| Command | Action |
|---------|--------|
| `/new` | Open an empty new session; type the requirement afterwards (idle only) |
| `/sessions` | Select, switch or delete a saved session (idle only) |
| `/focus` | Select the agent to view |
| `/mode` | Select `ask`, `auto` or `deny` |
| `/verbose` | Toggle tool detail |
| `/search` | Enter search text; `Ctrl+N` / `Ctrl+P` move between matches |
| `/latest` | Return to the latest output |
| `/retry` | Select one failed/repair agent or all of them (idle only) |
| `/replay` | Select a finished turn to run again (idle only) |
| `/edit` | Select a finished turn and edit its requirement in the prompt |
| `/export` | Select a finished turn to export as Markdown |
| `/steer` | Enter a message for agents running now |
| `/pause` | Pause a non-empty follow-up queue |
| `/continue` | Resume a paused queue, or continue at a checkpoint |

For direct entry, `/focus <id>`, `/mode <mode>`, `/search <text>`,
`/retry <id>`, `/replay <turn>`, `/edit <turn>`, `/export <turn> [path]`
and `/steer <text>` are also supported. `/new` takes no arguments.
Editing a previous requirement does not branch the session or restore files.

Approvals and agent questions are handled in their panels. Leader clarification and
checkpoint feedback use ordinary input. `Ctrl+L` clears the current output, `?`
opens help, `Ctrl+C` cancels a running turn and its queue or exits when idle with
an empty prompt, and `Ctrl+D` exits with an empty prompt (also while running).

The console renders on the alternate screen buffer, so your shell scrollback is preserved.

On a narrow terminal (under 72 columns) the team panel is dropped and the stream takes the full
width; on a short one (under 16 rows) the pipeline rail goes too. The header, prompt and hint bar are
never dropped.

> **No TTY?** The console needs an interactive terminal. In CI, in a pipe, or over a non-TTY SSH
> session it exits with a message pointing at `multiclaw run`, which runs the same pipeline headless.

### Tool approvals and agent questions

multiclaw has three permission modes, configured via `permissions: { mode: ... }`. The
agent's own `permissions.mode` wins, then the project's, then `defaults.permissions`:

| Mode | Behaviour |
|------|-----------|
| `"auto"` **(default)** | Every tool request is approved. No prompts. |
| `"ask"` | Every tool request is escalated to a human — `permissions.onRequest`, or the console's permission bar. With nobody to answer, it is refused. |
| `"deny"` | Every tool request is refused. |

```typescript
// multiclaw.config.ts — override the default if needed
export default defineConfig({
  permissions: { mode: "ask" }, // ask a person before any tool runs
})
```

`multiclaw run` has nobody to ask, so `"ask"` without an `onRequest` handler refuses
every tool call; it warns about this before the team starts. The console starts in
**ask** unless the config says otherwise, and shows the active mode in the header.
`shift+tab` toggles between `auto` and `ask` at runtime and `/mode auto|ask|deny` sets
any of the three — a runtime choice outranks a per-agent mode, so the header always
describes what the agents are actually doing.

Switching to `auto` during a turn immediately approves pending tool permissions and
automatically approves subsequent tools, including MCP tools. Switching back to
`ask` restores prompts for subsequent tools; `deny` cancels pending permissions.
Business questions and checkpoints still require their own answers.

The console's permission bar shows the requesting agent, the tool input, and the
provider's offered choices. Requests from concurrent agents are queued with unique
aliases; normal input still queues a follow-up and never grants approval.

- Use arrows or digits in the approval bar to select a provider's approve/reject option,
  then Enter to confirm. Esc returns to typing; Esc again returns to the choices.
- Concurrent requests are shown in order, advancing after each decision.
- Waiting counts toward the agent's existing timeout. Cancel, quit, and session
  cleanup release outstanding decisions; they do not leave agents waiting forever.
- A refusal is reported on the stream as a `permission_rejected` event naming the
  tool, with `source` saying whether the mode, a missing handler, or a person said no.

Permission handlers are turn-local, not saved in reusable provider sessions.

**This handles requests the provider actually sends, not every tool invocation.**
Claude may allow reads or safe commands without asking; its permission settings
still apply. This is neither a sandbox nor fine-grained path/command enforcement.
An `allow_always` choice has the scope shown by the provider, not a multiclaw-wide
approval cache and may change provider settings. `auto` selects one-time approval
only; it never silently grants a durable permission. Denying a tool
does not itself mean the agent turn failed: use the
optional delivery review gate when completion must satisfy acceptance criteria.

**Structured live questions** use ACP form elicitation, which the installed Claude
bridge maps to `AskUserQuestion`. The console queues these alongside approvals:

- Use Tab to move between fields, arrows/digits to select choices, Space for multi-select,
  and the prompt to enter text. Input preserves whitespace and is validated before submission.
- After the last field, choose **Submit answers**, **Skip question** or **Cancel request**
  and press Enter. Skip and cancel are distinct provider actions.
- Incomplete or invalid answers keep the form pending and identify fields needing correction.
  Cancellation and timeout release pending questions.

Core callers supply `questions.onRequest` (or `AgentTask.onQuestion`); live-session
callers open with `questionForms: true` and provide `onQuestion` on each prompt.
Form support is negotiated only when the caller supports it. The provider must also
offer the tool, e.g. `"AskUserQuestion"` for Claude.
URL elicitation, custom schema types, and arbitrary prose questions are not
supported. Supported forms include strings, numbers, integers, booleans, and enum
multi-selects; this is not a general JSON Schema implementation. No question
handler means unexpected form requests are cancelled, not automatically answered.

Leader clarification uses ordinary input after a completed leader ask turn; previously
queued text is not used as the answer. At a checkpoint, type feedback directly or use
`/continue` to proceed; Ctrl+C cancels the run. Queue pause/resume does not pause
an active agent. `/new` closes the current agents and opens an empty session.

### Workspace

The console is iterative, so every turn runs against the **same** `workDir`. A follow-up like "now
add tests for that" sees the files the previous turn wrote — and `task-plan.json` is cleared at the
start of each turn so a plan left over from an earlier requirement can never be re-applied.

Only the logs are per-run: each turn writes `workDir/.multiclaw/runs/run-<timestamp>/logs/`, the same
shape `multiclaw run` produces. The run directory is a record of what happened, not where the work
happens.

Runtime storage automatically gets a `.multiclaw/.gitignore` containing `*`, so Git
ignores generated runtime files. Missing ignore files in existing directories are
added on startup; existing rules are preserved.

### History

Finished turns are written to `workDir/.multiclaw/sessions/<id>/turns.jsonl`, one line per turn, so
closing the console and reopening it restores the session — and the turn numbering carries on from
where it left off rather than restarting at one.

Switching to a session via `/sessions` restores its history into the stream. The stream panel
shows the focused agent's whole session — every turn it took part in, oldest first, separated by
dim `──── turn N · <requirement> ────` rows — and scrolling up walks back through it. There is no
separate "open a past turn" mode: the team panel and pipeline rail stay on the live turn, so the
orchestration context does not move while you read.

The console keeps the last 20 finished turns per session.

The next leader turn also receives compact execution facts from completed pipeline
turns: completed agents, failures and their reasons, and acceptance status separately.
Successful execution is not the same as approved delivery. Interrupted turns remain
interrupted; cancelled turns are excluded from dialogue context. Older records without
enough facts are not relabeled as successful. This uses no additional model call and
stays within the existing six-turn / 4,000-character conversation budget. A follow-up
such as “continue” does not implicitly approve tools or automatically retry failures.

### Sessions

A **session** is one continuous line of work — a sequence of turns sharing the same team. It is the
unit the console saves, resumes and deletes, the way Claude Code and Codex do. Each session lives in
its own `workDir/.multiclaw/sessions/<id>/` directory, and a small `index.json` holds the summaries
the picker shows.

- **Launch.** `multiclaw` always starts a **new** session. `multiclaw --new` is equivalent.
  `multiclaw -r [id]` resumes a given session — or opens the picker when no id is passed, the way
  `claude -r` does.
- **`/sessions`** opens the picker: every session newest-first with its title (the first
  requirement), turn count and age, the current one marked. `↑` `↓` select, `enter` switches to the
  highlighted session — its last turn opens automatically so you can see the context, and your next
  instruction continues its agents where they left off — `d` deletes one, and `esc` closes.
- **`/new`** closes the current agents and opens an empty session; type the next requirement afterwards.

Sessions are kept until you remove them: `d` in the picker, `multiclaw sessions rm <id>` (a full id
or a unique prefix), or `multiclaw prune` (which also lists old run directories). `multiclaw sessions
ls` prints them.

### Restarting

Closing the console politely and reopening it is the easy case: the turns are on disk, so they come
back. A console that was killed — a crashed terminal, a reboot, `kill -9` — leaves more behind than
that, and it is written to `workDir/.multiclaw/sessions/<id>/session.json` while the turn runs:

- **The turn in flight.** Agent processes die with the console and a pending approval is an RPC to
  one of them, so the turn cannot be continued. Instead it is restored as a turn that ended
  **interrupted**: its requirement, its roster, its pipeline and the tail of each agent's log, with
  every agent that never reported back marked stopped. Nothing claims it succeeded.
- **The queue.** Follow-ups you typed but never ran come back — **paused**, because running them the
  instant the console reopens would do work you are not watching. `/continue` starts them.
- **The session.** A restart reopens the session you were in and restores its turns; the leader is
  handed that session's conversation, not every turn ever run in the workspace.
- **Pending decisions.** An approval or question that was waiting is gone — the agent that asked no
  longer exists. The console says how many were discarded instead of silently dropping them.

The notice bar names all of this on the first frame, and the interrupted turn is accessible via
`/sessions` (switching back to that session auto-opens it), so `/export` and `/replay` work on it. The one thing a restart does not do is pretend: no
decision is answered on your behalf, and no agent is resumed from a session this process never held.

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
| `backend` | Product Manager → Architect → Arch Design Reviewer → Backend Developer → Tester → Code Reviewer + DevOps | 7 |
| `frontend` | Architect → UI Designer → UI Design Reviewer → Frontend Developer → Tester → Code Reviewer | 6 |
| `fullstack` | Product Manager → Architect → Arch Design Reviewer → Backend Developer + UI Designer → UI Design Reviewer → Frontend Developer → Tester → Code Reviewer + DevOps | 10 |

## Leader

The `leader` field adds a routing agent that runs **before** the main pipeline. It reads the requirement and inspects the codebase, then decides what the turn actually needs:

| Decision | Meaning |
|----------|---------|
| `run` | New work — name the minimum set of agents needed |
| `continue` | Follow up on the supplied latest work ID — select the agents needed now |
| `reply` | A greeting or a question it can answer on the spot; no agent runs |
| `ask` | A real task, but too vague to plan; it asks the one question that unblocks it |

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

The leader is asked for a single JSON object:

```json
{"mode": "run", "run": ["backend-developer", "code-reviewer"]}
{"mode": "continue", "workId": "latest-work-id", "run": ["backend-developer"]}
{"mode": "reply", "message": "Hi — ask me for a change to this project."}
{"mode": "ask", "message": "Which database should I target?"}
```

A bare `{"run": [...]}` with no mode remains compatible, as do ordinary prose replies. Unknown agents, duplicate or empty selections, malformed decisions and empty output trigger one correction retry. If routing still fails, the result reports "Routing incomplete" and no worker starts.

Optional responsibility assignments use `{"agentId":"selected-id","scope":"responsibility"}`. The leader supplies the complete goal and confirmed constraints, while workers choose implementation steps. A planner is optional, including when configured but not selected. Without one, workers follow configured dependencies and investigate, plan and verify within their scope; design files are optional context for built-in prompts. Custom task prompts remain user-defined.

The console offers only the latest work in its current session as a continuation target, skipping intervening replies and questions. Continuations keep that work ID and reuse compatible executor Sessions or load recorded Session IDs after restart. Failed/interrupted work requires an explicit continuation request; cancelled work is not an automatic continuation target. Work metadata establishes Session ownership. Ambiguous references ask for clarification; similar topics alone are new work.

New work starts fresh executor conversations and clears the previous task plan after routing; the leader conversation and shared workspace persist. Continuations use scopes and plans bound to their recorded work. If a Session cannot be loaded, the failure is reported; a newly created Session is explicitly identified and receives recovery context. Dry-run uses the same routing validation and shows Session intent (create, reuse, attempt load or unavailable) without starting workers, resetting worker Sessions or deleting plans. Explicit /retry and CLI --resume keep their fixed agent roster.

Executor results, work history and resume configuration use a single structured Session record: work/agent ownership, binding ID, provider ID, immutable-settings hash, negotiated capabilities and last observed state. Failed or cancelled turns retain reliable Session facts independently of their execution outcome. Development builds use this format directly without old-field aliases or report migration.

Lifecycle events distinguish creation, reuse, requested loading, successful loading and cleanup failure. Opened IDs reach the journal before a worker finishes; restart marks process continuity unknown and verifies ownership and settings before loading. Automatic continuation starts a new Session with recovery context when settings differ or loading is unsupported; explicit resume reports the mismatch. Actual load failures stop execution. Cleanup must be acknowledged before replacing a worker Session. CLI-owned Sessions close before the final report; the interactive console keeps reusable Sessions across turns.

A non-reviewer worker can end its successful final output with this standalone control marker:

```text
<multiclaw-handoff>{"reason":"specific reason and remaining work"}</multiclaw-handoff>
```

A handoff waits for the current stage to settle and stops downstream stages. With a leader, multiclaw reroutes once, excluding the agents that handed work back. A second handoff, a fixed retry/resume roster, or no leader stops with the reason. Malformed terminal markers fail the protocol; quoted examples and progress output are not handoffs. Real failure or cancellation in the same stage takes precedence. Repair handoffs share the original repair budget, and rerouted changes require fresh checkpoints and acceptance. Reports retain all attempts and costs separately from the effective final results.

### Disabling the leader

The leader is what lets a single typed line become "run these three agents, in this order" — or
"just answer". In the interactive console it is indispensable, so `--no-leader` is a **batch-mode
only** switch: it applies to `multiclaw run` and is ignored by the console (which shows a small
`⚠ leader off` hint if you disable it in config).

You can skip the leader and use the default pipeline directly in three ways:

1. **CLI option** (for a single headless run):
   ```bash
   multiclaw run "your requirement" --no-leader
   ```

2. **Config file**:
   ```typescript
   export default defineConfig({
     leader: agents.leader(),
     useLeader: false, // disable leader (batch runs only; console still uses it)
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
