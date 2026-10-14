import * as path from "node:path"
import type { EventBus, MultiClawConfig, MultiClawEvent } from "@multiclawcli/core"
import { isAbortError, Orchestrator } from "@multiclawcli/core"
import { Box, type Key, Text, useApp, useInput, useWindowSize } from "ink"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { matchCommands, menuQuery, parseCommand } from "./commands"
import {
  Header,
  HintBar,
  PipelineRail,
  QueueStrip,
  Rule,
  railCellWidths,
} from "./components/chrome"
import { HelpOverlay, HistoryOverlay } from "./components/overlays"
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
import { computeLayout } from "./layout"
import {
  conversationTurns,
  createInitialState,
  leaderAgentIds,
  plannedAgents,
  progress,
  seedAgents,
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
  onTurnStart?: (eventBus: EventBus, logDir: string) => void
}

/** Agents emit output in many small chunks; batching keeps re-renders bounded. */
const FLUSH_INTERVAL_MS = 80

/** Spinner cadence. Also drives every live clock, so it must stay well under a second. */
const SPINNER_INTERVAL_MS = 110

/** Standard terminal cursor blink period, in milliseconds. */
const BLINK_INTERVAL_MS = 530

const INPUT_PLACEHOLDER = "describe what the team should do…"
const RUNNING_PLACEHOLDER = "type to queue a follow-up…"

interface Line {
  text: string
  cursor: number
}

const EMPTY_LINE: Line = { text: "", cursor: 0 }

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
  if (cancelled && !running) return <Text color={COLOR.warn}>cancelled</Text>

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
    const outcome = state.success
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

export function App({ config, onTurnStart }: AppProps) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()

  const [state, dispatch] = useReducer(tuiReducer, config, createInitialState)
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
  // because that is the order they will run in.
  const [queue, setQueue] = useState<string[]>([])
  const [cancelled, setCancelled] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [helpOpen, setHelpOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyCursor, setHistoryCursor] = useState(0)
  const [menuCursor, setMenuCursor] = useState<{ query: string | undefined; index: number }>({
    query: undefined,
    index: 0,
  })

  const abortRef = useRef<AbortController | null>(null)
  const pending = useRef<MultiClawEvent[]>([])

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

  const startTurn = useCallback(
    async (requirement: string, opts?: { resume?: MultiClawConfig["resume"] }) => {
      setError(undefined)
      setCancelled(false)
      setNotice(undefined)
      // Read before the dispatch below: `turn:start` moves the turn on screen
      // into `history`, and this wants it as it is right now.
      const earlierTurns = conversationTurns(stateRef.current)
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
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const logDir = path.join(config.workDir, ".multiclaw", "runs", `run-${stamp}`, "logs")
      const runConfig: MultiClawConfig = {
        ...config,
        context: { ...config.context, requirement },
        // An answer only reads as a requirement next to the question it answers,
        // so the leader is handed the turns behind this one as well.
        history: earlierTurns,
        logDir,
        // Only a retry carries this; a normal turn lets the leader route.
        ...(opts?.resume ? { resume: opts.resume } : {}),
      }

      const controller = new AbortController()
      abortRef.current = controller
      setRunning(true)

      const orchestrator = new Orchestrator(runConfig)
      const unsubscribe = orchestrator.eventBus.subscribe((event) => {
        pending.current.push(event)
      })
      onTurnStart?.(orchestrator.eventBus, logDir)

      const timer = setInterval(flush, FLUSH_INTERVAL_MS)
      try {
        await orchestrator.run({ signal: controller.signal })
      } catch (err) {
        // Cancellation is expected, not a failure worth surfacing as an error.
        if (isAbortError(err)) setCancelled(true)
        else setError((err as Error).message)
      } finally {
        clearInterval(timer)
        flush()
        unsubscribe()
        abortRef.current = null
        setRunning(false)
      }
    },
    [config, flush, onTurnStart]
  )

  // A queued follow-up starts the moment the console goes idle again. Without
  // this the queue would just be a place text goes to be forgotten.
  useEffect(() => {
    if (running || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    void startTurn(next)
  }, [running, queue, startTurn])

  const runCommand = useCallback(
    (name: string, args: string[]) => {
      setLine(EMPTY_LINE)
      // Commands act on the turn the panes are showing, not the live one. While a
      // past turn is open, `/clear` clears *its* buffer, so validating and
      // reporting against the live turn would name an agent that did not change.
      const shown = state.view ?? state
      switch (name) {
        case "agents":
          setNotice(
            `team: ${plannedAgents(config)
              .map((agent) => agent.id)
              .join(", ")}`
          )
          return
        case "focus": {
          const id = args[0]
          if (!id) {
            setNotice("usage: /focus <agent id>")
            return
          }
          if (!shown.agents[id]) {
            setNotice(`unknown agent: ${id}`)
            return
          }
          dispatch({ type: "focus:set", agentId: id })
          setNotice(`focused ${id}`)
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
          const ids = args[0]
            ? [args[0]]
            : Object.values(state.agents)
                .filter((agent) => agent.status === "failed")
                .map((agent) => agent.id)
          if (ids.length === 0) {
            setNotice("nothing failed")
            return
          }
          const unknown = ids.filter((id) => !state.agents[id])
          if (unknown.length > 0) {
            setNotice(`unknown agent: ${unknown[0]}`)
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
          void startTurn(state.requirement, {
            resume: {
              agents: ids,
              ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
            },
          })
          return
        }
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
          exit()
          return
        default:
          setNotice(`unknown command: /${name}`)
      }
    },
    [config, exit, queue.length, state, startTurn]
  )

  const submit = useCallback(() => {
    const text = line.text.trim()
    if (!text) return
    const command = parseCommand(text)
    if (command) {
      runCommand(command.name, command.args)
      return
    }
    setLine(EMPTY_LINE)
    setNotice(undefined)
    // The prompt stays live while the team works, so text typed mid-run becomes
    // the next turn instead of being dropped on the floor.
    if (running) {
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

  const query = menuQuery(line.text)
  const matches = useMemo(
    () => (query === undefined ? [] : matchCommands(query, running)),
    [query, running]
  )
  // A new query is a new list, and carrying the old highlight over would land on
  // a command the user never looked at. Derived rather than reset in an effect,
  // so no frame is ever rendered with a stale index.
  const menuIndex = menuCursor.query === query ? menuCursor.index : 0
  const selected = matches.length === 0 ? 0 : Math.min(menuIndex, matches.length - 1)

  // The palette is allowed mid-run too, which is the only place `/cancel` is
  // offered. Opening it is a deliberate act (the user typed `/`), so spending the
  // arrows on it is fair — scrolling the stream is still one keystroke away.
  const menuOpen = !helpOpen && !historyOpen && query !== undefined && matches.length > 0

  // Newest first: "what did I just ask" is the question a history list answers.
  const historyTurns = useMemo(() => [...state.history].reverse(), [state.history])
  const historyIndex =
    historyTurns.length === 0 ? 0 : Math.min(historyCursor, historyTurns.length - 1)

  // What the panes are showing: the live turn, or a finished one opened for
  // reading. Everything downstream takes this rather than `state`, so a past
  // turn renders through exactly the same components.
  const shown = state.view ?? state

  const layout = computeLayout({
    columns,
    rows,
    turn: state.turn,
    overlay: helpOpen || historyOpen,
    menuRows: menuOpen ? matches.length : 0,
    queueRows: queue.length,
    notice: notice !== undefined,
    viewing: state.view !== undefined,
    hasRail: shown.leaderIds.length > 0 || shown.stages.length > 0,
    railCells: railCellWidths(shown),
  })

  // The palette renders at most `layout.menuRows` entries, so the highlight has
  // to be clamped to the same window. `selected` is bounded by the full match
  // list, which today is exactly as long as the window — but a longer list would
  // otherwise highlight a row that was never drawn.
  const menuWindow = matches.slice(0, layout.menuRows)
  const menuSelected = Math.min(selected, Math.max(0, menuWindow.length - 1))

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
        // Cancel means stop, so the queue is dropped along with the turn —
        // otherwise the follow-ups start the instant the abort lands.
        setNotice(queue.length > 0 ? `cancelling… · dropped ${queue.length} queued` : "cancelling…")
        setQueue([])
        setCancelled(true)
      } else if (line.text) {
        setLine(EMPTY_LINE)
      } else {
        exit()
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
      if (!line.text) exit()
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
    if (menuOpen) {
      if (key.upArrow) {
        setMenuCursor({ query, index: (menuIndex - 1 + matches.length) % matches.length })
        return
      }
      if (key.downArrow) {
        setMenuCursor({ query, index: (menuIndex + 1) % matches.length })
        return
      }
      if (key.escape) {
        setLine(EMPTY_LINE)
        return
      }
      if (key.return) {
        runCommand(matches[selected].name, [])
        return
      }
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
      : menuOpen
        ? "↑↓ select · enter run · esc close"
        : running
          ? "enter queues · ctrl+c cancel"
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

      {notice ? (
        <Text dimColor wrap="truncate-end">
          {"  "}
          {notice}
        </Text>
      ) : null}

      <QueueStrip items={queue} max={layout.queueRows} />

      {menuOpen ? <CommandMenu commands={menuWindow} selected={menuSelected} /> : null}

      <Prompt
        value={line.text}
        cursor={line.cursor}
        caretVisible={caretOn}
        placeholder={running ? RUNNING_PLACEHOLDER : INPUT_PLACEHOLDER}
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
