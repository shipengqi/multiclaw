import * as path from "node:path"
import type { EventBus, MultiClawConfig, MultiClawEvent } from "@multiclawcli/core"
import { isAbortError, Orchestrator } from "@multiclawcli/core"
import { Box, type Key, Text, useApp, useInput, useWindowSize } from "ink"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { matchCommands, menuQuery, parseCommand } from "./commands"
import { Header, HintBar, PipelineRail, QueueStrip, Rule } from "./components/chrome"
import { HelpOverlay, HistoryOverlay } from "./components/overlays"
import { Divider, ReplyPanel, StreamPanel, TeamPanel, WelcomePanel } from "./components/panels"
import { CommandMenu, Prompt } from "./components/prompt"
import { formatDuration } from "./format"
import { computeLayout } from "./layout"
import {
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
  if (state.warning)
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
    return state.success ? (
      <Text color={COLOR.ok} wrap="truncate-end">
        {STATUS.success.glyph} done{time}
      </Text>
    ) : (
      <Text color={COLOR.error} wrap="truncate-end">
        {STATUS.failed.glyph} finished with failures{time}
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

  // The caret blinks whenever the prompt accepts input — which is always, now
  // that a running turn no longer disables it.
  useEffect(() => {
    setCaretOn(true)
    const timer = setInterval(() => setCaretOn((on) => !on), BLINK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const startTurn = useCallback(
    async (requirement: string) => {
      setError(undefined)
      setCancelled(false)
      setNotice(undefined)
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
        logDir,
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
          if (!state.agents[id]) {
            setNotice(`unknown agent: ${id}`)
            return
          }
          dispatch({ type: "focus:set", agentId: id })
          setNotice(`focused ${id}`)
          return
        }
        case "clear":
          if (!state.focusId) {
            setNotice("nothing focused")
            return
          }
          dispatch({ type: "stream:clear" })
          setNotice(`cleared ${state.focusId}`)
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
    [config, exit, queue.length, state.agents, state.focusId, state.history.length]
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
  })

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
    if (key.ctrl && char === "d") {
      if (!line.text) exit()
      return
    }
    if (key.ctrl && char === "l") {
      dispatch({ type: "stream:clear" })
      setNotice(state.focusId ? `cleared ${state.focusId}` : "nothing focused")
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
      dispatch({ type: "stream:scroll", delta: 1, viewport: layout.logViewport })
      return
    }
    if (key.downArrow) {
      dispatch({ type: "stream:scroll", delta: -1, viewport: layout.logViewport })
      return
    }
    if (key.pageUp) {
      dispatch({ type: "stream:scroll", delta: layout.logViewport, viewport: layout.logViewport })
      return
    }
    if (key.pageDown) {
      dispatch({ type: "stream:scroll", delta: -layout.logViewport, viewport: layout.logViewport })
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
    // A paste arrives as one multi-character chunk; collapse it to a single line.
    if (char && !key.ctrl && !key.meta) insert(char.replace(/[\r\n]+/g, " "))
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
        right={`turn ${state.turn} · ${running ? formatDuration(turnElapsed(state, now) ?? 0) : state.phase === "complete" ? "complete" : "ready"}`}
      />
      <Rule width={layout.columns} />

      {layout.showRail ? (
        <Box marginTop={1}>
          <PipelineRail turn={shown} spinner={spinner} />
        </Box>
      ) : null}

      {/* A column box so the body row stretches to the pane width. Ink's Box
          defaults to `row`, and a row parent sizes its child by content — which
          silently collapses every `space-between` inside the body. */}
      <Box marginTop={1} height={layout.bodyHeight} flexShrink={1} flexDirection="column">
        {helpOpen ? (
          <HelpOverlay width={layout.columns} />
        ) : historyOpen ? (
          <HistoryOverlay turns={historyTurns} selected={historyIndex} width={layout.columns} />
        ) : layout.welcome ? (
          <WelcomePanel turn={state} width={layout.columns} />
        ) : shown.reply ? (
          <ReplyPanel reply={shown.reply} width={layout.columns} />
        ) : (
          <Box height={layout.bodyHeight} flexDirection="row">
            {layout.showTeam ? (
              <>
                <TeamPanel turn={shown} width={layout.teamWidth} now={now} spinner={spinner} />
                <Divider />
              </>
            ) : null}
            <StreamPanel turn={shown} height={layout.bodyHeight} now={now} spinner={spinner} />
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

      {menuOpen ? (
        <CommandMenu commands={matches.slice(0, layout.menuRows)} selected={selected} />
      ) : null}

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
