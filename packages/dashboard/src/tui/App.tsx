import * as path from "node:path"
import type {
  EventBus,
  MultiClawConfig,
  MultiClawEvent,
  RuntimePermissionHandler,
  RuntimePermissionRequest,
  RuntimeQuestionHandler,
  RuntimeQuestionRequest,
  RuntimeQuestionResponse,
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
import {
  HelpOverlay,
  HistoryOverlay,
  listWindowStart,
  PermissionOverlay,
  QuestionOverlay,
  questionLines,
} from "./components/overlays"
import {
  Divider,
  ErrorPanel,
  ReplyPanel,
  StreamPanel,
  TeamPanel,
  WelcomePanel,
} from "./components/panels"
import { CommandMenu, Prompt } from "./components/prompt"
import { formatCost, formatDuration } from "./format"
import { exportPath, exportTurn, historyPath, saveHistory } from "./history"
import { computeLayout } from "./layout"
import {
  journalTurn,
  restoreConsole,
  SESSION_VERSION,
  type SessionJournal,
  saveJournal,
  sessionPath,
} from "./session"
import {
  conversationTurns,
  createInitialState,
  leaderAgentIds,
  MAX_HISTORY,
  plannedAgents,
  progress,
  recordedTurns,
  seedAgents,
  type TurnView,
  tuiReducer,
  turnElapsed,
} from "./state"
import { COLOR, GLYPH, SPINNER, STATUS } from "./theme"

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

export function App({ config, onTurnStart, sessions: providedSessions, onCleanupReady }: AppProps) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()

  // Open with whatever the last session left on disk. Read once, synchronously,
  // before the first frame: the history list, the interrupted turn the previous
  // process never finished, the follow-ups it never ran, and the task boundary.
  // An async load would race the user's first turn and force an "history still
  // loading" state that nothing else needs.
  const restoredRef = useRef<ReturnType<typeof restoreConsole> | null>(null)
  if (!restoredRef.current) restoredRef.current = restoreConsole(config.workDir)
  const restored = restoredRef.current

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
  const [notice, setNotice] = useState<string | undefined>(restored.notice)
  const [helpOpen, setHelpOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyCursor, setHistoryCursor] = useState(0)
  const [menuCursor, setMenuCursor] = useState<{ query: string | undefined; index: number }>({
    query: undefined,
    index: 0,
  })

  const abortRef = useRef<AbortController | null>(null)
  const sessionsRef = useRef<AgentSessionManager | null>(null)
  if (!sessionsRef.current) sessionsRef.current = providedSessions ?? new AgentSessionManager()
  const activeTurnRef = useRef<Promise<void> | null>(null)
  const reporterErrorRef = useRef<Error | null>(null)
  const closingRef = useRef(false)
  const shutdownRef = useRef<Promise<void> | null>(null)
  const busyRef = useRef(false)
  // The `/task` boundary, restored from the journal: turns numbered after it
  // belong to the current task, and the ones before it are closed.
  const taskStartRef = useRef(restored.taskStart)
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
  const mountedRef = useRef(true)
  const interactionsRef = useRef<PendingInteraction[]>([])
  const [interactions, setInteractions] = useState<PendingInteraction[]>([])
  const [questionScroll, setQuestionScroll] = useState({ id: "", offset: 0 })

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
  const lastSaved = useRef<string | undefined>(undefined)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads state through `stateRef`, so the linter cannot see that `state.history` and `state.phase` are its real inputs; they are exactly the fields whose change can alter the recorded set, and listing `state` itself would re-stringify the whole history on every event.
  useEffect(() => {
    const turns = recordedTurns(stateRef.current).slice(-MAX_HISTORY)
    // A workspace that never ran a turn should not sprout an empty file.
    if (turns.length === 0) return
    const json = JSON.stringify(turns)
    // A single turn fires this effect twice: once when `turn:start` pushes the
    // previous turn into `history`, and again when `orchestration:complete` ends
    // it. On the first pass the new turn is still `running` and so is not yet in
    // `recordedTurns`; the two payloads are byte-identical and the second write
    // is skipped. On startup the first pass rewrites exactly what was just read
    // (`lastSaved` starts undefined) — one bounded write, accepted.
    if (json === lastSaved.current) return
    lastSaved.current = json
    void saveHistory(config.workDir, turns).catch((err: Error) =>
      setNotice(`history not saved: ${err.message}`)
    )
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
    const journal: SessionJournal = {
      version: SESSION_VERSION,
      taskStart: taskStartRef.current,
      ...(queueRef.current.length > 0 ? { queue: [...queueRef.current] } : {}),
      // Only a turn that is actually running is in flight. Writing one for an
      // idle console would invent work the next session would then "recover".
      ...(current.phase === "running" && current.requirement !== undefined
        ? { inFlight: journalTurn(current, waiting) }
        : {}),
    }
    void saveJournal(config.workDir, journal).catch((err: Error) => {
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
      opts?: { resume?: MultiClawConfig["resume"]; newTask?: boolean }
    ) => {
      if (closingRef.current || busyRef.current) return
      busyRef.current = true
      setRunning(true)
      if (opts?.newTask) {
        try {
          await sessionsRef.current?.reset()
          if (closingRef.current) {
            busyRef.current = false
            setRunning(false)
            return
          }
          taskStartRef.current = stateRef.current.turn
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
      // into `history`, and this wants it as it is right now.
      const earlierTurns = conversationTurns({
        ...stateRef.current,
        history: stateRef.current.history.filter((turn) => turn.turn > taskStartRef.current),
        ...(stateRef.current.turn <= taskStartRef.current ? { phase: "idle" as const } : {}),
      })
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
          !config.permissions || config.permissions.mode === "ask"
            ? { mode: "ask", onRequest: requestPermission }
            : config.permissions,
        questions: config.questions?.onRequest ? config.questions : { onRequest: requestQuestion },
        // Only a retry carries this; a normal turn lets the leader route.
        ...(opts?.resume ? { resume: opts.resume } : {}),
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
    [config, flush, onTurnStart, requestPermission, requestQuestion, clearInteractions]
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

  const cleanup = useCallback(async () => {
    closingRef.current = true
    abortRef.current?.abort()
    clearInteractions()
    await activeTurnRef.current
    await sessionsRef.current?.close()
    // State already queued for disk has to land before the caller can exit (or,
    // in a test, remove the workspace). No new write can be queued after
    // `closingRef`, so this is the whole set.
    await Promise.all([
      pendingWrite(historyPath(config.workDir)),
      pendingWrite(sessionPath(config.workDir)),
    ])
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
        const turns = recordedTurns(stateRef.current).slice(-MAX_HISTORY)
        if (turns.length) await saveHistory(config.workDir, turns)
        // A deliberate quit is not an interruption. Whatever turn was in flight
        // ended as a cancellation, and that cancellation is already in the
        // history above — journaling it as in-flight would greet the next
        // session with "interrupted by a restart" for a stop the user asked for.
        await saveJournal(config.workDir, {
          version: SESSION_VERSION,
          taskStart: taskStartRef.current,
          ...(leftover.length > 0 ? { queue: leftover } : {}),
        })
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

  // Newest first: "what did I just ask" is the question a history list answers.
  const historyTurns = useMemo(() => [...state.history].reverse(), [state.history])
  const historyIndex =
    historyTurns.length === 0 ? 0 : Math.min(historyCursor, historyTurns.length - 1)

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
  const menuOpen = !helpOpen && !historyOpen && query !== undefined && matches.length > 0
  // The argument palette opens where the command palette closed, and only when
  // there is something to offer — an empty list is not a palette.
  const argOpen = !helpOpen && !historyOpen && arg !== undefined && argRows.length > 0
  const paletteOpen = menuOpen || argOpen

  const layout = computeLayout({
    columns,
    rows,
    turn: state.turn,
    overlay: helpOpen || historyOpen,
    menuRows: paletteOpen ? paletteTotal : 0,
    queueRows: queue.length,
    notice: notice !== undefined || (queuePaused && queue.length > 0),
    viewing: state.view !== undefined,
    hasRail: shown.leaderIds.length > 0 || shown.stages.length > 0,
    railCells: railCellWidths(shown),
  })

  const runCommand = useCallback(
    (name: string, args: string[], rawText?: string) => {
      setLine(EMPTY_LINE)
      // The palette only *offers* commands valid for the phase, but a command can
      // also be *typed* out, which bypasses the palette entirely — so the phase
      // rule has to be enforced here too, or a mid-run `/replay` would abort the
      // live turn and start over on top of it. An unknown name is let through so
      // `default:` below still reports it. The notice names the phase the command
      // wants, so the user knows whether to wait or that it does not apply yet.
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
          const [id, number] = args
          if (!id || (name === "approve" ? args.length !== 2 : args.length !== 1)) {
            setNotice(
              name === "approve"
                ? "usage: /approve <request id> <option number>"
                : "usage: /deny <request id>"
            )
            return
          }
          const matches = interactionsRef.current.filter(
            (entry) => entry.request.requestId === id || entry.shortId === id
          )
          if (matches.length !== 1) {
            setNotice(`unknown or stale permission request: ${id}`)
            return
          }
          const entry = matches[0]
          if (entry.kind !== "permission") {
            setNotice(`not a permission request: ${id}`)
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
          setNotice(`selected ${option.name} for ${entry.shortId}`)
          return
        }
        case "task": {
          const text = args.join(" ")
          if (!text) {
            setNotice("usage: /task <new requirement> — closes prior agent sessions")
            return
          }
          setQueue([])
          queuePausedRef.current = false
          setQueuePaused(false)
          void startTurn(text, { newTask: true })
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
        case "pause":
          queuePausedRef.current = true
          setQueuePaused(true)
          setNotice("queue paused — the active turn continues")
          return
        case "continue":
          if (awaitingAnswerRef.current) {
            setNotice("answer the leader first; queued input is not an answer")
            return
          }
          queuePausedRef.current = false
          setQueuePaused(false)
          setNotice("queue resumed")
          return
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
        case "history":
          if (state.history.length === 0) {
            setNotice("no earlier turns yet")
            return
          }
          setNotice(undefined)
          setHistoryCursor(0)
          setHistoryOpen(true)
          return
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
            : exportPath(config.workDir, target.record.turn)
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
      } else if (historyOpen) {
        setHistoryOpen(false)
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

    // The history list is modal, so it swallows everything it does not use —
    // otherwise an arrow would scroll the pane behind it.
    if (historyOpen) {
      if (key.escape) {
        setHistoryOpen(false)
        return
      }
      if (historyTurns.length === 0) return
      if (key.upArrow) {
        setHistoryCursor((historyIndex - 1 + historyTurns.length) % historyTurns.length)
        return
      }
      if (key.downArrow) {
        setHistoryCursor((historyIndex + 1) % historyTurns.length)
        return
      }
      if (key.return) {
        dispatch({ type: "view:open", turn: historyTurns[historyIndex].turn })
        setHistoryOpen(false)
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

    if (key.tab) {
      dispatch({ type: "focus:cycle", delta: key.shift ? -1 : 1 })
      return
    }

    // While the palette is open the arrows belong to it, not to the stream —
    // the same contract every fuzzy finder uses.
    if (paletteOpen) {
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

    if (
      interactions[0]?.kind === "question" &&
      (key.upArrow || key.downArrow || key.pageUp || key.pageDown)
    ) {
      const entry = interactions[0]
      const capacity = Math.max(1, layout.bodyHeight - 4)
      const maxOffset = Math.max(0, questionLines(entry.request, layout.columns).length - capacity)
      const delta = key.pageDown ? capacity : key.pageUp ? -capacity : key.downArrow ? 1 : -1
      setQuestionScroll((scroll) => ({
        id: entry.shortId,
        offset: Math.min(
          maxOffset,
          Math.max(0, (scroll.id === entry.shortId ? scroll.offset : 0) + delta)
        ),
      }))
      return
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
    : historyOpen
      ? "↑↓ select · enter open · esc close"
      : argOpen
        ? `↑↓ select · enter ${arg?.command.name} · esc close`
        : menuOpen
          ? "↑↓ select · enter run · esc close"
          : running
            ? interactions.length > 0
              ? interactions[0].kind === "question"
                ? "/respond <id> <JSON> · /skip <id> · /dismiss <id>"
                : "/approve <id> <number> · /deny <id> · ctrl+c cancel"
              : "enter queues · ctrl+c cancel"
            : state.view
              ? "esc live · tab agent · ? help"
              : state.reply
                ? "enter sends · / commands · ? help"
                : "tab switch · / commands · ? help"

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
              }`
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
        ) : historyOpen ? (
          <HistoryOverlay
            turns={historyTurns}
            selected={historyIndex}
            width={layout.columns}
            maxRows={layout.bodyHeight}
          />
        ) : interactions[0]?.kind === "question" ? (
          <QuestionOverlay
            request={interactions[0].request}
            shortId={interactions[0].shortId}
            queued={interactions.length}
            width={layout.columns}
            maxRows={layout.bodyHeight}
            offset={questionScroll.id === interactions[0].shortId ? questionScroll.offset : 0}
          />
        ) : interactions[0]?.kind === "permission" ? (
          <PermissionOverlay
            request={interactions[0].request}
            shortId={interactions[0].shortId}
            queued={interactions.length}
            width={layout.columns}
            maxRows={layout.bodyHeight}
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

      {paletteOpen ? <CommandMenu rows={paletteWindow} selected={paletteSelected} /> : null}

      <Prompt
        value={line.text}
        cursor={line.cursor}
        caretVisible={caretOn}
        placeholder={
          running
            ? RUNNING_PLACEHOLDER
            : awaitingAnswer
              ? "answer the leader… · /task starts a new task"
              : INPUT_PLACEHOLDER
        }
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
