import type {
  AgentDefinition,
  AgentStatus,
  LeaderMessage,
  MultiClawConfig,
  MultiClawEvent,
  StageInfo,
} from "@multiclawcli/core"

/**
 * Per-agent log buffer cap, in characters.
 *
 * The previous web store appended output forever (`logs: a.logs + chunk`). A
 * chatty agent running for hours would grow that string without bound. The TUI
 * renders a tail window, so only the tail is worth keeping.
 */
export const MAX_LOG_CHARS = 8000

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
  logs: string
}

export type TuiPhase = "idle" | "running" | "complete"

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
  phase: TuiPhase
  /** Wall clock at which the turn started. */
  startedAt?: number
  /** Wall clock at which the turn finished. */
  endedAt?: number
  stages: StageInfo[]
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
   * How many lines the stream is scrolled back from the tail. Zero means the
   * stream is live. Kept as an offset rather than an absolute index so new
   * output arriving underneath does not shift what the user is reading.
   */
  scroll: number
  success?: boolean
  totalDuration?: number
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
   * A finished turn opened for reading.
   *
   * Kept as a detached copy so scrolling and tabbing through it cannot disturb
   * the turn that is actually running. While it is set the panes render it, and
   * `focusId` / `scroll` edits land on it rather than on the live turn.
   */
  view?: TurnView
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
  /** Scroll the focused stream. `viewport` is needed to clamp at the tail. */
  | { type: "stream:scroll"; delta: number; viewport: number }
  /** Drop the focused agent's buffered output without touching its status. */
  | { type: "stream:clear" }
  /** Open a finished turn for reading, by its turn number. */
  | { type: "view:open"; turn: number }
  /** Go back to the live turn. */
  | { type: "view:close" }

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

/** Append a chunk, keeping only the last {@link MAX_LOG_CHARS} characters. */
export function appendLog(previous: string, chunk: string): string {
  const next = previous + stripAnsi(chunk)
  return next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next
}

function blankAgent(id: string, name: string, patch: Partial<AgentView> = {}): AgentView {
  return { id, name, status: "pending", logs: "", ...patch }
}

/** ISO timestamps come from the event bus; a malformed one must not become NaN. */
function epoch(iso: string): number | undefined {
  const value = Date.parse(iso)
  return Number.isNaN(value) ? undefined : value
}

/** The model an agent will actually run with, mirroring the orchestrator's lookup. */
function agentModel(agent: AgentDefinition): string | undefined {
  return agent.model ?? agent.models?.[agent.runtime ?? "claude"]
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

export function createInitialState(config: MultiClawConfig): TuiState {
  const agents = seedAgents(config)
  return {
    phase: "idle",
    name: config.name,
    turn: 0,
    stages: [],
    leaderIds: leaderAgentIds(config),
    agents,
    focusId: Object.keys(agents)[0],
    autoFollow: true,
    scroll: 0,
    history: [],
  }
}

export function reduceEvent(state: TuiState, event: MultiClawEvent): TuiState {
  switch (event.type) {
    case "orchestration:start": {
      const agents = { ...state.agents }
      for (const stage of event.payload.stages) {
        for (const a of stage.agents) {
          const existing = agents[a.id]
          agents[a.id] = existing
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
      return {
        ...state,
        phase: "running",
        name: event.payload.name,
        requirement: event.payload.requirement ?? state.requirement,
        stages: event.payload.stages,
        agents,
      }
    }

    // Stage boundaries carry no state of their own — the per-agent statuses
    // derived from them already drive the pipeline bar.
    case "stage:start":
    case "stage:complete":
      return state

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
      const { agentId, chunk } = event.payload
      const existing = state.agents[agentId]
      if (!existing) return state
      return {
        ...state,
        agents: {
          ...state.agents,
          [agentId]: { ...existing, logs: appendLog(existing.logs, chunk) },
        },
      }
    }

    case "agent:complete":
    case "agent:failed": {
      const result = event.payload
      const status: AgentStatus = event.type === "agent:complete" ? "success" : "failed"
      const existing = state.agents[result.agentId]
      const next: AgentView = existing
        ? {
            ...existing,
            status,
            duration: result.duration,
            attempts: result.attempts,
            error: result.error,
          }
        : blankAgent(result.agentId, result.agentName, {
            status,
            duration: result.duration,
            attempts: result.attempts,
            error: result.error,
          })
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
      const note = `\n[retry ${attempt}/${maxAttempts}] ${error}\n`
      const existing = state.agents[agentId]
      const retry = { attempt, max: maxAttempts }
      const next: AgentView = existing
        ? { ...existing, status: "retrying", retry, logs: appendLog(existing.logs, note) }
        : blankAgent(agentId, agentName, { status: "retrying", retry, logs: note })
      return { ...state, agents: { ...state.agents, [agentId]: next } }
    }

    case "orchestration:warning":
      return { ...state, warning: event.payload.message }

    case "orchestration:complete":
      return {
        ...state,
        phase: "complete",
        success: event.payload.success,
        totalDuration: event.payload.totalDuration,
        endedAt: epoch(event.timestamp) ?? Date.now(),
        reply: event.payload.reply,
      }

    default:
      return state
  }
}

/** Line count of the focused agent's buffer, which is what scroll clamps against. */
function focusedLineCount(turn: TurnView): number {
  const agent = turn.focusId ? turn.agents[turn.focusId] : undefined
  return agent?.logs ? agent.logs.split("\n").length : 0
}

/**
 * Freeze the live turn into a record that can be read back later.
 *
 * Written out field by field rather than spread from `state`, because a spread
 * would copy `history` into itself — every turn would then carry a copy of all
 * the turns before it.
 */
function snapshot(state: TuiState): TurnView {
  return {
    turn: state.turn,
    requirement: state.requirement,
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
    totalDuration: state.totalDuration,
    warning: state.warning,
    reply: state.reply,
  }
}

/**
 * Apply an edit to whichever turn the panes are showing.
 *
 * Browsing a past turn has to be harmless: if tab and scroll wrote to the live
 * turn they would move the focus out from under a run in progress, and if they
 * wrote to the history record they would rewrite history. Neither is acceptable,
 * so the edit lands on the detached `view` copy and the record stays as it was.
 *
 * Returning the same object means "nothing changed", which is what keeps the
 * reducer's no-op identity contract intact for the tests and for React.
 */
function mapShown(state: TuiState, fn: (turn: TurnView) => TurnView): TuiState {
  if (state.view) {
    const next = fn(state.view)
    return next === state.view ? state : { ...state, view: next }
  }
  const next = fn(state)
  return next === state ? state : { ...state, ...next }
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
      // Turn 0 is the seeded roster, not a turn anyone asked for, so there is
      // nothing to remember until a requirement has actually been run.
      const history =
        state.turn > 0 ? [...state.history, snapshot(state)].slice(-MAX_HISTORY) : state.history
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
        // A new requirement replaces the previous answer; leaving it up would
        // make the old reply look like the response to the new request. Reading
        // a past turn ends for the same reason — the panes belong to the run.
        reply: undefined,
        view: undefined,
      }
    }

    case "focus:cycle":
      return mapShown(state, (turn) => {
        const ids = Object.keys(turn.agents)
        if (ids.length === 0) return turn
        const current = turn.focusId ? ids.indexOf(turn.focusId) : -1
        const nextIndex = (current + action.delta + ids.length) % ids.length
        // Switching agent switches the thing being read, so the window resets.
        return { ...turn, focusId: ids[nextIndex], autoFollow: false, scroll: 0 }
      })

    case "focus:set":
      return mapShown(state, (turn) =>
        turn.agents[action.agentId]
          ? { ...turn, focusId: action.agentId, autoFollow: false, scroll: 0 }
          : turn
      )

    case "stream:scroll":
      return mapShown(state, (turn) => {
        const lines = focusedLineCount(turn)
        const maxScroll = Math.max(0, lines - Math.max(1, action.viewport))
        const next = Math.min(Math.max(0, turn.scroll + action.delta), maxScroll)
        return next === turn.scroll ? turn : { ...turn, scroll: next }
      })

    case "stream:clear":
      return mapShown(state, (turn) => {
        const id = turn.focusId
        const agent = id ? turn.agents[id] : undefined
        if (!id || !agent) return turn
        return { ...turn, agents: { ...turn.agents, [id]: { ...agent, logs: "" } }, scroll: 0 }
      })

    case "view:open": {
      const record = state.history.find((turn) => turn.turn === action.turn)
      return record ? { ...state, view: record } : state
    }

    case "view:close":
      return state.view ? { ...state, view: undefined } : state
  }
}

/** Roll a stage's member statuses up into one status for the pipeline bar. */
export function stageStatus(stage: StageInfo, agents: Record<string, AgentView>): AgentStatus {
  const statuses = stage.agents.map((a) => agents[a.id]?.status ?? "pending")
  if (statuses.some((s) => s === "failed")) return "failed"
  if (statuses.some((s) => s === "running" || s === "retrying")) return "running"
  if (statuses.length > 0 && statuses.every((s) => s === "success")) return "success"
  if (statuses.length > 0 && statuses.every((s) => s === "skipped")) return "skipped"
  return "pending"
}

const SETTLED: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["success", "failed", "skipped"])

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
  lines: string[]
  /** How many lines sit below the window. Zero means the stream is live. */
  scrolledBack: number
  following: boolean
}

/**
 * The slice of the focused agent's output that fits the pane.
 *
 * Clamping here as well as in the reducer keeps the window correct even when
 * the pane is resized between two scroll actions.
 */
export function visibleLog(turn: TurnView, viewport: number): LogWindow {
  const agent = turn.focusId ? turn.agents[turn.focusId] : undefined
  const all = agent?.logs ? agent.logs.split("\n") : []
  const height = Math.max(1, viewport)
  const maxScroll = Math.max(0, all.length - height)
  const scrolledBack = Math.min(Math.max(0, turn.scroll), maxScroll)
  const end = all.length - scrolledBack
  return {
    lines: all.slice(Math.max(0, end - height), end),
    scrolledBack,
    following: scrolledBack === 0,
  }
}
