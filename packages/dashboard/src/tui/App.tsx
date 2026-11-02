import * as path from "node:path"
import type {
  CheckpointHandler,
  CheckpointResponse,
  EventBus,
  MultiClawConfig,
  MultiClawEvent,
  RuntimePermissionHandler,
  RuntimePermissionRequest,
  RuntimeQuestionHandler,
  RuntimeQuestionRequest,
  RuntimeQuestionResponse,
  SupplementReport,
} from "@multiclawcli/core"
import {
  AgentSessionManager,
  describeResumePlan,
  isAbortError,
  Orchestrator,
  validateRuntimeQuestionContent,
} from "@multiclawcli/core"
import { Box, type Key, Text, useApp, useInput, useWindowSize } from "ink"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { pendingWrite } from "./atomic"
import {
  argQuery,
  canRun,
  completeAgents,
  isCommandLine,
  matchCommands,
  menuQuery,
  type PaletteRow,
  paletteRows,
  parseCommand,
  resolveAgentId,
  unavailableReason,
} from "./commands"
import {
  Header,
  HintBar,
  PipelineRail,
  QueueStrip,
  Rule,
  railCellWidths,
} from "./components/chrome"
import { PermissionBar, QuestionForm } from "./components/interaction"
import { HelpOverlay, listWindowStart, SessionsOverlay } from "./components/overlays"
import {
  Divider,
  ErrorPanel,
  ReplyPanel,
  StreamPanel,
  TeamPanel,
  WelcomePanel,
} from "./components/panels"
import { CommandMenu, MARKER_WIDTH, Prompt, promptRowCount } from "./components/prompt"
import { describeSteering, formatCost, formatDuration } from "./format"
import { appendTurns, exportPath, exportTurn, turnsPath } from "./history"
import {
  clean,
  commitField,
  type FormState,
  focusField,
  formComplete,
  formContent,
  formFields,
  initialForm,
  interactionRows,
  jumpCursor,
  jumpPick,
  moveCursor,
  movePick,
  permissionChoices,
  toggleBoolean,
  toggleChoice,
  withDraft,
} from "./interaction"
import { computeLayout, MIN_COLUMNS } from "./layout"
import {
  journalTurn,
  restoreConsole,
  SESSION_VERSION,
  type SessionJournal,
  saveJournal,
  sessionPath,
} from "./session"
import {
  createSession,
  deleteSession,
  latestSession,
  listSessions,
  type SessionMeta,
  touchSession,
} from "./sessions"
import {
  conversationTurns,
  createInitialState,
  leaderAgentIds,
  plannedAgents,
  progress,
  recordedTurns,
  seedAgents,
  type TurnView,
  tuiReducer,
  turnElapsed,
} from "./state"
import { COLOR, GLYPH, SPINNER, STATUS } from "./theme"

/**
 * How the console should choose its session on launch.
 *
 * Absent means the default: continue the most recent session, or start one when
 * the workspace has none. `new` always starts fresh. `resume` opens the named
 * session, or — with no id — the most recent one with the picker already open,
 * so `multiclaw -r` lands on the list the way `claude -r` does.
 */
export type InitialSession = { kind: "new" } | { kind: "resume"; id?: string }

export interface AppProps {
  config: MultiClawConfig
  /**
   * Called once per turn, after that turn's orchestrator exists. The CLI uses it
   * to attach a file log writer without the TUI depending on the CLI package.
   */
  onTurnStart?: (eventBus: EventBus, logDir: string) => void | (() => void | Promise<void>)
  /** Caller-owned resources; startTui also closes them on render failures. */
  sessions?: AgentSessionManager
  /** Gives the terminal host an awaitable cleanup barrier, including render failures. */
  onCleanupReady?: (cleanup: () => Promise<void>) => void
  /** How to choose the session on launch; defaults to continuing the latest. */
  initialSession?: InitialSession
}

/** Agents emit output in many small chunks; batching keeps re-renders bounded. */
const FLUSH_INTERVAL_MS = 80

/** Spinner cadence. Also drives every live clock, so it must stay well under a second. */
const SPINNER_INTERVAL_MS = 110

/** Standard terminal cursor blink period, in milliseconds. */
const BLINK_INTERVAL_MS = 530

/**
 * How often a running turn's journal is rewritten.
 *
 * The journal is what a restart reads, so it has to be current enough that
 * "what was it doing" is still true — but it is also a disk write, so it cannot
 * follow the stream. A couple of seconds is both: the logs are a tail, not a
 * transcript, and a turn that died mid-write loses at most that much.
 */
const SESSION_SAVE_INTERVAL_MS = 2000

const INPUT_PLACEHOLDER = "describe what the team should do…"
const RUNNING_PLACEHOLDER = "type to queue a follow-up…"

interface Line {
  text: string
  cursor: number
}

const EMPTY_LINE: Line = { text: "", cursor: 0 }

type PendingInteraction =
  | {
      kind: "permission"
      request: RuntimePermissionRequest
      shortId: string
      settle: (optionId?: string) => void
    }
  | {
      kind: "question"
      request: RuntimeQuestionRequest
      shortId: string
      settle: (response?: RuntimeQuestionResponse) => void
    }

/**
 * The turn `/replay` or `/fork` should act on, or the reason there is none.
 *
 * Shared by both commands so "which turn" — the last one by default, or the one
 * whose number was typed — is one rule rather than two. The empty-case wording
 * is the caller's, because "nothing to replay" and "nothing to fork" are not the
 * same sentence. On success the requirement is returned alongside the record, so
 * neither caller has to re-prove it is set.
 */
function pickRecordedTurn(
  state: ReturnType<typeof tuiReducer>,
  raw: string | undefined,
  whenEmpty: string
): { record: TurnView } | { error: string } {
  const turns = recordedTurns(state)
  if (turns.length === 0) return { error: whenEmpty }
  const target =
    raw === undefined ? turns[turns.length - 1] : turns.find((t) => String(t.turn) === raw)
  if (!target) return { error: `no turn ${raw}` }
  return { record: target }
}

function pickTurn(
  state: ReturnType<typeof tuiReducer>,
  raw: string | undefined,
  whenEmpty: string
): { record: TurnView; requirement: string } | { error: string } {
  const target = pickRecordedTurn(state, raw, whenEmpty)
  if ("error" in target) return target
  if (!target.record.requirement) return { error: `turn ${target.record.turn} has no requirement` }
  return { record: target.record, requirement: target.record.requirement }
}

/** The sessions a finished turn's agents reported, keyed by agent id. */
function turnSessions(turn: TurnView): Record<string, string> {
  const sessions: Record<string, string> = {}
  for (const agent of Object.values(turn.agents)) {
    if (agent.sessionId) sessions[agent.id] = agent.sessionId
  }
  return sessions
}

/** A past turn whose conversation the next instruction should continue. */
interface Continuation {
  turn: number
  sessions: Record<string, string>
}

/**
 * The `resume` that continues a past conversation, or undefined when there is
 * nothing left to continue.
 *
 * Only agents whose session this process no longer holds are named. A live
 * session already carries its history, and naming its id would change the
 * session manager's fingerprint and make it close and `session/load` a session
 * it is holding open — the case that matters is the restart, where every
 * session is gone and the id on disk is the only handle.
 */
function continuationResume(
  continuation: Continuation | null,
  live: AgentSessionManager | null
): MultiClawConfig["resume"] | undefined {
  if (!continuation) return undefined
  const sessions = Object.fromEntries(
    Object.entries(continuation.sessions).filter(([id]) => !live?.has(id))
  )
  return Object.keys(sessions).length > 0 ? { sessions } : undefined
}

function StatusLine({
  state,
  running,
  cancelled,
  error,
  now,
  spinner,
  queued,
}: {
  state: ReturnType<typeof tuiReducer>
  running: boolean
  cancelled: boolean
  error?: string
  now: number
  spinner: string
  queued: number
}) {
  const { done, total } = progress(state)

  if (error)
    return (
      <Text color={COLOR.error} wrap="truncate-end">
        {error}
      </Text>
    )
  // A warning is live information while the turn is in flight, but it must not
  // outlive the turn. `warning` is only cleared by the next `turn:start`, so
  // letting it win once the turn is complete would hide the outcome forever —
  // the user would never learn whether the run succeeded.
  if (state.warning && state.phase !== "complete")
    return (
      <Text color={COLOR.warn} wrap="truncate-end">
        {state.warning}
      </Text>
    )
  if ((cancelled || state.cancelled) && !running)
    return <Text color={COLOR.warn}>cancelled · workspace changes are retained</Text>

  // A turn the leader answered ends in words, not in a pipeline. Saying "done"
  // there would claim work that never happened.
  if (state.reply) {
    const asking = state.reply.mode === "ask"
    return (
      <Text color={asking ? COLOR.warn : COLOR.ok} wrap="truncate-end">
        {asking ? `${GLYPH.ask} needs your input` : `${STATUS.success.glyph} answered`}
      </Text>
    )
  }

  if (running) {
    const elapsed = turnElapsed(state, now)
    const time = elapsed === undefined ? "" : ` ${formatDuration(elapsed)}`
    return (
      <Text color={COLOR.accent} wrap="truncate-end">
        {spinner} running{time} · {done}/{total} agents
        {queued > 0 ? ` · ${queued} queued` : ""}
      </Text>
    )
  }

  if (state.phase === "complete") {
    const time = state.totalDuration === undefined ? "" : ` ${formatDuration(state.totalDuration)}`
    // The outcome leads once the turn is over; a warning raised mid-turn rides
    // along beside it rather than replacing it.
    const outcome = state.acceptance
      ? `${state.success ? STATUS.success.glyph : STATUS.failed.glyph} ${
          state.acceptance.status === "approved"
            ? "delivery approved"
            : state.acceptance.status === "changes_required"
              ? "changes required"
              : "acceptance failed"
        }${time}`
      : state.success
        ? `${STATUS.success.glyph} done${time}`
        : `${STATUS.failed.glyph} finished with failures${time}`
    // Cost, only when the run actually reported one — never "$0.00" by default.
    const cost = state.totalCostUsd === undefined ? "" : ` · ${formatCost(state.totalCostUsd)}`
    return (
      <Text color={state.success ? COLOR.ok : COLOR.error} wrap="truncate-end">
        {outcome}
        {cost}
        {state.warning ? ` · ${GLYPH.warn} ${state.warning}` : ""}
      </Text>
    )
  }

  const stages = state.stages.length
  return (
    <Text dimColor wrap="truncate-end">
      ready · {total} agents{stages > 0 ? ` · ${stages} stages` : ""}
    </Text>
  )
}

export function App({
  config,
  onTurnStart,
  sessions: providedSessions,
  onCleanupReady,
  initialSession,
}: AppProps) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()

  // The session this console is attached to, and how it was chosen (see
  // {@link InitialSession}). Resolved once, synchronously, before the first
  // frame — every read and write below is scoped to it. A launch notice and the
  // "open the picker on mount" flag fall out of the same decision.
  const sessionIdRef = useRef<string | null>(null)
  const launchNoticeRef = useRef<string | undefined>(undefined)
  const openPickerOnMountRef = useRef(false)
  if (!sessionIdRef.current) {
    const latest = () => latestSession(config.workDir)?.id ?? createSession(config.workDir).id
    if (initialSession?.kind === "new") {
      sessionIdRef.current = createSession(config.workDir).id
    } else if (initialSession?.kind === "resume" && initialSession.id) {
      const target = initialSession.id
      if (listSessions(config.workDir).some((s) => s.id === target)) {
        sessionIdRef.current = target
      } else {
        sessionIdRef.current = latest()
        launchNoticeRef.current = `session "${target}" not found — opened the most recent instead`
      }
    } else {
      sessionIdRef.current = latest()
      // `-r` with no id: land on the picker, like `claude -r`.
      if (initialSession?.kind === "resume") openPickerOnMountRef.current = true
    }
  }
  // Open with whatever that session left on disk. Read once, synchronously,
  // before the first frame: the history list, the interrupted turn the previous
  // process never finished, and the follow-ups it never ran. An async load would
  // race the user's first turn and force a "history still loading" state that
  // nothing else needs.
  const restoredRef = useRef<ReturnType<typeof restoreConsole> | null>(null)
  if (!restoredRef.current) {
    restoredRef.current = restoreConsole(config.workDir, sessionIdRef.current)
  }
  const restored = restoredRef.current
  // The highest turn number already in the session's log. The save path appends
  // only turns past this, so an append is O(1) rather than a rewrite — see the
  // finished-turn effect below.
  const persistedTurnRef = useRef(restored.persistedTurn)

  const [state, dispatch] = useReducer(tuiReducer, config, (c) =>
    createInitialState(c, restored.history)
  )
  // `startTurn` is not rebuilt when state changes, so it reads the turn on screen
  // through a ref. The conversation it hands the leader has to be the one the
  // panes are showing, not the one from whichever render created the callback.
  const stateRef = useRef(state)
  stateRef.current = state
  const [line, setLine] = useState<Line>(EMPTY_LINE)
  const [caretOn, setCaretOn] = useState(true)
  const [tick, setTick] = useState(0)
  const [running, setRunning] = useState(false)
  // Follow-ups typed while the team was busy. Kept in the order they were typed,
  // because that is the order they will run in. Restored ones come back *paused*
  // — see `queuePaused` below.
  const [queue, setQueue] = useState<string[]>(restored.queue)
  const queueRef = useRef(queue)
  queueRef.current = queue
  const [cancelled, setCancelled] = useState(false)
  const [error, setError] = useState<string>()
  const [permissionMode, setPermissionMode] = useState<"auto" | "ask" | "deny">(
    config.permissions?.mode === "auto" || config.defaults?.permissions?.mode === "auto"
      ? "auto"
      : config.permissions?.mode === "deny"
        ? "deny"
        : "ask"
  )
  const [notice, setNotice] = useState<string | undefined>(
    launchNoticeRef.current ?? restored.notice
  )
  const [helpOpen, setHelpOpen] = useState(false)
  // The session picker: a snapshot of the index taken when it opens, so arrow
  // keys and deletes do not re-read the disk on every frame.
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionCursor, setSessionCursor] = useState(0)
  const [sessionList, setSessionList] = useState<SessionMeta[]>([])
  const [menuCursor, setMenuCursor] = useState<{ query: string | undefined; index: number }>({
    query: undefined,
    index: 0,
  })

  const abortRef = useRef<AbortController | null>(null)
  const sessionsRef = useRef<AgentSessionManager | null>(null)
  if (!sessionsRef.current) sessionsRef.current = providedSessions ?? new AgentSessionManager()
  // Armed by session switch (or `--resume <id>` at startup): the next
  // instruction continues that turn's conversations. One-shot — see `startTurn`.
  const continuationRef = useRef<Continuation | null>(null)
  // For `--resume <id>`: open the last turn for context and set up continuation,
  // matching what /sessions → switchSession does for an interactive switch.
  useEffect(() => {
    if (initialSession?.kind !== "resume" || !("id" in initialSession)) return
    const history = restoredRef.current?.history ?? []
    const last = history[history.length - 1]
    if (last) dispatch({ type: "view:open", turn: last.turn })
    const resumable = [...history]
      .reverse()
      .find((turn) => Object.keys(turnSessions(turn)).length > 0)
    continuationRef.current = resumable
      ? { turn: resumable.turn, sessions: turnSessions(resumable) }
      : null
  }, [initialSession])
  const activeTurnRef = useRef<Promise<void> | null>(null)
  const reporterErrorRef = useRef<Error | null>(null)
  const closingRef = useRef(false)
  const shutdownRef = useRef<Promise<void> | null>(null)
  const busyRef = useRef(false)
  const turnSerialRef = useRef(0)
  const [awaitingAnswer, setAwaitingAnswer] = useState(restored.awaitingAnswer)
  // A restored queue starts paused on purpose. The user typed those follow-ups
  // for a turn that then died; starting them the instant the console reopens
  // would run work the user is no longer watching, with no chance to read what
  // the interrupted turn had already done.
  const [queuePaused, setQueuePaused] = useState(restored.queue.length > 0)
  const awaitingAnswerRef = useRef(restored.awaitingAnswer)
  const queuePausedRef = useRef(restored.queue.length > 0)
  const pending = useRef<MultiClawEvent[]>([])
  const permissionSerialRef = useRef(0)
  const questionSerialRef = useRef(0)
  const checkpointResolveRef = useRef<((response: CheckpointResponse) => void) | null>(null)
  const checkpointLabelRef = useRef<string>("")
  const mountedRef = useRef(true)
  const interactionsRef = useRef<PendingInteraction[]>([])
  const [interactions, setInteractions] = useState<PendingInteraction[]>([])
  // Which option the user has pointed at, and whether they have asked for the
  // keyboard back. Keyed by the alias of the request it belongs to, so a new
  // request starts with nothing selected and nothing released — derived rather
  // than reset in an effect, so no frame is ever drawn with the previous
  // request's highlight sitting on the current one.
  const [permissionMenu, setPermissionMenu] = useState<{
    id: string
    cursor: number | undefined
    released: boolean
  }>({ id: "", cursor: undefined, released: false })
  const [formEntry, setFormEntry] = useState<{ id: string; state: FormState }>({
    id: "",
    state: initialForm(),
  })

  const requestPermission = useCallback<RuntimePermissionHandler>((request, signal) => {
    if (closingRef.current || signal.aborted) return Promise.resolve(undefined)
    // Aliases never repeat during this console session, so an old command cannot
    // accidentally decide a later request. Full request ids remain exact matches.
    const shortId = `p${++permissionSerialRef.current}`
    return new Promise<string | undefined>((resolve) => {
      const entry: PendingInteraction = {
        kind: "permission",
        request,
        shortId,
        settle: (optionId) => {
          if (!interactionsRef.current.includes(entry)) return
          signal.removeEventListener("abort", onAbort)
          interactionsRef.current = interactionsRef.current.filter((item) => item !== entry)
          if (mountedRef.current) setInteractions([...interactionsRef.current])
          resolve(optionId)
        },
      }
      const onAbort = () => entry.settle()
      interactionsRef.current.push(entry)
      signal.addEventListener("abort", onAbort, { once: true })
      if (mountedRef.current) setInteractions([...interactionsRef.current])
    })
  }, [])

  const requestQuestion = useCallback<RuntimeQuestionHandler>((request, signal) => {
    if (closingRef.current || signal.aborted) return Promise.resolve({ action: "cancel" })
    const shortId = `q${++questionSerialRef.current}`
    return new Promise<RuntimeQuestionResponse>((resolve) => {
      const entry: PendingInteraction = {
        kind: "question",
        request,
        shortId,
        settle: (response = { action: "cancel" }) => {
          if (!interactionsRef.current.includes(entry)) return
          signal.removeEventListener("abort", onAbort)
          interactionsRef.current = interactionsRef.current.filter((item) => item !== entry)
          if (mountedRef.current) setInteractions([...interactionsRef.current])
          resolve(response)
        },
      }
      const onAbort = () => entry.settle()
      interactionsRef.current.push(entry)
      signal.addEventListener("abort", onAbort, { once: true })
      if (mountedRef.current) setInteractions([...interactionsRef.current])
    })
  }, [])

  const handleCheckpoint = useCallback<CheckpointHandler>((info, signal) => {
    if (closingRef.current || signal.aborted) return Promise.resolve({ action: "cancel" })
    return new Promise<CheckpointResponse>((resolve) => {
      checkpointResolveRef.current = resolve
      checkpointLabelRef.current = info.label
      const names = info.completedAgents.map((a) => a.name).join(", ")
      setNotice(
        `checkpoint: ${info.label} — ${names} done · /continue /modify <instruction> /cancel`
      )
      const onAbort = () => {
        checkpointResolveRef.current = null
        resolve({ action: "cancel" })
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }, [])

  const clearInteractions = useCallback(() => {
    for (const entry of [...interactionsRef.current]) entry.settle()
  }, [])

  const flush = useCallback(() => {
    const batch = pending.current
    if (batch.length === 0) return
    pending.current = []
    for (const event of batch) dispatch({ type: "event", event })
  }, [])

  // One clock drives the spinner and every live duration. It only runs while a
  // turn is in flight — an idle console should not repaint at all.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setTick((value) => value + 1), SPINNER_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [running])

  // The caret blinks only when there is something to indicate: a turn in flight,
  // or text in the prompt. On an idle empty console a blink repaints the whole
  // tree twice a second for a cursor with nothing to point at, so the caret
  // simply stays lit.
  useEffect(() => {
    if (!running && line.text === "") {
      setCaretOn(true)
      return
    }
    const timer = setInterval(() => setCaretOn((on) => !on), BLINK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [running, line.text])

  // Write finished turns back to disk so the next session can pick them up.
  //
  // The deps are the only two fields that can change `recordedTurns`: `turn:start`
  // swaps `history`, and `orchestration:complete` flips `phase` to `complete`.
  // Every other event spreads `state` and leaves both references untouched.
  // Depending on `state` itself would re-run this on every spinner tick (110ms)
  // and `JSON.stringify` a history of up to ~1.6MB each time — a frame-rate bug,
  // not a nicety. The turn on screen is read through the existing `stateRef`, so
  // the effect always sees the current state despite the narrow dep list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads state through `stateRef`, so the linter cannot see that `state.history` and `state.phase` are its real inputs; they are exactly the fields whose change can alter the recorded set, and listing `state` itself would fire on every event.
  useEffect(() => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    const turns = recordedTurns(stateRef.current)
    // Append only turns past the watermark. A single turn fires this effect
    // twice — `turn:start` pushes the previous turn into `history`, then
    // `orchestration:complete` ends it — and on startup it fires for turns
    // already on disk; the watermark makes both of those a no-op.
    const fresh = turns.filter((turn) => turn.turn > persistedTurnRef.current)
    if (fresh.length === 0) return
    persistedTurnRef.current = fresh[fresh.length - 1].turn
    void appendTurns(config.workDir, sessionId, fresh).catch((err: Error) =>
      setNotice(`history not saved: ${err.message}`)
    )
    // Keep the index in step so the picker can list this session without opening
    // its log: the title is the session's first requirement, the count its
    // latest turn number.
    const title = turns.find((turn) => turn.requirement)?.requirement
    touchSession(config.workDir, sessionId, {
      turnCount: fresh[fresh.length - 1].turn,
      ...(title ? { title } : {}),
    })
  }, [state.history, state.phase])

  /**
   * Write the session journal: the turn in flight, the queue, the task boundary.
   *
   * This is the *other* half of crash recovery. `history.json` only ever holds
   * turns that ended, so without this file a process that dies mid-turn takes
   * the requirement the user typed, the follow-ups they queued and the `/task`
   * boundary with it — and the next session cannot even say that a turn was
   * lost. Everything is read through refs so the callback stays stable and can
   * be called from a timer.
   */
  const persistSession = useCallback(() => {
    // Closing is the shutdown path's business: it writes the final journal
    // itself, and a write queued from here would land after it — or, in a test
    // or a `SIGTERM`, after the directory it is writing into is gone.
    if (closingRef.current) return
    const current = stateRef.current
    const waiting = { permissions: 0, questions: 0 }
    for (const entry of interactionsRef.current) {
      if (entry.kind === "permission") waiting.permissions += 1
      else waiting.questions += 1
    }
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    const journal: SessionJournal = {
      version: SESSION_VERSION,
      ...(queueRef.current.length > 0 ? { queue: [...queueRef.current] } : {}),
      // Only a turn that is actually running is in flight. Writing one for an
      // idle console would invent work the next session would then "recover".
      ...(current.phase === "running" && current.requirement !== undefined
        ? { inFlight: journalTurn(current, waiting) }
        : {}),
    }
    void saveJournal(config.workDir, sessionId, journal).catch((err: Error) => {
      if (mountedRef.current) setNotice(`session not saved: ${err.message}`)
    })
  }, [config.workDir])

  // The three transitions that change what a restart would need: a turn starts
  // (`history` and `phase`), a turn ends (`phase`), the queue changes. Read
  // through refs for the same reason the history writer does — depending on
  // `state` would rewrite the journal on every streamed chunk.
  //
  // The mount pass is skipped on purpose. It would only rewrite what was just
  // read, and clearing `inFlight` there would race the write of the restored
  // turn into `history.json`: a crash in that window would drop the interrupted
  // turn from both files. Left alone, the journal keeps claiming it until the
  // next turn starts — and `restoreConsole` drops it as a duplicate once the
  // history holds it.
  const journalSettled = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads the turn through `stateRef`; `state.history` and `state.phase` are listed because they are exactly the fields whose change matters, and `state` itself would fire on every event.
  useEffect(() => {
    if (!journalSettled.current) {
      journalSettled.current = true
      return
    }
    persistSession()
  }, [state.history, state.phase, queue, persistSession])

  // A long turn would otherwise be journaled only at its boundaries, so a crash
  // half an hour in would recover the roster and none of the work.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(persistSession, SESSION_SAVE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [running, persistSession])

  const startTurn = useCallback(
    async (
      requirement: string,
      opts?: { resume?: MultiClawConfig["resume"]; newSession?: boolean }
    ) => {
      if (closingRef.current || busyRef.current) return
      busyRef.current = true
      setRunning(true)
      // Consumed here, whatever happens next: a continuation arms exactly one
      // instruction. `/new` drops it outright — that command exists to start a
      // fresh session, which is the opposite of continuing.
      const continuation = opts?.newSession ? null : continuationRef.current
      continuationRef.current = null
      const resume = opts?.resume ?? continuationResume(continuation, sessionsRef.current)
      if (opts?.newSession) {
        try {
          await sessionsRef.current?.reset()
          if (closingRef.current) {
            busyRef.current = false
            setRunning(false)
            return
          }
          // A new session: the old agents are closed above, a clean record is
          // started, and every write now points at it. The watermark resets
          // with it, and `session:reset` empties the console on screen — the old
          // turns live on in their own session, reachable through the picker.
          const created = createSession(config.workDir)
          sessionIdRef.current = created.id
          persistedTurnRef.current = 0
          dispatch({
            type: "session:reset",
            agents: seedAgents(config),
            leaderIds: leaderAgentIds(config),
          })
        } catch (err) {
          busyRef.current = false
          setRunning(false)
          setError(`session reset failed: ${(err as Error).message}`)
          return
        }
      }
      if (closingRef.current) {
        busyRef.current = false
        setRunning(false)
        return
      }
      awaitingAnswerRef.current = false
      setAwaitingAnswer(false)
      setError(undefined)
      setCancelled(false)
      setNotice(undefined)
      // Read before the dispatch below: `turn:start` moves the turn on screen
      // into `history`, and this wants it as it is right now. A new session has
      // no earlier turns — `session:reset` emptied the history this would read.
      const earlierTurns = opts?.newSession ? [] : conversationTurns(stateRef.current)
      // Each turn starts from the configured roster, so the team list is
      // populated the instant the turn begins rather than after the leader runs.
      dispatch({
        type: "turn:start",
        requirement,
        agents: seedAgents(config),
        leaderIds: leaderAgentIds(config),
        startedAt: Date.now(),
      })

      // Every console turn runs against the *same* workspace, so a follow-up can
      // build on what the previous turn wrote. Only the logs are per-run: the
      // `.multiclaw/runs/` directory is a record of what happened, not the place
      // the work happens.
      const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${++turnSerialRef.current}`
      const logDir = path.join(config.workDir, ".multiclaw", "runs", `run-${stamp}`, "logs")
      const runConfig: MultiClawConfig = {
        ...config,
        context: { ...config.context, requirement },
        // An answer only reads as a requirement next to the question it answers,
        // so the leader is handed the turns behind this one as well.
        history: earlierTurns,
        logDir,
        permissions:
          permissionMode === "ask"
            ? { mode: "ask", onRequest: requestPermission }
            : { mode: permissionMode },
        questions: config.questions?.onRequest ? config.questions : { onRequest: requestQuestion },
        onCheckpoint: config.onCheckpoint ?? handleCheckpoint,
        // A retry names the agents to redo; a continued conversation carries only
        // sessions and still lets the leader route. Both arrive here.
        ...(resume ? { resume } : {}),
      }

      const controller = new AbortController()
      abortRef.current = controller
      setRunning(true)

      let unsubscribe: (() => void) | undefined
      let disposeReporter: (() => void | Promise<void>) | undefined
      const timer = setInterval(flush, FLUSH_INTERVAL_MS)
      let finishTurn!: () => void
      activeTurnRef.current = new Promise<void>((resolve) => {
        finishTurn = resolve
      })
      try {
        const orchestrator = new Orchestrator(runConfig, sessionsRef.current ?? undefined)
        unsubscribe = orchestrator.eventBus.subscribe((event) => {
          pending.current.push(event)
        })
        const reporter = onTurnStart?.(orchestrator.eventBus, logDir)
        if (reporter) disposeReporter = reporter
        const result = await orchestrator.run({ signal: controller.signal })
        const asks = result.reply?.mode === "ask"
        awaitingAnswerRef.current = asks
        setAwaitingAnswer(asks)
        if (asks || !result.success || result.cancelled) {
          queuePausedRef.current = true
          setQueuePaused(true)
        }
        if (result.cancelled) setCancelled(true)
      } catch (err) {
        // Cancellation is expected, not a failure worth surfacing as an error.
        queuePausedRef.current = true
        setQueuePaused(true)
        if (isAbortError(err)) setCancelled(true)
        else setError((err as Error).message)
      } finally {
        clearInteractions()
        clearInterval(timer)
        flush()
        unsubscribe?.()
        try {
          await disposeReporter?.()
        } catch (err) {
          queuePausedRef.current = true
          setQueuePaused(true)
          reporterErrorRef.current = err instanceof Error ? err : new Error(String(err))
          setError(`log cleanup failed: ${reporterErrorRef.current.message}`)
        }
        abortRef.current = null
        busyRef.current = false
        setRunning(false)
        finishTurn()
        activeTurnRef.current = null
      }
    },
    [
      config,
      flush,
      onTurnStart,
      requestPermission,
      requestQuestion,
      handleCheckpoint,
      clearInteractions,
      permissionMode,
    ]
  )

  // A queued follow-up starts the moment the console goes idle again. Without
  // this the queue would just be a place text goes to be forgotten.
  useEffect(() => {
    if (
      running ||
      busyRef.current ||
      closingRef.current ||
      queuePaused ||
      awaitingAnswer ||
      queue.length === 0
    )
      return
    const [next, ...rest] = queue
    setQueue(rest)
    void startTurn(next)
  }, [running, queue, queuePaused, awaitingAnswer, startTurn])

  // Leave the current session for an existing one: close the live agents, load
  // the target's turns and journal, and point every write at it. The newest
  // turn that still carries agent sessions arms a continuation, so the next
  // instruction picks up that conversation rather than starting the team cold —
  // which is the whole point of resuming a session.
  const switchSession = useCallback(
    async (id: string) => {
      if (id === sessionIdRef.current || busyRef.current || closingRef.current) return
      try {
        await sessionsRef.current?.reset()
      } catch (err) {
        setError(`session switch failed: ${(err as Error).message}`)
        return
      }
      if (closingRef.current) return
      const restored = restoreConsole(config.workDir, id)
      sessionIdRef.current = id
      persistedTurnRef.current = restored.persistedTurn
      const resumable = [...restored.history]
        .reverse()
        .find((turn) => Object.keys(turnSessions(turn)).length > 0)
      continuationRef.current = resumable
        ? { turn: resumable.turn, sessions: turnSessions(resumable) }
        : null
      dispatch({
        type: "session:load",
        agents: seedAgents(config),
        leaderIds: leaderAgentIds(config),
        history: restored.history,
      })
      const lastTurn = restored.history[restored.history.length - 1]
      if (lastTurn) {
        dispatch({ type: "view:open", turn: lastTurn.turn })
      }
      setQueue(restored.queue)
      queuePausedRef.current = restored.queue.length > 0
      setQueuePaused(restored.queue.length > 0)
      awaitingAnswerRef.current = restored.awaitingAnswer
      setAwaitingAnswer(restored.awaitingAnswer)
      setError(undefined)
      setCancelled(false)
      setNotice(
        restored.notice ??
          (resumable
            ? `switched session · continue with your next instruction`
            : `switched session · ${restored.history.length} turn${restored.history.length === 1 ? "" : "s"}`)
      )
    },
    [config]
  )

  const cleanup = useCallback(async () => {
    closingRef.current = true
    abortRef.current?.abort()
    clearInteractions()
    await activeTurnRef.current
    await sessionsRef.current?.close()
    // State already queued for disk has to land before the caller can exit (or,
    // in a test, remove the workspace): the finished-turn effect fires as the
    // aborted turn settles and queues its append, so waiting on both of the
    // session's files here catches it.
    const sessionId = sessionIdRef.current
    if (sessionId) {
      await Promise.all([
        pendingWrite(turnsPath(config.workDir, sessionId)),
        pendingWrite(sessionPath(config.workDir, sessionId)),
      ])
    }
    if (reporterErrorRef.current) throw reporterErrorRef.current
  }, [clearInteractions, config.workDir])

  useEffect(() => {
    mountedRef.current = true
    onCleanupReady?.(cleanup)
    return () => {
      mountedRef.current = false
      void cleanup().catch(() => {})
    }
  }, [cleanup, onCleanupReady])

  // `multiclaw -r` (no id) lands on the picker: open it once the first frame is
  // up, with the cursor on the session the console is currently attached to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — the refs and setters it reads are stable, and it must run exactly once.
  useEffect(() => {
    if (!openPickerOnMountRef.current) return
    openPickerOnMountRef.current = false
    const list = listSessions(config.workDir)
    setSessionList(list)
    const current = list.findIndex((session) => session.id === sessionIdRef.current)
    setSessionCursor(current === -1 ? 0 : current)
    setSessionsOpen(true)
  }, [])

  const shutdown = useCallback(() => {
    if (shutdownRef.current) return shutdownRef.current
    closingRef.current = true
    // Captured before the queue is cleared below: those follow-ups were typed by
    // the user and never ran, so the journal keeps them for the next session.
    const leftover = [...queueRef.current]
    queuePausedRef.current = true
    setQueuePaused(true)
    setQueue([])
    setNotice("closing sessions…")
    abortRef.current?.abort()
    shutdownRef.current = (async () => {
      try {
        await cleanup()
        const sessionId = sessionIdRef.current
        if (sessionId) {
          // Append any settled turn the effect had not reached — the just-
          // cancelled in-flight turn, which `recordedTurns` now reports complete.
          // The watermark makes this a no-op when the effect already wrote it.
          const fresh = recordedTurns(stateRef.current).filter(
            (turn) => turn.turn > persistedTurnRef.current
          )
          if (fresh.length) {
            persistedTurnRef.current = fresh[fresh.length - 1].turn
            await appendTurns(config.workDir, sessionId, fresh)
          }
          // A deliberate quit is not an interruption. Whatever turn was in flight
          // ended as a cancellation, and that cancellation is already in the
          // turns above — journaling it as in-flight would greet the next
          // session with "interrupted by a restart" for a stop the user asked for.
          await saveJournal(config.workDir, sessionId, {
            version: SESSION_VERSION,
            ...(leftover.length > 0 ? { queue: leftover } : {}),
          })
        }
        exit()
      } catch (err) {
        setError(`shutdown failed: ${(err as Error).message}`)
      }
    })()
    return shutdownRef.current
  }, [config.workDir, exit, cleanup])

  const query = menuQuery(line.text)
  const matches = useMemo(
    () => (query === undefined ? [] : matchCommands(query, running)),
    [query, running]
  )

  // What the panes are showing: the live turn, or a finished one opened for
  // reading. Everything downstream takes this rather than `state`, so a past
  // turn renders through exactly the same components.
  const shown = state.view ?? state

  // The palette shows one of two lists, never both: the command names while the
  // command is still being typed, or — once a space commits to arguments — the
  // agents a completer command's first argument could name. `menuQuery` closes
  // on a space and `argQuery` opens there, so the two are mutually exclusive.
  const arg = argQuery(line.text)
  const argRows: PaletteRow[] = arg
    ? completeAgents(arg.partial, Object.keys(shown.agents)).map((id) => ({
        key: id,
        label: id,
        // The static role, not the per-turn task title: while completing, the
        // user is asking "which agent is this", not "what is it doing now".
        description: shown.agents[id]?.description ?? shown.agents[id]?.name ?? id,
      }))
    : []
  const allRows: PaletteRow[] = arg ? argRows : paletteRows(matches)
  // One cursor serves both lists; the key it resets on is whichever list is open.
  const paletteKey = arg ? `${arg.command.name} ${arg.partial}` : query
  const paletteTotal = allRows.length
  // A new list is a new highlight, and carrying the old one over would land on a
  // row the user never looked at. Derived rather than reset in an effect, so no
  // frame is ever rendered with a stale index.
  const menuIndex = menuCursor.query === paletteKey ? menuCursor.index : 0
  const selected = paletteTotal === 0 ? 0 : Math.min(menuIndex, paletteTotal - 1)

  // The command palette is allowed mid-run too, which is the only place
  // `/cancel` is offered. Opening it is a deliberate act (the user typed `/`),
  // so spending the arrows on it is fair — scrolling the stream is still one
  // keystroke away.
  const menuOpen = !helpOpen && !sessionsOpen && query !== undefined && matches.length > 0
  // The argument palette opens where the command palette closed, and only when
  // there is something to offer — an empty list is not a palette.
  const argOpen = !helpOpen && !sessionsOpen && arg !== undefined && argRows.length > 0
  const paletteOpen = menuOpen || argOpen

  // The request the console is asking about, and the two pieces of state that
  // belong to it. Both are keyed by the alias so a decision made on one request
  // cannot be read as a decision about the next.
  const front = interactions[0]
  const menu =
    front?.kind === "permission" && permissionMenu.id === front.shortId
      ? permissionMenu
      : { id: front?.shortId ?? "", cursor: 0, released: false }
  const frontQuestion = front?.kind === "question" ? front : undefined
  const questionFields = useMemo(
    () => (frontQuestion ? formFields(frontQuestion.request) : []),
    [frontQuestion]
  )
  const form =
    frontQuestion !== undefined && formEntry.id === frontQuestion.shortId
      ? formEntry.state
      : initialForm()
  // A text field is edited in the prompt, which already owns the caret, the
  // wrapping and the paste handling. The placeholder names the field so the
  // line does not look like it is still taking a follow-up.
  const formField = frontQuestion === undefined ? undefined : questionFields[form.field]
  const editingField =
    formField !== undefined && (formField.kind === "text" || formField.kind === "number")
      ? formField
      : undefined

  // The prompt wraps, so a long input makes it taller than one row — and every
  // row it takes is a row the body cannot have. Measured here, before the
  // layout, for the same reason `railCells` is: Ink cannot be asked how tall a
  // wrapping line will be until it has already laid the screen out.
  const promptRows = promptRowCount(
    line.text,
    line.cursor,
    Math.max(MIN_COLUMNS, columns) - MARKER_WIDTH
  )

  const layout = computeLayout({
    columns,
    rows,
    turn: state.turn,
    overlay: helpOpen || sessionsOpen,
    menuRows: paletteOpen ? paletteTotal : 0,
    queueRows: queue.length,
    interactionRows: interactionRows(interactions, Math.max(MIN_COLUMNS, columns)),
    promptRows,
    notice: notice !== undefined || (queuePaused && queue.length > 0),
    viewing: state.view !== undefined,
    hasRail: shown.leaderIds.length > 0 || shown.stages.length > 0,
    railCells: railCellWidths(shown),
  })

  /**
   * Deliver a mid-turn message to whatever is running right now.
   *
   * The text is never dropped. A steer only works if an agent is between the
   * start and end of a turn at that instant; when none is, the intent ("do this
   * too") survives the turn boundary, so the text becomes a queued follow-up and
   * the notice says the timing changed rather than the request being lost.
   */
  const steerRunningAgents = useCallback(async (text: string) => {
    const manager = sessionsRef.current
    if (!manager) {
      setNotice("no live sessions to steer")
      return
    }
    setNotice("steering…")
    let reports: SupplementReport[]
    try {
      reports = await manager.supplement(text)
    } catch (error) {
      if (mountedRef.current) setNotice(`steering failed: ${(error as Error).message}`)
      return
    }
    if (!mountedRef.current || closingRef.current) return
    const injected = reports.filter((report) => report.status === "injected")
    // Queue only when nothing landed. A partial delivery is not a lost message,
    // and replaying it as the next turn would say everything twice.
    if (injected.length === 0) setQueue((current) => [...current, text])
    for (const report of injected) {
      dispatch({ type: "stream:note", agentId: report.agentId, text: `[steer] ${text}` })
    }
    setNotice(describeSteering(reports))
  }, [])

  const runCommand = useCallback(
    (name: string, args: string[], rawText?: string) => {
      setLine(EMPTY_LINE)
      // The palette only *offers* commands valid for the phase, but a command can
      // also be *typed* out, which bypasses the palette entirely — so the phase
      // rule has to be enforced here too, or a mid-run `/replay` would abort the
      // live turn and start over on top of it. An unknown name is let through so
      // `default:` below still reports it. The notice names the phase the command
      // wants, so the user knows whether to wait or that it does not apply yet.
      // When a checkpoint is waiting, only the checkpoint commands are valid.
      if (
        checkpointResolveRef.current &&
        name !== "continue" &&
        name !== "modify" &&
        name !== "cancel"
      ) {
        setNotice(
          `checkpoint: ${checkpointLabelRef.current} · /continue /modify <instruction> /cancel`
        )
        return
      }
      if (!canRun(name, running)) {
        setNotice(unavailableReason(name, running))
        return
      }
      // Commands act on the turn the panes are showing, not the live one. While a
      // past turn is open, `/clear` clears *its* buffer, so validating and
      // reporting against the live turn would name an agent that did not change.
      const shown = state.view ?? state
      if (closingRef.current) return
      switch (name) {
        case "respond":
        case "skip":
        case "dismiss": {
          const [id, ...jsonParts] = args
          if (!id || (name === "respond" ? jsonParts.length === 0 : args.length !== 1)) {
            setNotice(
              name === "respond"
                ? "usage: /respond <question id> <JSON object>"
                : `usage: /${name} <question id>`
            )
            return
          }
          const matches = interactionsRef.current.filter(
            (entry) => entry.request.requestId === id || entry.shortId === id
          )
          const entry = matches.length === 1 ? matches[0] : undefined
          if (entry?.kind !== "question") {
            setNotice(`unknown or stale question request: ${id}`)
            return
          }
          if (name !== "respond") {
            entry.settle({ action: name === "skip" ? "decline" : "cancel" })
            setNotice(`${name === "skip" ? "skipped" : "dismissed"} ${entry.shortId}`)
            return
          }
          let content: unknown
          try {
            // Preserve whitespace within JSON strings, unlike generic slash args.
            const rawJson = /^\/respond\s+\S+\s+([\s\S]+)$/.exec(rawText ?? "")?.[1] ?? ""
            content = JSON.parse(rawJson)
          } catch {
            setNotice("response must be a valid JSON object")
            return
          }
          if (!validateRuntimeQuestionContent(entry.request.requestedSchema, content)) {
            setNotice(
              "response does not match the question schema; check required fields and choices"
            )
            return
          }
          entry.settle({
            action: "accept",
            content,
          })
          setNotice(`responded to ${entry.shortId}`)
          return
        }
        case "approve":
        case "deny": {
          // The alias is optional. The request on screen is the default target,
          // so `/approve 1` and a bare `/deny` are the shapes the bar itself
          // advertises; naming the id is only how you reach a request behind
          // the one on screen.
          const onScreen = interactionsRef.current[0]
          const byId = (id: string): PendingInteraction | undefined => {
            const found = interactionsRef.current.filter(
              (item) => item.request.requestId === id || item.shortId === id
            )
            if (found.length !== 1) setNotice(`unknown or stale permission request: ${id}`)
            return found.length === 1 ? found[0] : undefined
          }

          let entry: PendingInteraction | undefined
          let number: string | undefined
          if (name === "approve" && args.length === 1 && /^\d+$/.test(args[0])) {
            number = args[0]
            entry = onScreen
          } else if (name === "approve" && args.length === 2) {
            number = args[1]
            entry = byId(args[0])
          } else if (name === "deny" && args.length === 0) {
            entry = onScreen
          } else if (name === "deny" && args.length === 1) {
            entry = byId(args[0])
          } else {
            setNotice(
              name === "approve" ? "usage: /approve [id] <option number>" : "usage: /deny [id]"
            )
            return
          }

          if (entry === undefined) {
            // `byId` has already said why when an id was given; a bare command
            // with nothing on screen has to say so itself.
            if (args.length === 0 || /^\d+$/.test(args[0] ?? "")) {
              setNotice("no permission request on screen")
            }
            return
          }
          if (entry.kind !== "permission") {
            setNotice("the request on screen is a question, not a permission")
            return
          }
          if (name === "deny") {
            entry.settle()
            setNotice(`denied ${entry.shortId}`)
            return
          }
          const option = /^\d+$/.test(number ?? "")
            ? entry.request.options[Number(number) - 1]
            : undefined
          if (!option) {
            setNotice(
              `invalid option for ${entry.shortId}; choose 1–${entry.request.options.length}`
            )
            return
          }
          entry.settle(option.optionId)
          setNotice(`selected ${clean(option.name)} for ${entry.shortId}`)
          return
        }
        case "mode": {
          const m = args[0]
          if (m === "auto" || m === "ask" || m === "deny") {
            setPermissionMode(m)
            setNotice(`permission mode: ${m}`)
          } else {
            setNotice("usage: /mode auto | ask | deny")
          }
          return
        }
        case "new": {
          const text = args.join(" ")
          if (!text) {
            setNotice("usage: /new <requirement> — starts a new session with fresh agent sessions")
            return
          }
          setQueue([])
          queuePausedRef.current = false
          setQueuePaused(false)
          void startTurn(text, { newSession: true })
          return
        }
        case "answer": {
          const text = args.join(" ")
          if (!awaitingAnswerRef.current || !text) {
            setNotice("usage: /answer <text> — only when the leader is waiting for an answer")
            return
          }
          void startTurn(text)
          return
        }
        case "steer": {
          const text = args.join(" ")
          if (!text) {
            setNotice("usage: /steer <text> — delivered to the agents running now")
            return
          }
          void steerRunningAgents(text)
          return
        }
        case "pause":
          queuePausedRef.current = true
          setQueuePaused(true)
          setNotice("queue paused — the active turn continues")
          return
        case "continue": {
          if (checkpointResolveRef.current) {
            const resolve = checkpointResolveRef.current
            checkpointResolveRef.current = null
            checkpointLabelRef.current = ""
            resolve({ action: "continue" })
            setNotice("continuing…")
            return
          }
          if (awaitingAnswerRef.current) {
            setNotice("answer the leader first; queued input is not an answer")
            return
          }
          queuePausedRef.current = false
          setQueuePaused(false)
          setNotice("queue resumed")
          return
        }
        case "modify": {
          const instruction = args.join(" ")
          if (!instruction) {
            setNotice("usage: /modify <instruction> — only at a checkpoint")
            return
          }
          if (!checkpointResolveRef.current) {
            setNotice("no checkpoint is waiting")
            return
          }
          const resolve = checkpointResolveRef.current
          checkpointResolveRef.current = null
          checkpointLabelRef.current = ""
          resolve({ action: "modify", instruction })
          setNotice("modifying and continuing…")
          return
        }
        case "agents":
          setNotice(
            `team: ${plannedAgents(config)
              .map((agent) => agent.id)
              .join(", ")}`
          )
          return
        case "focus": {
          const input = args[0]
          if (!input) {
            setNotice("usage: /focus <agent id>")
            return
          }
          // A unique prefix is accepted, the same way `/retry` does — typing a
          // whole id is a chore, and the two commands have to agree on what an id
          // means or a prefix that works in one would fail in the other.
          const resolved = resolveAgentId(input, Object.keys(shown.agents))
          if ("error" in resolved) {
            setNotice(resolved.error)
            return
          }
          dispatch({ type: "focus:set", agentId: resolved.id })
          setNotice(`focused ${resolved.id}`)
          return
        }
        case "clear":
          if (!shown.focusId) {
            setNotice("nothing focused")
            return
          }
          dispatch({ type: "stream:clear" })
          setNotice(`cleared ${shown.focusId}`)
          return
        case "sessions": {
          // Snapshot the index as the picker opens, cursor on the current one.
          const list = listSessions(config.workDir)
          setSessionList(list)
          const current = list.findIndex((session) => session.id === sessionIdRef.current)
          setSessionCursor(current === -1 ? 0 : current)
          setNotice(undefined)
          setSessionsOpen(true)
          return
        }
        case "verbose":
          // `state.verbose` is the value *before* the toggle, so it names the
          // state the user is about to be in.
          dispatch({ type: "verbose:toggle" })
          setNotice(state.verbose ? "verbose off" : "verbose on — showing tool detail")
          return
        case "retry": {
          // Retrying acts on the *last* turn, not the one being read: a past
          // turn is not what "run that again" can mean.
          if (state.phase !== "complete" || !state.requirement) {
            setNotice("nothing to retry yet")
            return
          }
          // An explicit id accepts a unique prefix, matching `/focus`; with no id
          // the command falls back to every agent that failed.
          let ids: string[]
          if (
            state.acceptance &&
            state.acceptance.status !== "approved" &&
            (!args[0] || args[0] === state.acceptance.reviewer)
          ) {
            ids = [
              ...new Set(state.stages.flatMap((stage) => stage.agents.map((agent) => agent.id))),
            ].filter((id) => id !== state.acceptance?.reviewer)
          } else if (args[0]) {
            const resolved = resolveAgentId(args[0], Object.keys(state.agents))
            if ("error" in resolved) {
              setNotice(resolved.error)
              return
            }
            ids = [resolved.id]
          } else {
            ids = Object.values(state.agents)
              .filter((agent) => agent.status === "failed")
              .map((agent) => agent.id)
          }
          if (ids.length === 0) {
            setNotice("nothing failed")
            return
          }
          // Only agents that reported a session have one to continue; a failed
          // agent has none, so it re-runs from scratch. The map is omitted — not
          // sent empty — when nobody has one, matching the CLI's resume and
          // core's "absent means a cold start".
          const sessions = Object.fromEntries(
            ids
              .filter((id) => state.agents[id]?.sessionId)
              .map((id) => [id, state.agents[id].sessionId as string])
          )
          if (ids.some((id) => state.leaderIds.includes(id))) {
            void startTurn(state.requirement)
            setNotice("retrying leader routing")
            return
          }
          void startTurn(state.effectiveRequirement ?? state.requirement, {
            resume: {
              agents: ids,
              ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
            },
          })
          // Set after `startTurn`, which clears the notice synchronously — the
          // same batching `/replay` works around. A retry re-runs a *different*
          // pipeline from the one that failed: only the failed agents run, an
          // agent keeps its session only when it reported one, and a
          // dependency outside the retry set is dropped along with it. Saying
          // so keeps a second failure from reading as the agent repeating its
          // first mistake.
          setNotice(
            `retrying ${ids.join(", ")} — ${describeResumePlan({
              agents: ids,
              sessions,
              team: config.agents,
            })}`
          )
          return
        }
        case "replay": {
          const target = pickTurn(state, args[0], "nothing to replay yet")
          if ("error" in target) {
            setNotice(target.error)
            return
          }
          // The success notice is set *after* `startTurn`, which begins with a
          // synchronous `setNotice(undefined)`: React batches both into one
          // commit and the last write wins, so a notice placed before the call
          // would be wiped before it ever rendered.
          void startTurn(target.requirement)
          setNotice(`replaying turn ${target.record.turn}`)
          return
        }
        case "fork": {
          const target = pickTurn(state, args[0], "nothing to fork yet")
          if ("error" in target) {
            setNotice(target.error)
            return
          }
          // Branching means growing a new requirement out of an old one, so this
          // only fills the prompt — it does not run. It touches no controller, so
          // it is safe mid-run: the user edits the text and presses enter, which
          // queues it like any other follow-up.
          setLine({ text: target.requirement, cursor: target.requirement.length })
          setNotice(`editing turn ${target.record.turn} — enter to run`)
          return
        }
        case "export": {
          const target = pickRecordedTurn(state, args[0], "nothing to export yet")
          if ("error" in target) {
            setNotice(target.error)
            return
          }
          const file = args[1]
            ? path.resolve(config.workDir, args[1])
            : exportPath(config.workDir, sessionIdRef.current ?? "", target.record.turn)
          void exportTurn(target.record, file)
            .then(() => setNotice(`exported turn ${target.record.turn} to ${file}`))
            .catch((err: Error) => setNotice(`export failed: ${err.message}`))
          return
        }
        case "search": {
          const text = args.join(" ")
          if (!text) {
            setNotice("usage: /search <text>")
            return
          }
          dispatch({
            type: "stream:search",
            query: text,
            viewport: layout.logViewport,
            width: layout.streamWidth,
          })
          setNotice(`searched for ${text}`)
          return
        }
        case "latest":
          dispatch({ type: "stream:latest" })
          setNotice("showing latest output")
          return
        case "cancel": {
          if (checkpointResolveRef.current) {
            const resolve = checkpointResolveRef.current
            checkpointResolveRef.current = null
            checkpointLabelRef.current = ""
            resolve({ action: "cancel" })
            setNotice("checkpoint cancelled")
            return
          }
          if (!abortRef.current) {
            setNotice("nothing to cancel")
            return
          }
          // Cancelling means stop, so the queue goes with it — otherwise the
          // follow-ups would start the instant the abort landed, which reads as
          // "the cancel did not work".
          const dropped = queue.length
          abortRef.current.abort()
          clearInteractions()
          setQueue([])
          setCancelled(true)
          setNotice(dropped > 0 ? `cancelling… · dropped ${dropped} queued` : "cancelling…")
          return
        }
        case "help":
          setNotice(undefined)
          setHelpOpen(true)
          return
        case "quit":
          void shutdown()
          return
        default:
          setNotice(`unknown command: /${name}`)
      }
    },
    [
      config,
      shutdown,
      clearInteractions,
      layout.logViewport,
      layout.streamWidth,
      queue.length,
      running,
      state,
      startTurn,
      steerRunningAgents,
    ]
  )

  const submit = useCallback(() => {
    const text = line.text.trim()
    if (!text || closingRef.current) return
    const command = parseCommand(text)
    if (command) {
      runCommand(command.name, command.args, text)
      return
    }
    // During a checkpoint, bare text is treated as feedback.
    if (checkpointResolveRef.current) {
      runCommand("modify", [text], text)
      return
    }
    setLine(EMPTY_LINE)
    setNotice(undefined)
    // The prompt stays live while the team works, so text typed mid-run becomes
    // the next turn instead of being dropped on the floor.
    if (running || busyRef.current) {
      setQueue((pending) => [...pending, text])
      return
    }
    void startTurn(text)
  }, [line.text, runCommand, running, startTurn])

  // Line edits are expressed as functional updates over one object so a fast
  // typist can never interleave a text change with a stale cursor position.
  const insert = useCallback((chunk: string) => {
    setLine((l) => ({
      text: l.text.slice(0, l.cursor) + chunk + l.text.slice(l.cursor),
      cursor: l.cursor + chunk.length,
    }))
  }, [])

  const backspace = useCallback(() => {
    setLine((l) =>
      l.cursor === 0
        ? l
        : { text: l.text.slice(0, l.cursor - 1) + l.text.slice(l.cursor), cursor: l.cursor - 1 }
    )
  }, [])

  const deleteForward = useCallback(() => {
    setLine((l) =>
      l.cursor >= l.text.length
        ? l
        : { text: l.text.slice(0, l.cursor) + l.text.slice(l.cursor + 1), cursor: l.cursor }
    )
  }, [])

  const move = useCallback((delta: number) => {
    setLine((l) => ({ ...l, cursor: Math.min(Math.max(0, l.cursor + delta), l.text.length) }))
  }, [])

  const moveTo = useCallback((cursor: number) => {
    setLine((l) => ({ ...l, cursor }))
  }, [])

  // The palette draws at most `layout.menuRows` rows, so the window has to
  // follow the selection: `listWindowStart` keeps the highlighted row on screen
  // once the list is longer than the budget (there are more commands than
  // `MAX_MENU_ROWS`). The component is handed `selected - windowStart`, because
  // it only knows the rows it was given.
  const windowStart = listWindowStart(selected, paletteTotal, layout.menuRows)
  const paletteWindow = allRows.slice(windowStart, windowStart + layout.menuRows)
  const paletteSelected = selected - windowStart

  const now = Date.now()
  const spinner = SPINNER[tick % SPINNER.length]

  const handleKey = (char: string, key: Key) => {
    // ctrl+c is the one key that must always do something: it peels the console
    // back one layer at a time instead of quitting from under the user.
    if (key.ctrl && char === "c") {
      if (helpOpen) {
        setHelpOpen(false)
      } else if (sessionsOpen) {
        setSessionsOpen(false)
      } else if (abortRef.current) {
        abortRef.current.abort()
        clearInteractions()
        // Cancel means stop, so the queue is dropped along with the turn —
        // otherwise the follow-ups start the instant the abort lands.
        setNotice(queue.length > 0 ? `cancelling… · dropped ${queue.length} queued` : "cancelling…")
        setQueue([])
        setCancelled(true)
      } else if (line.text) {
        setLine(EMPTY_LINE)
      } else {
        void shutdown()
      }
      return
    }
    // The overlays are modal, so they get the keys first: a `ctrl+l` that
    // cleared the log behind an open help screen, or a `ctrl+d` that quit from
    // inside it, would be a key the overlay claims to swallow but does not.
    if (helpOpen) {
      if (key.escape || char === "?") setHelpOpen(false)
      return
    }

    // The session picker is modal for the same reason the help overlay is.
    if (sessionsOpen) {
      if (key.escape) {
        setSessionsOpen(false)
        return
      }
      if (sessionList.length === 0) return
      const index = Math.min(sessionCursor, sessionList.length - 1)
      if (key.upArrow) {
        setSessionCursor((index - 1 + sessionList.length) % sessionList.length)
        return
      }
      if (key.downArrow) {
        setSessionCursor((index + 1) % sessionList.length)
        return
      }
      if (key.return) {
        const target = sessionList[index]
        setSessionsOpen(false)
        if (target.id === sessionIdRef.current) {
          setNotice("already on this session")
          return
        }
        if (running || busyRef.current) {
          setNotice("finish or cancel the current turn before switching sessions")
          return
        }
        void switchSession(target.id)
        return
      }
      if (char === "d") {
        const target = sessionList[index]
        if (target.id === sessionIdRef.current) {
          setNotice("can't delete the current session")
          return
        }
        deleteSession(config.workDir, target.id)
        const next = listSessions(config.workDir)
        setSessionList(next)
        setSessionCursor(Math.min(index, Math.max(0, next.length - 1)))
        setNotice(`deleted session · ${next.length} left`)
        return
      }
      return
    }

    if (key.ctrl && char === "d") {
      if (!line.text) void shutdown()
      return
    }
    if (key.ctrl && char === "l") {
      dispatch({ type: "stream:clear" })
      setNotice(shown.focusId ? `cleared ${shown.focusId}` : "nothing focused")
      return
    }
    if (key.ctrl && char === "a") {
      moveTo(0)
      return
    }
    if (key.ctrl && char === "e") {
      setLine((l) => ({ ...l, cursor: l.text.length }))
      return
    }

    // A form owns `tab`: moving between its fields is what tab means while one
    // is on screen, and cycling the roster behind it is not something the user
    // can act on while the turn is stopped on their answer. A command line is
    // exempt so `/respond` and `/dismiss` stay reachable.
    const formFront = front?.kind === "question" && !isCommandLine(line.text) ? front : undefined

    if (key.tab && formFront === undefined && !paletteOpen) {
      if (key.shift) {
        // Shift+Tab toggles permission mode (like Claude Code)
        const next = permissionMode === "auto" ? "ask" : "auto"
        setPermissionMode(next)
        setNotice(`permission mode: ${next}`)
        return
      }
      dispatch({ type: "focus:cycle", delta: 1 })
      return
    }

    // While the palette is open the arrows belong to it, not to the stream —
    // the same contract every fuzzy finder uses.
    if (paletteOpen) {
      if (key.tab) {
        // Tab completes the highlighted row into the prompt: a command name for
        // the command palette, or an agent id for the argument palette. A
        // trailing space is appended so the user can keep typing arguments.
        if (arg) {
          const completed = `/${arg.command.name} ${allRows[selected].key} `
          setLine({ text: completed, cursor: completed.length })
        } else {
          const completed = `/${matches[selected].name} `
          setLine({ text: completed, cursor: completed.length })
        }
        return
      }
      if (key.upArrow) {
        setMenuCursor({ query: paletteKey, index: (menuIndex - 1 + paletteTotal) % paletteTotal })
        return
      }
      if (key.downArrow) {
        setMenuCursor({ query: paletteKey, index: (menuIndex + 1) % paletteTotal })
        return
      }
      if (key.escape) {
        setLine(EMPTY_LINE)
        return
      }
      if (key.return) {
        // Enter accepts the highlighted row and runs it, in both panels: a
        // command runs itself, and an agent id completes `/focus <id>`. There is
        // no "accept and keep typing" case, because `/focus` takes one argument.
        if (arg) runCommand(arg.command.name, [allRows[selected].key])
        else runCommand(matches[selected].name, [])
        return
      }
    }

    // An agent blocked on the user owns the bare keys while the prompt is empty.
    // The turn is stopped, so nothing typed here can start and a follow-up would
    // only queue behind a decision that has not been made — the one state where
    // spending the prompt's keys costs nothing. `esc` gives them back, which is
    // what keeps "the prompt always has focus" true rather than merely asserted.
    if (front?.kind === "permission" && line.text === "" && !menu.released) {
      const total = permissionChoices(front.request).length
      if (key.upArrow || key.downArrow) {
        setPermissionMenu({
          id: front.shortId,
          cursor: moveCursor(menu.cursor, key.upArrow ? -1 : 1, total),
          released: false,
        })
        return
      }
      if (/^[1-9]$/.test(char) && !key.ctrl && !key.meta) {
        const cursor = jumpCursor(char, total)
        if (cursor !== undefined) {
          setPermissionMenu({ id: front.shortId, cursor, released: false })
          return
        }
      }
      if (key.return) {
        // Nothing highlighted means nothing to confirm. An `enter` on a fresh
        // request must not be able to grant a tool the user has not read, so the
        // selection is what makes `enter` mean anything.
        const choice =
          menu.cursor === undefined ? undefined : permissionChoices(front.request)[menu.cursor]
        if (choice !== undefined) {
          front.settle(choice.optionId)
          setNotice(`chose ${choice.label} · ${clean(front.request.agentId)}`)
        }
        return
      }
    }

    // The form, meanwhile, always owns `enter`: every field advances through it,
    // including the text ones, whose characters go to the prompt below.
    if (formFront !== undefined) {
      const front = formFront
      const total = questionFields.length
      const field = questionFields[form.field]
      const committed = withDraft(questionFields, form, line.text)
      const save = (state: FormState, draft?: string) => {
        setFormEntry({ id: front.shortId, state })
        if (draft !== undefined) setLine({ text: draft, cursor: draft.length })
      }
      // The state to carry forward is an argument, not the closure's copy: a
      // choice is committed by `advance`, and reading the pre-commit state here
      // would drop exactly the value that was just picked.
      const moveFocus = (index: number, state: FormState = committed) => {
        const next = focusField(questionFields, state, index)
        save(next.state, next.draft)
      }
      const submit = (state: FormState) => {
        if (!formComplete(questionFields, state)) {
          const missing = questionFields.findIndex((item) => !formComplete([item], state))
          if (missing >= 0) {
            setNotice(`${questionFields[missing].title} still needs a value`)
            if (missing !== form.field) moveFocus(missing, state)
          }
          return
        }
        const content = formContent(questionFields, state)
        if (!validateRuntimeQuestionContent(front.request.requestedSchema, content)) {
          setNotice("answer does not match the question schema")
          return
        }
        front.settle({ action: "accept", content })
        setFormEntry({ id: "", state: initialForm() })
        setLine(EMPTY_LINE)
        setNotice(`answered ${front.shortId}`)
      }
      const advance = (state: FormState) => {
        if (form.field >= total - 1) submit(state)
        else moveFocus(form.field + 1, state)
      }

      if (field === undefined) {
        // A schema with no fields is still a question; `enter` answers it.
        if (key.return) submit(committed)
        return
      }
      if (key.tab) {
        moveFocus(key.shift ? form.field - 1 : form.field + 1)
        return
      }
      if (field.choices.length > 0 && (key.upArrow || key.downArrow)) {
        save(movePick(committed, field, key.upArrow ? -1 : 1))
        return
      }
      if (field.choices.length > 0 && (key.leftArrow || key.rightArrow)) {
        save(movePick(committed, field, key.leftArrow ? -1 : 1))
        return
      }
      // No choices to pick from: the vertical keys move between fields instead,
      // which is what they mean on a row that is only text.
      if (key.upArrow || key.downArrow) {
        moveFocus(key.upArrow ? form.field - 1 : form.field + 1)
        return
      }
      if (char === " " && field.kind === "multi") {
        save(toggleChoice(committed, field))
        return
      }
      if (field.kind === "boolean" && (char === " " || key.leftArrow || key.rightArrow)) {
        save(toggleBoolean(committed, field))
        return
      }
      if (field.choices.length > 0 && /^[1-9]$/.test(char) && !key.ctrl && !key.meta) {
        save(jumpPick(committed, field, char))
        return
      }
      if (key.return) {
        advance(field.kind === "choice" ? commitField(questionFields, committed) : committed)
        return
      }
      if (key.escape) {
        // Escape clears the field being edited, not the form: dropping the whole
        // question is `/dismiss`, which is a different decision and says so.
        if (field.kind === "text" || field.kind === "number") {
          save({ ...committed, values: { ...committed.values, [field.key]: "" } })
          setLine(EMPTY_LINE)
        }
        return
      }
      // Everything else is text for the focused field, which the prompt owns.
    }

    // In a single-line input the vertical keys are free, and scrolling the
    // stream is the only thing worth spending them on.
    if (key.upArrow) {
      dispatch({
        type: "stream:scroll",
        delta: 1,
        viewport: layout.logViewport,
        width: layout.streamWidth,
      })
      return
    }
    if (key.downArrow) {
      dispatch({
        type: "stream:scroll",
        delta: -1,
        viewport: layout.logViewport,
        width: layout.streamWidth,
      })
      return
    }
    if (key.pageUp) {
      dispatch({
        type: "stream:scroll",
        delta: layout.logViewport,
        viewport: layout.logViewport,
        width: layout.streamWidth,
      })
      return
    }
    if (key.pageDown) {
      dispatch({
        type: "stream:scroll",
        delta: -layout.logViewport,
        viewport: layout.logViewport,
        width: layout.streamWidth,
      })
      return
    }

    // `?` is a bare key only while the console is idle. Mid-run it has to fall
    // through and be typed, because the user is writing a follow-up.
    if (char === "?" && line.text === "" && !running) {
      setHelpOpen(true)
      return
    }
    if (key.return) {
      submit()
      return
    }
    if (key.leftArrow) {
      move(-1)
      return
    }
    if (key.rightArrow) {
      move(1)
      return
    }
    if (key.home) {
      moveTo(0)
      return
    }
    if (key.end) {
      setLine((l) => ({ ...l, cursor: l.text.length }))
      return
    }
    if (key.escape) {
      // A full-screen error is an overlay like any other, so esc clears it first
      // — the existing semantics (leave a past turn / clear the input line) are
      // unchanged once there is no error to dismiss.
      if (error) {
        setError(undefined)
        return
      }
      // Leaving a past turn comes first: while one is open, that is the thing
      // `esc` is for, and the hint bar says so.
      if (state.view) {
        dispatch({ type: "view:close" })
        return
      }
      // The bar's own escape: hand the keyboard back without deciding anything.
      // The request stays pending, so `/approve` and `/deny` still reach it —
      // and a new request starts unreleased, because the alias is part of the key.
      if (front !== undefined) {
        setPermissionMenu({ id: front.shortId, cursor: undefined, released: true })
      }
      setLine(EMPTY_LINE)
      setNotice(undefined)
      return
    }
    if (key.backspace) {
      backspace()
      return
    }
    if (key.delete) {
      deleteForward()
      return
    }
    // A paste keeps its line structure: a requirement is often a stack trace,
    // and flattening it to one line destroys the thing the leader needs to read.
    // Only the line endings are normalised. The display flattens it for layout
    // instead — see `Prompt`.
    if (char && !key.ctrl && !key.meta) insert(char.replace(/\r\n?/g, "\n"))
  }

  // Held in a ref so the key handler does not have to be re-subscribed on every
  // spinner tick.
  const handlerRef = useRef(handleKey)
  handlerRef.current = handleKey
  useInput((char, key) => handlerRef.current(char, key))

  // The hint bar only advertises keys that do something *right now*. While a
  // reply is on screen there is no roster to switch between, so `tab` is left
  // out rather than promised and silently ignored.
  const keys = helpOpen
    ? "esc close"
    : sessionsOpen
      ? "↑↓ select · enter open · d delete · esc close"
      : argOpen
        ? `↑↓ select · tab complete · enter ${arg?.command.name} · esc close`
        : menuOpen
          ? "↑↓ select · tab complete · enter run · esc close"
          : running
            ? checkpointResolveRef.current
              ? `/continue · /modify <instruction> · /cancel`
              : interactions.length > 0
                ? layout.interactionRows === 0
                  ? // Too short to dock the bar, so the commands are the only way in.
                    "decide with /approve 1 · /deny · /respond"
                  : interactions[0].kind === "question"
                    ? "tab field · ↑↓ pick · enter next · /dismiss"
                    : menu.released
                      ? "/approve 1 and /deny still reach it"
                      : "↑↓ or 1-9 choose · enter confirm · esc to type"
                : "enter queues · ctrl+c cancel"
            : state.view
              ? "esc live · tab agent · ? help"
              : state.reply
                ? "enter sends · / commands · ? help"
                : "tab switch · shift+tab mode · / commands · ? help"

  // The prompt names what it is editing. While a form is up that is a field and
  // not a follow-up — it is the same line either way, so it has to say which.
  // While a permission is pending it says the opposite: typing here is *not* the
  // way to answer, and the default "type to queue a follow-up" invites exactly
  // the action that does nothing.
  const placeholder =
    frontQuestion !== undefined
      ? formField === undefined
        ? "enter to answer"
        : editingField !== undefined
          ? `${editingField.title}${editingField.required ? " *" : ""} — enter for the next field`
          : `${formField.title} — ↑↓ to pick · enter for the next field`
      : front?.kind === "permission" && !menu.released
        ? "choose above · esc to type here instead"
        : checkpointResolveRef.current
          ? `checkpoint: ${checkpointLabelRef.current} — type feedback or /continue`
          : running
            ? RUNNING_PLACEHOLDER
            : awaitingAnswer
              ? "answer the leader… · /task starts a new task"
              : INPUT_PLACEHOLDER

  return (
    <Box flexDirection="column" height={layout.rows}>
      <Header
        name={state.name || config.name}
        // The turn number tracks what the panes are showing, not the live turn:
        // while a past turn is open the body renders it, and a header naming a
        // different turn is a lie about which one is on screen.
        right={
          state.view
            ? `turn ${shown.turn} · viewing`
            : `turn ${shown.turn} · ${
                running
                  ? formatDuration(turnElapsed(state, now) ?? 0)
                  : state.phase === "complete"
                    ? "complete"
                    : "ready"
              } · ${permissionMode}`
        }
      />
      <Rule width={layout.columns} />

      {config.useLeader === false ? (
        <Text color={COLOR.warn} dimColor wrap="truncate-end">
          {"  ⚠ leader off — every message runs the full team"}
        </Text>
      ) : null}

      {layout.showRail ? (
        // The rail wraps, so it can be taller than one row. Cap it at the height
        // the budget reserved and clip, rather than letting the extra rows push
        // the chrome below it off the screen.
        <Box marginTop={1} height={layout.railRows} overflow="hidden" flexShrink={0}>
          <PipelineRail turn={shown} spinner={spinner} />
        </Box>
      ) : null}

      {shown.reason ? (
        <Text dimColor wrap="truncate-end">
          {`  reason: ${shown.reason}`}
        </Text>
      ) : null}

      {/* A column box so the body row stretches to the pane width. Ink's Box
          defaults to `row`, and a row parent sizes its child by content — which
          silently collapses every `space-between` inside the body.

          `overflow="hidden"` is what makes the body a real budget: content that
          does not fit is clipped. Without it Yoga compresses the child instead,
          and text rows fold into each other — a help screen that reads
          "Scroll the stream a pagene" is worse than one that simply stops. */}
      <Box
        marginTop={1}
        height={layout.bodyHeight}
        flexShrink={0}
        flexDirection="column"
        overflow="hidden"
      >
        {helpOpen ? (
          <HelpOverlay width={layout.columns} maxRows={layout.bodyHeight} />
        ) : sessionsOpen ? (
          <SessionsOverlay
            sessions={sessionList}
            selected={Math.min(sessionCursor, Math.max(0, sessionList.length - 1))}
            currentId={sessionIdRef.current ?? undefined}
            width={layout.columns}
            maxRows={layout.bodyHeight}
            now={now}
          />
        ) : layout.welcome ? (
          <WelcomePanel turn={state} width={layout.columns} />
        ) : error ? (
          // The error wins over a reply: a run that stopped with an error is the
          // most urgent thing on screen, and a stale answer underneath it would
          // read as the outcome. The status line keeps a one-line version too.
          <ErrorPanel message={error} width={layout.columns} />
        ) : shown.reply ? (
          <ReplyPanel reply={shown.reply} width={layout.columns} />
        ) : (
          <Box height={layout.bodyHeight} flexShrink={0} flexDirection="row">
            {layout.showTeam ? (
              <>
                <TeamPanel turn={shown} width={layout.teamWidth} now={now} spinner={spinner} />
                <Divider />
              </>
            ) : null}
            <StreamPanel
              turn={shown}
              height={layout.bodyHeight}
              width={layout.streamWidth}
              now={now}
              spinner={spinner}
            />
          </Box>
        )}
      </Box>

      {state.view ? (
        <Text color={COLOR.warn} wrap="truncate-end">
          {`  viewing turn ${shown.turn} · ${shown.requirement ?? "(no requirement)"} · esc to return`}
        </Text>
      ) : null}

      {notice || (queuePaused && queue.length > 0) ? (
        <Text dimColor wrap="truncate-end">
          {"  "}
          {notice ??
            (awaitingAnswer
              ? "queue paused — answer the leader first"
              : "queue paused — /continue resumes it")}
        </Text>
      ) : null}
      <QueueStrip items={queue} max={layout.queueRows} />

      {/* Docked above the prompt rather than replacing the body: an approval is a
          decision *about* the stream, so the stream has to stay on screen. The
          height is the budget's and the bar clips into it, the same contract the
          rail uses — a bar that could grow without limit would push out the
          context it exists to be judged against. */}
      {front === undefined || layout.interactionRows === 0 ? null : (
        <>
          {/* A rule rather than a gap: the bar is docked *below* the stream, and
              without a boundary the two read as one region — the request would
              look like something an agent had printed. It costs the same row the
              gap did. */}
          <Rule width={layout.columns} />
          <Box
            height={layout.interactionRows}
            overflow="hidden"
            flexShrink={0}
            flexDirection="column"
          >
            {front.kind === "permission" ? (
              <PermissionBar
                request={front.request}
                others={interactions
                  .slice(1)
                  .flatMap((entry) => (entry.kind === "permission" ? [entry.request] : []))}
                cursor={menu.cursor}
                released={menu.released}
                width={layout.columns}
              />
            ) : (
              <QuestionForm
                request={front.request}
                others={interactions
                  .slice(1)
                  .flatMap((entry) => (entry.kind === "question" ? [entry.request] : []))}
                fields={questionFields}
                form={form}
                draft={line.text}
                width={layout.columns}
              />
            )}
          </Box>
        </>
      )}

      {paletteOpen ? <CommandMenu rows={paletteWindow} selected={paletteSelected} /> : null}

      <Prompt
        value={line.text}
        cursor={line.cursor}
        caretVisible={caretOn}
        width={layout.columns}
        placeholder={placeholder}
      />

      <HintBar
        status={
          <StatusLine
            state={state}
            running={running}
            cancelled={cancelled}
            error={error}
            now={now}
            spinner={spinner}
            queued={queue.length}
          />
        }
        keys={keys}
      />
    </Box>
  )
}
