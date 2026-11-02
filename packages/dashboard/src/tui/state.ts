import type {
  AcceptanceResult,
  AgentDefinition,
  AgentOutput,
  AgentStatus,
  LeaderMessage,
  MultiClawConfig,
  MultiClawEvent,
  StageInfo,
  TurnOutcome,
  TurnRecord,
} from "@multiclawcli/core"
import { displayWidth, renderSegments, wrapLine } from "./format"

/**
 * Per-agent log buffer cap, in characters.
 *
 * The previous web store appended output forever (`logs: a.logs + chunk`). A
 * chatty agent running for hours would grow that string without bound. The TUI
 * renders a tail window, so only the tail is worth keeping.
 */
export const MAX_LOG_CHARS = 8000

export type LogKind = "text" | "tool" | "tool-detail" | "system"

export interface LogSegment {
  kind: LogKind
  text: string
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC character is required to strip ANSI colour codes
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g

export interface AgentView {
  id: string
  name: string
  icon?: string
  model?: string
  /** Static role, from the config. Always available, even before turn one. */
  description?: string
  /** Per-turn title assigned by the leader's task plan; absent until it plans. */
  taskTitle?: string
  status: AgentStatus
  /** Wall clock at which the agent started, so its timer can tick while it runs. */
  startedAt?: number
  /** Final duration, present once the agent has finished. */
  duration?: number
  attempts?: number
  /** In-flight retry counter, present only while the agent is between attempts. */
  retry?: { attempt: number; max: number }
  error?: string
  /** Context-window usage the runtime reported, when it reported any. */
  usage?: AgentOutput["usage"]
  /** USD cost the runtime reported, when the provider priced itself. */
  costUsd?: number
  /**
   * Session the agent ran under, when the runtime reported one. Carried so
   * `/retry` can ask the agent to continue where it left off instead of
   * re-exploring from scratch.
   */
  sessionId?: string
  logs: LogSegment[]
}

export type TuiPhase = "idle" | "running" | "complete"

export interface TuiStageInfo extends StageInfo {
  /** Frozen when this stage finishes, independent of later runs of its agents. */
  outcome?: AgentStatus
  memberStatuses?: Record<string, AgentStatus>
}

/**
 * One turn, as the panes need to see it.
 *
 * Everything that describes *a turn* lives here, and everything that describes
 * *the console* lives on {@link TuiState}. The split is what makes history
 * possible: a finished turn is just a `TurnView` kept around, and the panes take
 * a `TurnView` so they can render one without knowing which it is.
 */
export interface TurnView {
  turn: number
  requirement?: string
  effectiveRequirement?: string
  cancelled?: boolean
  phase: TuiPhase
  /** Wall clock at which the turn started. */
  startedAt?: number
  /** Wall clock at which the turn finished. */
  endedAt?: number
  stages: TuiStageInfo[]
  agents: Record<string, AgentView>
  /**
   * Agents that run *before* the pipeline exists (the leader), so the pipeline
   * bar can label them without guessing. Derived from the config, not from
   * "every agent that is not in a stage" — a configured agent that has not been
   * scheduled yet is not a leader.
   */
  leaderIds: string[]
  focusId?: string
  /**
   * While true the focus pane follows whichever agent starts next. Cycling the
   * focus by hand clears it, so the user's choice is not yanked away.
   */
  autoFollow: boolean
  /**
   * How many rows the stream is scrolled back from the tail. Zero means the
   * stream is live. Kept as an offset rather than an absolute index so new
   * output arriving underneath does not shift what the user is reading.
   *
   * Counted in *terminal rows*, not log lines: a log line can wrap over
   * several rows, and the window has to add up to the pane's height.
   */
  scroll: number
  success?: boolean
  /**
   * Set on a turn that was recovered from a journal after the console died
   * mid-run.
   *
   * Such a turn is `complete` — it is over, and its record is final — but it
   * did not *finish*, so it must not be reported as a success or a failure.
   * `cancelled` is deliberately not reused: that means the user stopped the
   * run, while this one was stopped by the process going away, and the console
   * has to be able to tell the two apart when the user asks "what happened to
   * turn 3".
   */
  interrupted?: boolean
  acceptance?: AcceptanceResult
  totalDuration?: number
  /**
   * Sum of the per-agent costs the runtime reported, in USD. Absent when none
   * was reported — "no data" is not the same as "free", so the console must not
   * print a cost that was never measured.
   */
  totalCostUsd?: number
  /** Short explanation the leader gave for choosing the current pipeline. */
  reason?: string
  warning?: string
  /**
   * Set when the turn ended in words rather than a pipeline: the leader answered
   * or asked a question, so no agent ran. Distinct from `success`, because both
   * a finished pipeline and a one-line answer are successful turns — and the
   * console has to be able to say which one happened.
   */
  reply?: LeaderMessage
}

/** How many finished turns the console keeps around to browse. */
export const MAX_HISTORY = 20

export interface TuiState extends TurnView {
  name: string
  /** Finished turns, oldest first. The live turn is `state` itself. */
  history: TurnView[]
  /**
   * Whether tool detail is shown in the stream.
   *
   * Console state, not turn state: it belongs here rather than on `TurnView` so
   * `snapshot()` never writes it into a history record, and toggling it applies
   * to whichever turn is on screen.
   */
  verbose: boolean
}

export const initialState: TuiState = {
  phase: "idle",
  name: "",
  turn: 0,
  stages: [],
  agents: {},
  leaderIds: [],
  autoFollow: true,
  scroll: 0,
  history: [],
  verbose: false,
}

export type TuiAction =
  | {
      type: "turn:start"
      requirement: string
      agents: Record<string, AgentView>
      leaderIds: string[]
      startedAt: number
    }
  | { type: "event"; event: MultiClawEvent }
  | { type: "focus:cycle"; delta: number }
  | { type: "focus:set"; agentId: string }
  /**
   * Scroll the focused stream, in terminal rows. `viewport` is needed to clamp
   * at the tail, and `width` because how many rows a log line spends depends on
   * the pane's width — a line that wraps to three rows scrolls three rows.
   */
  | { type: "stream:scroll"; delta: number; viewport: number; width: number }
  /** Jump the focused stream to the newest wrapped row containing `query`. */
  | { type: "stream:search"; query: string; viewport: number; width: number }
  /** Return the focused stream to the tail and re-arm live follow. */
  | { type: "stream:latest" }
  /** Drop the focused agent's buffered output without touching its status. */
  | { type: "stream:clear" }
  /**
   * Append a console marker to one agent's stream — what the user did, not what
   * the agent said.
   *
   * Always the live turn: a mid-turn message can only reach what is running
   * now, so there is no past turn for it to belong to.
   */
  | { type: "stream:note"; agentId: string; text: string }
  /** Flip whether tool detail is shown in the stream. */
  | { type: "verbose:toggle" }
  /**
   * Start a fresh session in place: empty history, turn counter back to zero,
   * roster reseeded. Carries the seeded agents and leader ids the same way
   * `turn:start` does, so no module-level object is shared into live state.
   */
  | { type: "session:reset"; agents: Record<string, AgentView>; leaderIds: string[] }
  /**
   * Switch to an existing session: like `session:reset`, but seeded with that
   * session's finished turns so its history is on screen and the turn counter
   * continues from where it left off.
   */
  | {
      type: "session:load"
      agents: Record<string, AgentView>
      leaderIds: string[]
      history: TurnView[]
    }

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

/** Append a chunk, keeping only the last {@link MAX_LOG_CHARS} characters. */
export function appendLog(
  previous: LogSegment[],
  chunk: string,
  kind: LogKind = "text"
): LogSegment[] {
  const text = stripAnsi(chunk)
  if (!text) return previous

  // Merge with the last segment when kind matches (avoids thousands of 1-char segments during streaming)
  const last = previous[previous.length - 1]
  const next: LogSegment[] =
    last?.kind === kind
      ? [...previous.slice(0, -1), { kind, text: last.text + text }]
      : [...previous, { kind, text }]

  // Cap total chars, trimming from the front
  let total = next.reduce((sum, s) => sum + s.text.length, 0)
  if (total <= MAX_LOG_CHARS) return next

  const result = [...next]
  while (total > MAX_LOG_CHARS && result.length > 0) {
    const first = result[0]
    const excess = total - MAX_LOG_CHARS
    if (first.text.length <= excess) {
      total -= first.text.length
      result.shift()
    } else {
      result[0] = { ...first, text: first.text.slice(excess) }
      break
    }
  }
  return result
}

function blankAgent(id: string, name: string, patch: Partial<AgentView> = {}): AgentView {
  return { id, name, status: "pending", logs: [], ...patch }
}

/** ISO timestamps come from the event bus; a malformed one must not become NaN. */
function epoch(iso: string): number | undefined {
  const value = Date.parse(iso)
  return Number.isNaN(value) ? undefined : value
}

/** The model an agent will actually run with, mirroring the orchestrator's lookup. */
function agentModel(agent: AgentDefinition): string | undefined {
  return agent.model ?? agent.models?.[agent.runtime ?? "acp"]
}

/**
 * The leader that will actually run, if any.
 *
 * `useLeader: false` keeps `config.leader` around but never runs it, so the
 * console must not list it either — showing a teammate that never takes part in
 * a turn is worse than showing nothing.
 */
function activeLeader(config: MultiClawConfig): AgentDefinition | undefined {
  return config.useLeader === false ? undefined : config.leader
}

/** Every agent that takes part in a run, in declaration order: leader first. */
export function plannedAgents(config: MultiClawConfig): AgentDefinition[] {
  const leader = activeLeader(config)
  return leader ? [leader, ...config.agents] : config.agents
}

export function leaderAgentIds(config: MultiClawConfig): string[] {
  const leader = activeLeader(config)
  return leader ? [leader.id] : []
}

/**
 * Build the roster shown before (and between) runs.
 *
 * The orchestrator only reveals the team through `orchestration:start`, which it
 * emits *after* the leader has already run — so a console that learned its
 * agents purely from events would show an empty list until the first turn was
 * well under way. Seeding from the config makes the idle screen show the team
 * you are about to run, and gives every turn a known baseline to reset to.
 */
export function seedAgents(config: MultiClawConfig): Record<string, AgentView> {
  const agents: Record<string, AgentView> = {}
  for (const agent of plannedAgents(config)) {
    agents[agent.id] = blankAgent(agent.id, agent.name, {
      icon: agent.icon,
      model: agentModel(agent),
      description: agent.description,
      taskTitle: agent.taskTitle,
    })
  }
  return agents
}

/**
 * Build the console's opening state, optionally seeded with turns from disk.
 *
 * `history` is the second parameter rather than part of `config` because it is
 * *session* state, not configuration: two runs of the same config start from the
 * same config but different pasts.
 *
 * The turn counter continues from the last restored turn (`history`'s last
 * entry) so numbering stays monotonic across sessions. If it restarted at zero,
 * `/replay 3` would be ambiguous the moment a second session began — two turns
 * would share the number three.
 *
 * The parameter is optional and defaults to `[]`, so every existing caller keeps
 * the exact behaviour it had before history existed (turn 0, empty history). This
 * module is re-exported wholesale by `src/tui/index.ts`, so widening the
 * signature any other way would be a breaking change to the public API.
 */
export function createInitialState(config: MultiClawConfig, history: TurnView[] = []): TuiState {
  const agents = seedAgents(config)
  return {
    phase: "idle",
    name: config.name,
    turn: history[history.length - 1]?.turn ?? 0,
    stages: [],
    leaderIds: leaderAgentIds(config),
    agents,
    focusId: Object.keys(agents)[0],
    autoFollow: true,
    scroll: 0,
    history,
    verbose: false,
  }
}

/**
 * Fold the agents named in a stage list into the roster.
 *
 * A merge rather than a replace: the leader runs *before* `orchestration:start`,
 * so by the time the stages arrive its agent may already have status and logs
 * worth keeping. A re-published stage list (see `orchestration:stages`) hits the
 * same path for the same reason.
 */
function mergeStageAgents(
  agents: Record<string, AgentView>,
  stages: StageInfo[]
): Record<string, AgentView> {
  const next = { ...agents }
  for (const stage of stages) {
    for (const a of stage.agents) {
      const existing = next[a.id]
      next[a.id] = existing
        ? {
            ...existing,
            name: a.name,
            icon: a.icon,
            model: a.model,
            // The event's `description` is absent for a hand-rolled agent
            // definition, so fall back rather than blanking a known role.
            description: a.description ?? existing.description,
            taskTitle: a.taskTitle,
          }
        : blankAgent(a.id, a.name, {
            icon: a.icon,
            model: a.model,
            description: a.description,
            taskTitle: a.taskTitle,
          })
    }
  }
  return next
}

export function reduceEvent(state: TuiState, event: MultiClawEvent): TuiState {
  switch (event.type) {
    case "orchestration:start": {
      return {
        ...state,
        phase: "running",
        name: event.payload.name,
        effectiveRequirement: event.payload.requirement ?? state.effectiveRequirement,
        reason: event.payload.selectionReason,
        stages: event.payload.stages,
        agents: mergeStageAgents(state.agents, event.payload.stages),
      }
    }

    // The architect's task plan is applied *after* the first stage, which can
    // regroup the team. The console drew the pre-plan grouping from
    // `orchestration:start`; this is how it learns the grouping that ran.
    case "orchestration:stages": {
      return {
        ...state,
        stages: event.payload.stages.map((stage) => {
          const previous = state.stages.find((previous) => previous.stageIndex === stage.stageIndex)
          return previous?.outcome === undefined
            ? stage
            : { ...stage, outcome: previous.outcome, memberStatuses: previous.memberStatuses }
        }),
        agents: mergeStageAgents(state.agents, event.payload.stages),
      }
    }

    case "stage:start":
      return state

    case "stage:complete": {
      const stage = state.stages.find((stage) => stage.stageIndex === event.payload.stageIndex)
      if (!stage || stage.outcome !== undefined) return state
      const outcome = stageStatus(stage, state.agents)
      const memberStatuses = Object.fromEntries(
        stage.agents.map((agent) => [agent.id, state.agents[agent.id]?.status ?? "pending"])
      )
      return {
        ...state,
        stages: state.stages.map((entry) =>
          entry === stage ? { ...entry, outcome, memberStatuses } : entry
        ),
      }
    }

    case "agent:start": {
      const { agentId, agentName, icon, model, taskTitle } = event.payload
      const existing = state.agents[agentId]
      const startedAt = epoch(event.timestamp)
      const next: AgentView = existing
        ? {
            ...existing,
            name: agentName,
            icon: icon ?? existing.icon,
            model: model ?? existing.model,
            taskTitle: taskTitle ?? existing.taskTitle,
            status: "running",
            startedAt: startedAt ?? existing.startedAt,
            duration: undefined,
            attempts: undefined,
            retry: undefined,
            error: undefined,
            usage: undefined,
            costUsd: undefined,
            logs:
              existing.startedAt !== undefined && existing.logs.length > 0
                ? appendLog(existing.logs, "[agent restarted]", "system")
                : existing.logs,
          }
        : blankAgent(agentId, agentName, {
            icon,
            model,
            taskTitle,
            status: "running",
            startedAt,
          })
      const takesFocus = state.autoFollow
      return {
        ...state,
        agents: { ...state.agents, [agentId]: next },
        focusId: takesFocus ? agentId : state.focusId,
        // A new agent takes the stream with it, so the window must follow.
        scroll: takesFocus ? 0 : state.scroll,
      }
    }

    case "agent:output": {
      const { agentId, chunk, kind } = event.payload
      // Tool detail is verbose-only, and it is dropped here rather than at
      // render time so a later toggle never re-injects history that was never
      // buffered in the first place.
      if (kind === "tool-detail" && !state.verbose) return state
      const existing = state.agents[agentId]
      if (!existing) return state
      return {
        ...state,
        agents: {
          ...state.agents,
          [agentId]: { ...existing, logs: appendLog(existing.logs, chunk, kind ?? "text") },
        },
      }
    }

    case "agent:complete":
    case "agent:failed": {
      const result = event.payload
      // The status comes from the result itself, not the event type: a cancelled
      // run arrives on `agent:failed` with `status: "cancelled"`.
      const patch: Partial<AgentView> = {
        status: result.status,
        duration: result.duration,
        attempts: result.attempts,
        retry: undefined,
        error: result.error,
        usage: result.usage,
        costUsd: result.costUsd,
        // Present only on the success path; a failed agent has no session to
        // continue, so `/retry` re-runs it cold.
        sessionId: result.sessionId,
      }
      const existing = state.agents[result.agentId]
      const next: AgentView = existing
        ? { ...existing, ...patch }
        : blankAgent(result.agentId, result.agentName, patch)
      if (event.type === "agent:failed") {
        if (next.logs.length === 0 && result.output)
          next.logs = appendLog([], result.output, "text")
        const error = result.error
        if (error && !next.logs.some((s) => s.text.includes(stripAnsi(error)))) {
          next.logs = appendLog(next.logs, error, "system")
        }
      }
      return { ...state, agents: { ...state.agents, [result.agentId]: next } }
    }

    case "agent:skipped": {
      const { agentId, agentName, icon } = event.payload
      const existing = state.agents[agentId]
      const next: AgentView = existing
        ? { ...existing, status: "skipped" }
        : blankAgent(agentId, agentName, { icon, status: "skipped" })
      return { ...state, agents: { ...state.agents, [agentId]: next } }
    }

    case "agent:retrying": {
      const { agentId, agentName, attempt, maxAttempts, error } = event.payload
      const note = `[retry ${attempt}/${maxAttempts}] ${error}`
      const existing = state.agents[agentId]
      const retry = { attempt, max: maxAttempts }
      const next: AgentView = existing
        ? { ...existing, status: "retrying", retry, logs: appendLog(existing.logs, note, "system") }
        : blankAgent(agentId, agentName, {
            status: "retrying",
            retry,
            logs: appendLog([], note, "system"),
          })
      return { ...state, agents: { ...state.agents, [agentId]: next } }
    }

    case "orchestration:warning":
      return { ...state, warning: event.payload.message }

    case "orchestration:complete":
      return {
        ...state,
        phase: "complete",
        success: event.payload.success,
        acceptance: event.payload.acceptance,
        cancelled: event.payload.cancelled,
        effectiveRequirement: event.payload.requirement ?? state.effectiveRequirement,
        totalDuration: event.payload.totalDuration,
        totalCostUsd: event.payload.totalCostUsd,
        endedAt: epoch(event.timestamp) ?? Date.now(),
        reply: event.payload.reply,
      }

    default:
      return state
  }
}

/**
 * The focused agent's buffer, as the rows the pane will spend drawing it.
 *
 * `logs` holds *log lines*; the pane draws *terminal rows*. A wrapped line is
 * many rows, so the two cannot be the same unit — every window and scroll
 * calculation goes through here, and none of them may count `\n` instead.
 *
 * Memoised per log buffer. `appendLog` never mutates the array it is handed —
 * it builds a new one — so the array's identity is a reliable version stamp:
 * new output is a new array, which is a cache miss, and nothing can go stale.
 * Without this, the timeline re-measured the agent's entire session on every
 * render tick and again inside every scroll or search.
 */
const wrappedCache = new WeakMap<LogSegment[], Map<number, string[]>>()

/** Widths kept per buffer: the live one, plus a resize or two in flight. */
const MAX_CACHED_WIDTHS = 3

function wrapLog(logs: LogSegment[], width: number): string[] {
  if (logs.length === 0) return []
  let byWidth = wrappedCache.get(logs)
  if (byWidth === undefined) {
    byWidth = new Map()
    wrappedCache.set(logs, byWidth)
  }
  const cached = byWidth.get(width)
  if (cached !== undefined) return cached

  const rendered = renderSegments(logs, width)
  const rows = rendered
    .trimEnd()
    .split("\n")
    .flatMap((line) => wrapLine(line, width))
  // Bounded so a window being dragged narrower does not accumulate a full
  // re-wrap of the session per column. The newest width is the one in use.
  if (byWidth.size >= MAX_CACHED_WIDTHS) byWidth.clear()
  byWidth.set(width, rows)
  return rows
}

/** Shared tail-slice math used by both single-turn and timeline windowing. */
function windowRows(all: string[], viewport: number, scroll: number): LogWindow {
  const height = Math.max(1, viewport)
  const maxScroll = Math.max(0, all.length - height)
  const scrolledBack = Math.min(Math.max(0, scroll), maxScroll)
  const end = all.length - scrolledBack
  return {
    rows: all.slice(Math.max(0, end - height), end),
    scrolledBack,
    following: scrolledBack === 0,
  }
}

/** Clip to `max` terminal columns, marking the cut with an ellipsis. */
function clipToColumns(text: string, max: number): string {
  if (max <= 0) return ""
  if (displayWidth(text) <= max) return text
  let head = ""
  let used = 0
  for (const char of text) {
    const width = displayWidth(char)
    if (used + width > max - 1) break
    head += char
    used += width
  }
  return `${head}…`
}

/**
 * One dim horizontal rule with turn number and a clipped requirement snippet.
 *
 * Measured in columns rather than code units: a Chinese requirement is one
 * code unit per character and *two* columns, so counting code units would size
 * the rule at half the pane and let the renderer shave it — the divider would
 * stop being centred exactly when the session is in the language most likely to
 * be read here.
 */
function turnDivider(turn: TurnView, width: number): string {
  const MAX_REQ = 45
  const raw = turn.requirement?.replace(/\s+/g, " ").trim()
  const req = raw ? clipToColumns(raw, MAX_REQ) : undefined
  const label = req ? ` turn ${turn.turn} · ${req} ` : ` turn ${turn.turn} `
  const fill = Math.max(1, Math.floor((width - displayWidth(label)) / 2))
  const rule = `${"─".repeat(fill)}${label}${"─".repeat(fill)}`
  return `\x1b[2m${clipToColumns(rule, width)}\x1b[0m`
}

/** All rows a given agent produced across every finished turn, in order oldest→newest. */
function timelineRows(state: TuiState, agentId: string, width: number): string[] {
  const all: string[] = []
  // History turns: always add the divider (which carries the requirement text) even
  // when the agent was silent in that turn — so the session context stays readable.
  for (const turn of state.history) {
    const agent = turn.agents[agentId]
    all.push(turnDivider(turn, width))
    if (agent && agent.logs.length > 0) {
      all.push(...wrapLog(agent.logs, width))
    }
  }
  // Current live turn — include even while running, so output appears in real time.
  // Add a divider only when there is history above it, to mark the turn boundary.
  const liveAgent = state.agents[agentId]
  if (liveAgent && liveAgent.logs.length > 0) {
    if (state.history.length > 0) all.push(turnDivider(state, width))
    all.push(...wrapLog(liveAgent.logs, width))
  }
  return all
}
/**
 * Freeze the live turn into a record that can be read back later.
 *
 * Written out field by field rather than spread from `state`, because a spread
 * would copy `history` into itself — every turn would then carry a copy of all
 * the turns before it.
 *
 * `stages`, `agents` and `leaderIds` are shared with the live turn *by
 * reference*, on purpose: every reducer path replaces them wholesale rather than
 * mutating in place, so the snapshot can never be edited through them. That is
 * an invariant, not an accident — an in-place edit anywhere would silently
 * rewrite history, so keep the copies immutable.
 */
function snapshot(state: TuiState): TurnView {
  return {
    turn: state.turn,
    requirement: state.requirement,
    effectiveRequirement: state.effectiveRequirement,
    cancelled: state.cancelled,
    interrupted: state.interrupted,
    phase: state.phase,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    stages: state.stages,
    agents: state.agents,
    leaderIds: state.leaderIds,
    focusId: state.focusId,
    autoFollow: state.autoFollow,
    scroll: state.scroll,
    success: state.success,
    acceptance: state.acceptance,
    totalDuration: state.totalDuration,
    totalCostUsd: state.totalCostUsd,
    reason: state.reason,
    warning: state.warning,
    reply: state.reply,
  }
}

/**
 * The turns worth keeping: those already in `history`, plus the turn on screen
 * once it has ended.
 *
 * The live turn joins the set only when its `phase` is `complete`. While it is
 * still `running` it is half a turn — the requirement is known but the outcome
 * is not — and a record captured mid-flight would be written to disk as a turn
 * that never finishes. The two places that persist turns (the on-disk history
 * and the leader's conversation context) must agree on which turns exist, so
 * they both derive from here rather than each rebuilding the set.
 *
 * `snapshot` is module-private, which is why this helper lives in `state.ts`
 * rather than beside the file-writing code in `history.ts`.
 */
export function recordedTurns(state: TuiState): TurnView[] {
  return [...state.history, ...(state.phase === "complete" ? [snapshot(state)] : [])]
}

/**
 * The turns behind this one, as dialogue the leader can read back.
 *
 * Core has no notion of a session — an orchestrator is built per turn — so the
 * console is what carries earlier turns into the next run. Without them a bare
 * answer arrives at the leader as a requirement with nothing to answer: turn one
 * asks "which database?", turn two's requirement is the word "Postgres".
 *
 * Derived rather than tracked separately: the recorded turns *are* the finished
 * turns, and a second copy is one more thing that could disagree with what the
 * panes show.
 *
 * Only turns that ended are carried, which makes the call site's timing
 * irrelevant: whether this is read before or after `turn:start` moves the turn
 * on screen into `history`, the set is the same.
 *
 * An *interrupted* turn is carried even though it has no reply. A cancelled one
 * is not: the user chose to abandon it. An interrupted turn was abandoned by
 * the process, so its requirement is unfinished business — and it is the only
 * thing that makes a follow-up like "carry on with that" readable after a
 * restart.
 */
export function conversationTurns(state: TuiState): TurnRecord[] {
  const turns: TurnRecord[] = []
  for (const turn of recordedTurns(state)) {
    // Cancelled turns remain browsable, but are not completed conversation
    // context. Turn 0 is only the seeded roster, not a user request.
    if (turn.phase !== "complete" || turn.cancelled || !turn.requirement) continue
    turns.push(
      turn.reply
        ? { requirement: turn.requirement, reply: turn.reply }
        : { requirement: turn.requirement, outcome: conversationOutcome(turn) }
    )
  }
  return turns
}

function conversationOutcome(turn: TurnView): TurnOutcome {
  const reviewer = turn.acceptance?.reviewer
  const isWorker = (id: string) => id !== reviewer && !turn.leaderIds.includes(id)
  const workers = Object.values(turn.agents).filter((agent) => isWorker(agent.id))
  const completedAgents = workers
    .filter((agent) => agent.status === "success")
    .map((agent) => agent.id)
  // A failed leader can fall back to the workers; it only explains execution
  // failure when no worker actually ran.
  const observed = workers.filter(
    (agent) => agent.status !== "pending" && agent.status !== "skipped"
  )
  const failedAgents = Object.values(turn.agents)
    .filter(
      (agent) =>
        agent.id !== reviewer &&
        agent.status === "failed" &&
        (isWorker(agent.id) || observed.length === 0)
    )
    .map((agent) => ({
      agentId: agent.id,
      ...(agent.error !== undefined ? { reason: agent.error } : {}),
    }))
  const selected = turn.stages
    .flatMap((stage) => stage.agents)
    .filter((agent) => isWorker(agent.id))
  const unresolved = selected.some((agent) => {
    const status = turn.agents[agent.id]?.status
    return (
      status === undefined ||
      status === "pending" ||
      status === "running" ||
      status === "retrying" ||
      status === "skipped"
    )
  })
  // Seeded pending agents are not execution facts. Repeated runs use the latest
  // worker status, not a frozen stage outcome from an earlier attempt.
  let execution: TurnOutcome["execution"] = "unknown"
  if (turn.interrupted) execution = "interrupted"
  else if (failedAgents.length > 0) execution = "failed"
  else if (observed.some((agent) => agent.status === "cancelled")) execution = "cancelled"
  else if (
    observed.length > 0 &&
    observed.every((agent) => agent.status === "success") &&
    !unresolved
  )
    execution = "success"
  else if (observed.length === 0 && turn.success === false && !turn.acceptance) execution = "failed"
  return {
    execution,
    completedAgents,
    failedAgents,
    ...(turn.acceptance
      ? {
          acceptance: {
            status: turn.acceptance.status,
            ...(turn.acceptance.reason !== undefined ? { reason: turn.acceptance.reason } : {}),
          },
        }
      : {}),
  }
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "event":
      return reduceEvent(state, action.event)

    case "turn:start": {
      // Start a fresh turn from the configured roster: previous statuses and
      // logs are dropped, but the team list never flashes empty. The roster is
      // rebuilt rather than spread from `initialState` so no module-level object
      // is ever shared into live state.
      const ids = Object.keys(action.agents)
      // Remember the turn being replaced — but only if a turn is actually on
      // screen. `requirement` is the honest test for that: it is written by
      // `turn:start` alongside `turn`, so within a session the two agree, while
      // an idle console (fresh, or freshly seeded from disk) has a requirement
      // for nothing. Testing `turn > 0` instead would treat a history-seeded
      // console (turn N, nothing running) as if a turn were in flight and push
      // the empty initial state into history as a phantom "interrupted" record.
      const history =
        state.requirement !== undefined
          ? [...state.history, snapshot(state)].slice(-MAX_HISTORY)
          : state.history
      return {
        phase: "running",
        name: state.name,
        turn: state.turn + 1,
        requirement: action.requirement,
        startedAt: action.startedAt,
        stages: [],
        leaderIds: action.leaderIds,
        agents: action.agents,
        focusId: ids[0],
        autoFollow: true,
        scroll: 0,
        history,
        // A new requirement also replaces the previous leader metadata; leaving
        // it up would make the old answer or routing reason look like the
        // response to the new request.
        reason: undefined,
        reply: undefined,
        // A console setting, carried across turns rather than reset with them.
        verbose: state.verbose,
      }
    }

    case "focus:cycle": {
      const ids = Object.keys(state.agents)
      if (ids.length === 0) return state
      const current = state.focusId ? ids.indexOf(state.focusId) : -1
      const nextIndex = (current + action.delta + ids.length) % ids.length
      // Nowhere to move to — a single agent, or a delta that lands back on the
      // current one. Returning the same object keeps the no-op identity
      // contract, which is what stops React re-rendering the whole tree for a
      // keypress that changed nothing.
      if (nextIndex === current) return state
      // Switching agent switches the thing being read, so the window resets.
      return { ...state, focusId: ids[nextIndex], autoFollow: false, scroll: 0 }
    }

    case "focus:set": {
      if (!state.agents[action.agentId]) return state
      // Already focused *and* already pinned at the tail: the action would
      // write back exactly what is there, so it is a no-op.
      if (state.focusId === action.agentId && !state.autoFollow && state.scroll === 0) return state
      return { ...state, focusId: action.agentId, autoFollow: false, scroll: 0 }
    }

    case "stream:scroll": {
      const focusId = state.focusId
      if (!focusId) return state
      const rows = timelineRows(state, focusId, action.width).length
      const maxScroll = Math.max(0, rows - Math.max(1, action.viewport))
      const next = Math.min(Math.max(0, state.scroll + action.delta), maxScroll)
      return next === state.scroll ? state : { ...state, scroll: next }
    }

    case "stream:search": {
      const focusId = state.focusId
      if (!focusId || action.query === "") return state
      const all = timelineRows(state, focusId, action.width)
      const needle = action.query.toLowerCase()
      let index = -1
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].toLowerCase().includes(needle)) {
          index = i
          break
        }
      }
      if (index === -1) return state
      const height = Math.max(1, action.viewport)
      const maxScroll = Math.max(0, all.length - height)
      const scroll = Math.min(Math.max(0, all.length - 1 - index), maxScroll)
      return scroll === state.scroll && !state.autoFollow
        ? state
        : { ...state, scroll, autoFollow: false }
    }

    case "stream:latest":
      return state.scroll === 0 && state.autoFollow
        ? state
        : { ...state, scroll: 0, autoFollow: true }

    case "stream:clear": {
      const id = state.focusId
      const agent = id ? state.agents[id] : undefined
      if (!id || !agent) return state
      // Only the live turn's buffer: `history` is the record of turns that have
      // already ended, and editing it in place would rewrite what happened.
      return { ...state, agents: { ...state.agents, [id]: { ...agent, logs: [] } }, scroll: 0 }
    }

    case "stream:note": {
      // A console note is about work happening now, so it belongs to the live
      // turn. Writing it into `history` would edit a turn that already ended.
      const agent = state.agents[action.agentId]
      if (!agent) return state
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.agentId]: { ...agent, logs: appendLog(agent.logs, action.text, "system") },
        },
      }
    }

    case "verbose:toggle":
      return { ...state, verbose: !state.verbose }

    case "session:reset":
      return seededState(state, action.agents, action.leaderIds, [])

    case "session:load":
      return seededState(state, action.agents, action.leaderIds, action.history)
  }
}

/**
 * The idle state a session opens in, seeded with a roster and its past turns.
 *
 * Mirrors `createInitialState(config, history)` but takes the roster from the
 * caller, since the reducer has no `config`. Only `name` and `verbose` carry
 * over from the state being replaced — a session keeps the console's label and
 * settings, nothing of the previous session's turns. The roster is the caller's
 * freshly-seeded object, so no module-level value is shared into live state.
 */
function seededState(
  state: TuiState,
  agents: Record<string, AgentView>,
  leaderIds: string[],
  history: TurnView[]
): TuiState {
  const ids = Object.keys(agents)
  return {
    phase: "idle",
    name: state.name,
    turn: history[history.length - 1]?.turn ?? 0,
    requirement: undefined,
    effectiveRequirement: undefined,
    startedAt: undefined,
    endedAt: undefined,
    cancelled: undefined,
    interrupted: undefined,
    success: undefined,
    acceptance: undefined,
    totalDuration: undefined,
    totalCostUsd: undefined,
    reason: undefined,
    warning: undefined,
    reply: undefined,
    stages: [],
    leaderIds,
    agents,
    focusId: ids[0],
    autoFollow: true,
    scroll: 0,
    history,
    verbose: state.verbose,
  }
}

/**
 * Roll a stage's member statuses up into one status for the pipeline bar.
 *
 * Ordering is by severity: a failure anywhere outranks a run in flight, which
 * outranks a uniform outcome. `cancelled` is a settled outcome like `success`
 * and `skipped`, so a stage of cancelled members reads as `cancelled` rather
 * than falling through to `pending` — a stopped stage is not one that has yet
 * to start, and reporting it as `pending` would be the same lie B2-6 fixed one
 * level down.
 */
export function stageStatus(stage: TuiStageInfo, agents: Record<string, AgentView>): AgentStatus {
  if (stage.outcome !== undefined) return stage.outcome
  const statuses = stage.agents.map((a) => agents[a.id]?.status ?? "pending")
  if (statuses.some((s) => s === "failed")) return "failed"
  if (statuses.some((s) => s === "running" || s === "retrying")) return "running"
  if (statuses.length > 0 && statuses.every((s) => s === "success")) return "success"
  if (statuses.length > 0 && statuses.every((s) => s === "skipped")) return "skipped"
  if (statuses.length > 0 && statuses.every((s) => s === "cancelled")) return "cancelled"
  return "pending"
}

const SETTLED: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "success",
  "failed",
  "cancelled",
  "skipped",
])

/** How many agents have finished, out of how many the turn will run. */
export function progress(turn: TurnView): { done: number; total: number } {
  const agents = Object.values(turn.agents)
  return { done: agents.filter((a) => SETTLED.has(a.status)).length, total: agents.length }
}

/**
 * An agent's time: the live clock while it runs, the recorded duration once it
 * has stopped. Returning the *same* number after completion is what stops the
 * column from jittering when a stage ends.
 */
export function agentElapsed(agent: AgentView, now: number): number | undefined {
  if (agent.status === "running" || agent.status === "retrying") {
    return agent.startedAt === undefined ? undefined : Math.max(0, now - agent.startedAt)
  }
  return agent.duration
}

/** The turn's time, live while running and frozen once the orchestrator reports back. */
export function turnElapsed(turn: TurnView, now: number): number | undefined {
  if (turn.totalDuration !== undefined) return turn.totalDuration
  if (turn.startedAt === undefined) return undefined
  const end = turn.phase === "running" ? now : (turn.endedAt ?? now)
  return Math.max(0, end - turn.startedAt)
}

export interface LogWindow {
  /** The wrapped rows that fit, oldest first. */
  rows: string[]
  /** How many rows sit below the window. Zero means the stream is live. */
  scrolledBack: number
  following: boolean
}

/**
 * The slice of the focused agent's session that fits the pane.
 *
 * Wrapped first, then windowed, and both steps are needed: the pane is a fixed
 * number of *rows*, while the buffer is a string of *lines*, and one line can
 * spend several rows. Slicing lines would hand the pane more rows than it has
 * and push the newest output out of sight.
 *
 * Turn-divider rows are interspersed to give the reader an anchor: they show
 * the turn number and a clipped requirement snippet so a reader scrolled back
 * knows which request they are looking at.
 *
 * Clamping here as well as in the reducer keeps the window correct even when
 * the pane is resized between two scroll actions. Scroll semantics: 0 means
 * pinned to the newest output, positive values mean scrolled back, and
 * `following` is true when the window is at the tail.
 */
export function visibleTimeline(
  state: TuiState,
  agentId: string,
  viewport: number,
  width: number,
  scroll: number
): LogWindow {
  return windowRows(timelineRows(state, agentId, width), viewport, scroll)
}
