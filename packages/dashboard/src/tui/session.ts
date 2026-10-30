import * as fs from "node:fs"
import * as path from "node:path"
import { writeJsonFile } from "./atomic"
import { CONSOLE_DIR, loadHistory } from "./history"
import {
  type AgentView,
  MAX_HISTORY,
  type TuiStageInfo,
  type TuiState,
  type TurnView,
} from "./state"

/**
 * The session journal: what a restart needs to pick the console back up.
 *
 * Live agent sessions are child processes, and a pending approval is an RPC in
 * flight to one of them — neither survives the process that owns them. So this
 * file deliberately does not try to *continue* a turn. It records the boundary
 * instead: which turn was running, what the user had typed but not run, where
 * the current task began, and how many decisions were waiting. A restart can
 * then say what happened, show the interrupted turn as a turn, and hand the
 * queued input back — without pretending a dead agent is still working.
 */
export const SESSION_FILE = "session.json"

/** Bumped when the on-disk shape changes in a way an older console cannot read. */
export const SESSION_VERSION = 1

/**
 * How much of each agent's log the journal keeps.
 *
 * The live buffer holds `MAX_LOG_CHARS` per agent and a turn can have a dozen
 * agents, so journaling it whole would rewrite a multi-hundred-kilobyte file
 * every few seconds. The tail is what answers "what was it doing when it died",
 * and it is the only part worth the write.
 */
export const MAX_JOURNAL_LOG_CHARS = 1200

/** The turn that was in flight when the journal was last written. */
export interface JournalTurn {
  turn: number
  requirement: string
  startedAt?: number
  effectiveRequirement?: string
  reason?: string
  warning?: string
  /**
   * Wall clock of this write — the last moment the console was known to be
   * alive. The restored turn ends here, so its duration reads as "how long it
   * ran", not "how long ago it was".
   */
  savedAt: number
  leaderIds: string[]
  focusId?: string
  stages: TuiStageInfo[]
  agents: Record<string, AgentView>
  /** Decisions the agents were waiting on. A restart cannot answer them. */
  pending?: { permissions: number; questions: number }
}

export interface SessionJournal {
  version: number
  /**
   * Turn number the current task began at.
   *
   * `/task` closes the previous task's context, and that boundary has to outlive
   * the process: without it a restart would hand the leader every turn ever run
   * in the workspace, including the ones the user explicitly closed.
   */
  taskStart?: number
  /** Follow-ups typed but never run, in the order they were typed. */
  queue?: string[]
  inFlight?: JournalTurn
}

/** Where the console keeps its session journal for a workspace. */
export function sessionPath(workDir: string): string {
  return path.join(workDir, ".multiclaw", CONSOLE_DIR, SESSION_FILE)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "retrying",
  "success",
  "failed",
  "cancelled",
  "skipped",
])

/**
 * Is this an agent row the panes can render?
 *
 * Checks the fields the console *reads* rather than the whole of `AgentView`:
 * a field-by-field schema would be a second definition of the type, free to
 * drift from the real one. A row missing a status or a log would throw in
 * `progress()` / `wrapLog`, which is the failure this has to prevent.
 */
function isAgentView(value: unknown): value is AgentView {
  if (!isObject(value)) return false
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.logs === "string" &&
    typeof value.status === "string" &&
    STATUSES.has(value.status)
  )
}

function isJournalTurn(value: unknown): value is JournalTurn {
  if (!isObject(value)) return false
  return (
    Number.isInteger(value.turn) &&
    typeof value.requirement === "string" &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    (value.startedAt === undefined || typeof value.startedAt === "number") &&
    (value.effectiveRequirement === undefined || typeof value.effectiveRequirement === "string") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.warning === undefined || typeof value.warning === "string") &&
    (value.focusId === undefined || typeof value.focusId === "string") &&
    isObject(value.agents) &&
    Object.values(value.agents).every(isAgentView) &&
    Array.isArray(value.leaderIds) &&
    value.leaderIds.every((id) => typeof id === "string") &&
    Array.isArray(value.stages) &&
    value.stages.every(isObject) &&
    (value.pending === undefined ||
      (isObject(value.pending) &&
        Number.isInteger(value.pending.permissions) &&
        Number.isInteger(value.pending.questions)))
  )
}

/**
 * Read the workspace's session journal.
 *
 * Never throws, for the same reason `loadHistory` does not: a corrupted side
 * file means "no journal", and a console that refuses to start over it would be
 * far worse than one that starts with an empty past. A journal written by a
 * newer console (unknown `version`) is ignored rather than guessed at.
 */
export function loadJournal(workDir: string): SessionJournal | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(sessionPath(workDir), "utf-8"))
    if (!isObject(parsed) || parsed.version !== SESSION_VERSION) return undefined
    const queue = Array.isArray(parsed.queue)
      ? parsed.queue.filter((item): item is string => typeof item === "string" && item !== "")
      : []
    return {
      version: SESSION_VERSION,
      ...(Number.isInteger(parsed.taskStart) && (parsed.taskStart as number) >= 0
        ? { taskStart: parsed.taskStart as number }
        : {}),
      ...(queue.length > 0 ? { queue } : {}),
      ...(isJournalTurn(parsed.inFlight) ? { inFlight: parsed.inFlight } : {}),
    }
  } catch {
    return undefined
  }
}

/** True when the journal has nothing worth keeping a file for. */
function isEmpty(journal: SessionJournal): boolean {
  return journal.inFlight === undefined && journal.queue === undefined && !journal.taskStart
}

/**
 * Write the workspace's session journal.
 *
 * Atomic and serialized per path (see {@link writeJsonFile}): the whole point is
 * to survive a process that dies mid-write, so the write itself must never be
 * the thing that leaves a torn file behind.
 *
 * An empty journal does not create the file. A console that was opened and quit
 * without doing anything should not leave `.multiclaw/console/` behind — but an
 * *existing* journal is still rewritten when it empties, because "nothing is in
 * flight" is exactly what the next start needs to read.
 */
export function saveJournal(workDir: string, journal: SessionJournal): Promise<void> {
  const target = sessionPath(workDir)
  if (isEmpty(journal) && !fs.existsSync(target)) return Promise.resolve()
  return writeJsonFile(target, JSON.stringify(journal))
}

/** Keep the tail of a log, marked so a restored reader knows output was dropped. */
function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text
}

/**
 * The journal entry for a turn that is running right now.
 *
 * A pure projection of what the panes are showing, so the journal can never
 * describe a turn the console is not actually running. Logs are trimmed; every
 * other field is small enough to keep whole.
 */
export function journalTurn(
  state: TuiState,
  pending: { permissions: number; questions: number }
): JournalTurn {
  const agents: Record<string, AgentView> = {}
  for (const [id, agent] of Object.entries(state.agents)) {
    agents[id] = { ...agent, logs: tail(agent.logs, MAX_JOURNAL_LOG_CHARS) }
  }
  return {
    turn: state.turn,
    requirement: state.requirement ?? "",
    startedAt: state.startedAt,
    effectiveRequirement: state.effectiveRequirement,
    reason: state.reason,
    warning: state.warning,
    savedAt: Date.now(),
    leaderIds: state.leaderIds,
    focusId: state.focusId,
    stages: state.stages,
    agents,
    pending,
  }
}

/** Statuses that mean "still working", which nothing is after a restart. */
const UNSETTLED: ReadonlySet<string> = new Set(["pending", "running", "retrying"])

/**
 * Rebuild an interrupted turn as a browsable record.
 *
 * Two deliberate rewrites, both because the record must not claim work that is
 * not happening:
 *
 * - An agent that never reported back becomes `cancelled`. Leaving it `running`
 *   would animate a spinner and a growing clock for a process that died with
 *   the console.
 * - Stage outcomes are dropped so they are re-derived from those statuses. A
 *   stage that had finished before the crash keeps its success, and one that was
 *   mid-flight reads as cancelled instead of frozen at `running` for ever.
 *
 * The turn itself is `complete` — nothing will be added to it — with
 * `interrupted` set so every surface can say *how* it ended.
 */
export function interruptedTurn(entry: JournalTurn): TurnView {
  const agents: Record<string, AgentView> = {}
  for (const [id, agent] of Object.entries(entry.agents)) {
    agents[id] = UNSETTLED.has(agent.status) ? { ...agent, status: "cancelled" } : { ...agent }
  }
  return {
    turn: entry.turn,
    requirement: entry.requirement,
    effectiveRequirement: entry.effectiveRequirement,
    reason: entry.reason,
    warning: entry.warning,
    phase: "complete",
    interrupted: true,
    success: false,
    startedAt: entry.startedAt,
    endedAt: entry.savedAt,
    stages: entry.stages.map((stage) => ({ stageIndex: stage.stageIndex, agents: stage.agents })),
    agents,
    leaderIds: entry.leaderIds,
    focusId: entry.focusId,
    autoFollow: false,
    scroll: 0,
  }
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

export interface RestoredConsole {
  history: TurnView[]
  queue: string[]
  taskStart: number
  /** The last turn ended by asking the user something, so the console reopens ready for it. */
  awaitingAnswer: boolean
  /** One line for the notice bar, when the previous session left work behind. */
  notice?: string
}

/**
 * Everything the console should open with, read once at startup.
 *
 * The interrupted turn is appended to the restored history rather than replacing
 * it: the turns before it still happened. It is skipped when history already
 * holds that turn number, because a restored turn is written back to
 * `history.json` on the very next save — a second restart must not add it twice.
 * A journal *behind* the last recorded turn is stale (the history was written by
 * a later session) and is dropped for the same reason.
 */
export function restoreConsole(workDir: string): RestoredConsole {
  const history = loadHistory(workDir)
  const journal = loadJournal(workDir)
  const inFlight = journal?.inFlight
  const last = history[history.length - 1]
  const parts: string[] = []

  if (inFlight && (!last || inFlight.turn > last.turn)) {
    history.push(interruptedTurn(inFlight))
    parts.push(`turn ${inFlight.turn} was interrupted by a restart`)
    const pending = (inFlight.pending?.permissions ?? 0) + (inFlight.pending?.questions ?? 0)
    if (pending > 0) {
      parts.push(`${pending} pending ${plural(pending, "decision")} discarded`)
    }
  }

  const queue = journal?.queue ?? []
  if (queue.length > 0) {
    parts.push(
      `${queue.length} queued ${plural(queue.length, "follow-up")} restored — /continue resumes ${queue.length === 1 ? "it" : "them"}`
    )
  }

  const restored = history.slice(-MAX_HISTORY)
  return {
    history: restored,
    queue,
    taskStart: journal?.taskStart ?? 0,
    // Read from the *final* last turn: a recovered interrupted turn has no
    // reply, so it correctly clears the "waiting for an answer" state.
    awaitingAnswer: restored[restored.length - 1]?.reply?.mode === "ask",
    ...(parts.length > 0 ? { notice: parts.join(" · ") } : {}),
  }
}
