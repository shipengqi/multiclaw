import type {
  AgentDefinition,
  AgentResult,
  LeaderMessage,
  MultiClawConfig,
  MultiClawEvent,
  StageInfo,
} from "@multiclawcli/core"
import { describe, expect, it } from "vitest"
import {
  type AgentView,
  agentElapsed,
  appendLog,
  conversationTurns,
  createInitialState,
  initialState,
  leaderAgentIds,
  MAX_HISTORY,
  MAX_LOG_CHARS,
  progress,
  recordedTurns,
  reduceEvent,
  seedAgents,
  stageStatus,
  stripAnsi,
  type TuiState,
  type TurnView,
  tuiReducer,
  turnElapsed,
  visibleLog,
} from "./state"

const TS = "2026-01-01T00:00:00.000Z"
const T0 = Date.parse(TS)

/**
 * Pane width for the window tests. Wide enough that the one-character log lines
 * they build stay one row each, so those cases read the same as they did when
 * the window counted lines — the wrapping behaviour has its own cases below.
 */
const WIDTH = 80

function agent(id: string, patch: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id, name: id, systemPrompt: "", taskPrompt: "", ...patch }
}

function config(patch: Partial<MultiClawConfig> = {}): MultiClawConfig {
  return {
    name: "demo",
    workDir: "/tmp/demo",
    leader: agent("leader"),
    agents: [agent("architect"), agent("dev")],
    ...patch,
  }
}

function stage(stageIndex: number, ids: string[]): StageInfo {
  return { stageIndex, agents: ids.map((id) => ({ id, name: id })) }
}

function started(agentId: string, patch: Record<string, unknown> = {}): MultiClawEvent {
  return {
    type: "agent:start",
    timestamp: TS,
    payload: { agentId, agentName: agentId, ...patch },
  }
}

function result(agentId: string, patch: Partial<AgentResult> = {}): AgentResult {
  return {
    agentId,
    agentName: agentId,
    status: "success",
    output: "",
    duration: 1234,
    attempts: 1,
    startTime: TS,
    endTime: TS,
    ...patch,
  }
}

function output(agentId: string, chunk: string): MultiClawEvent {
  return { type: "agent:output", timestamp: TS, payload: { agentId, chunk } }
}

function withAgents(...ids: string[]) {
  return ids.reduce(
    (state, id) => reduceEvent(state, started(id)),
    reduceEvent(initialState, {
      type: "orchestration:start",
      timestamp: TS,
      payload: { name: "demo", totalAgents: ids.length, stages: [stage(0, ids)] },
    })
  )
}

describe("stripAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m plain")).toBe("red plain")
  })

  it("leaves plain text untouched", () => {
    expect(stripAnsi("no codes here")).toBe("no codes here")
  })
})

describe("appendLog", () => {
  it("appends and strips ANSI", () => {
    expect(appendLog("a", "\x1b[32mb\x1b[0m")).toBe("ab")
  })

  it("keeps only the tail once the cap is exceeded", () => {
    const previous = "x".repeat(MAX_LOG_CHARS)
    const next = appendLog(previous, "TAIL")
    expect(next).toHaveLength(MAX_LOG_CHARS)
    expect(next.endsWith("TAIL")).toBe(true)
  })

  it("does not truncate below the cap", () => {
    expect(appendLog("abc", "def")).toBe("abcdef")
  })
})

describe("reduceEvent", () => {
  it("starts an orchestration with pending agents", () => {
    const state = reduceEvent(initialState, {
      type: "orchestration:start",
      timestamp: TS,
      payload: {
        name: "demo",
        requirement: "build it",
        selectionReason: "implementation needs design first",
        totalAgents: 2,
        stages: [stage(0, ["architect"]), stage(1, ["dev", "qa"])],
      },
    })

    expect(state.phase).toBe("running")
    expect(state.name).toBe("demo")
    expect(state.requirement).toBeUndefined()
    expect(state.effectiveRequirement).toBe("build it")
    expect(state.reason).toBe("implementation needs design first")
    expect(state.stages).toHaveLength(2)
    expect(Object.keys(state.agents).sort()).toEqual(["architect", "dev", "qa"])
    expect(state.agents.architect.status).toBe("pending")
    expect(state.agents.architect.logs).toBe("")
  })

  it("keeps the raw answer separate from the resolved pipeline requirement", () => {
    const state = reduceEvent(
      { ...initialState, requirement: "Postgres" },
      {
        type: "orchestration:start",
        timestamp: TS,
        payload: {
          name: "demo",
          requirement: "Build the app with Postgres",
          totalAgents: 0,
          stages: [],
        },
      }
    )
    expect(state.requirement).toBe("Postgres")
    expect(state.effectiveRequirement).toBe("Build the app with Postgres")
  })

  it("keeps the previous requirement when the event omits one", () => {
    const seeded = { ...initialState, requirement: "earlier" }
    const state = reduceEvent(seeded, {
      type: "orchestration:start",
      timestamp: TS,
      payload: { name: "demo", totalAgents: 0, stages: [] },
    })
    expect(state.requirement).toBe("earlier")
  })

  it("clears the leader reason when a new turn starts", () => {
    const state = tuiReducer(
      { ...initialState, reason: "old route", requirement: "old" },
      {
        type: "turn:start",
        requirement: "new",
        agents: {},
        leaderIds: [],
        startedAt: T0,
      }
    )
    expect(state.reason).toBeUndefined()
  })

  it("merges stage agents into a preflight agent instead of resetting it", () => {
    const leader = reduceEvent(initialState, started("leader"))
    const withLogs = reduceEvent(leader, output("leader", "deciding..."))
    const state = reduceEvent(withLogs, {
      type: "orchestration:start",
      timestamp: TS,
      payload: { name: "demo", totalAgents: 1, stages: [stage(0, ["leader"])] },
    })

    expect(state.agents.leader.logs).toBe("deciding...")
    expect(state.agents.leader.status).toBe("running")
  })

  it("ignores stage boundary events", () => {
    const state = withAgents("a")
    const next = reduceEvent(state, {
      type: "stage:start",
      timestamp: TS,
      payload: { stageIndex: 0, agentIds: ["a"] },
    })
    expect(next).toBe(state)
  })

  it.each(["success", "failed", "cancelled", "skipped"] as const)(
    "freezes completed stage %s despite repeated agent starts and stage-list updates",
    (status) => {
      const before = withAgents("a")
      const settled = { ...before, agents: { ...before.agents, a: { ...before.agents.a, status } } }
      const completion: MultiClawEvent = {
        type: "stage:complete",
        timestamp: TS,
        payload: { stageIndex: 0 },
      }
      const completed = reduceEvent(settled, completion)
      expect(completed.stages[0].outcome).toBe(status)
      expect(completed.stages[0].memberStatuses).toEqual({ a: status })
      expect(settled.stages[0].outcome).toBeUndefined()
      expect(reduceEvent(completed, completion)).toBe(completed)
      const updated = reduceEvent(completed, {
        type: "orchestration:stages",
        timestamp: TS,
        payload: { totalAgents: 1, stages: [stage(0, ["a"]), stage(1, ["a"])] },
      })
      const restarted = reduceEvent(updated, started("a"))
      expect(stageStatus(restarted.stages[0], restarted.agents)).toBe(status)
      expect(restarted.stages[0].memberStatuses).toEqual({ a: status })
      expect(stageStatus(restarted.stages[1], restarted.agents)).toBe("running")
      const record = recordedTurns({ ...restarted, phase: "complete", turn: 1 })[0]
      expect(record.stages[0].outcome).toBe(status)
    }
  )

  it("ignores completion for an unknown stage", () => {
    const state = withAgents("a")
    expect(
      reduceEvent(state, { type: "stage:complete", timestamp: TS, payload: { stageIndex: 99 } })
    ).toBe(state)
  })

  it("creates and focuses an agent on start", () => {
    const state = reduceEvent(initialState, started("architect", { icon: "◆", model: "opus" }))
    expect(state.agents.architect.status).toBe("running")
    expect(state.agents.architect.model).toBe("opus")
    expect(state.focusId).toBe("architect")
  })

  it("does not steal focus once auto-follow is off", () => {
    const pinned = tuiReducer(withAgents("a"), { type: "focus:set", agentId: "a" })
    const state = reduceEvent(pinned, started("b"))
    expect(state.focusId).toBe("a")
    expect(state.agents.b.status).toBe("running")
  })

  it("keeps existing fields that the start event omits", () => {
    const seeded = withAgents("a")
    const state = reduceEvent(seeded, {
      type: "agent:start",
      timestamp: TS,
      payload: { agentId: "a", agentName: "a" },
    })
    expect(state.agents.a.status).toBe("running")
  })

  it("clears stale attempt state and separates output when an agent starts again", () => {
    const previous = reduceEvent(withAgents("a"), {
      type: "agent:failed",
      timestamp: TS,
      payload: result("a", { status: "failed", error: "old error", output: "old output" }),
    })
    const next = reduceEvent(
      {
        ...previous,
        agents: { ...previous.agents, a: { ...previous.agents.a, retry: { attempt: 2, max: 3 } } },
      },
      { ...started("a"), timestamp: "2026-01-01T00:00:10.000Z" }
    )
    expect(next.agents.a).toMatchObject({ status: "running", startedAt: T0 + 10000 })
    expect(next.agents.a.error).toBeUndefined()
    expect(next.agents.a.duration).toBeUndefined()
    expect(next.agents.a.attempts).toBeUndefined()
    expect(next.agents.a.retry).toBeUndefined()
    expect(next.agents.a.logs).toContain("old output")
    expect(next.agents.a.logs).toContain("[agent restarted]")
    expect(previous.agents.a.logs).not.toContain("[agent restarted]")
  })

  it.each(["approved", "changes_required", "failed", "cancelled"] as const)(
    "records acceptance %s in live state and detached history",
    (status) => {
      const acceptance = { status, reviewer: "qa", repairRounds: 1, reviews: [] }
      const complete = reduceEvent(
        { ...initialState, turn: 1, requirement: "build it" },
        {
          type: "orchestration:complete",
          timestamp: TS,
          payload: {
            name: "demo",
            success: status === "approved",
            acceptance,
            totalDuration: 10,
            agentResults: [],
            startTime: TS,
            endTime: TS,
          },
        }
      )
      expect(complete.acceptance).toEqual(acceptance)
      expect(recordedTurns(complete)[0].acceptance).toEqual(acceptance)
      const next = tuiReducer(complete, {
        type: "turn:start",
        requirement: "next",
        agents: {},
        leaderIds: [],
        startedAt: T0,
      })
      expect(next.acceptance).toBeUndefined()
      expect(next.history[0].acceptance).toEqual(acceptance)
      expect(tuiReducer(next, { type: "view:open", turn: 1 }).view?.acceptance).toEqual(acceptance)
    }
  )

  it("appends output for a known agent", () => {
    const state = reduceEvent(withAgents("a"), output("a", "hello"))
    expect(state.agents.a.logs).toBe("hello")
  })

  it("ignores output for an unknown agent", () => {
    const state = withAgents("a")
    expect(reduceEvent(state, output("ghost", "hi"))).toBe(state)
  })

  it("marks completion with duration", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "agent:complete",
      timestamp: TS,
      payload: result("a", { duration: 500, attempts: 2 }),
    })
    expect(state.agents.a.status).toBe("success")
    expect(state.agents.a.duration).toBe(500)
    expect(state.agents.a.attempts).toBe(2)
  })

  it("marks failure with the error and tolerates an unseen agent", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "agent:failed",
      timestamp: TS,
      payload: result("ghost", { status: "failed", error: "boom" }),
    })
    expect(state.agents.ghost.status).toBe("failed")
    expect(state.agents.ghost.error).toBe("boom")
  })

  it("buffers non-streamed failed output and the error once", () => {
    const event: MultiClawEvent = {
      type: "agent:failed",
      timestamp: TS,
      payload: result("a", { status: "failed", output: "partial answer", error: "boom" }),
    }
    const state = reduceEvent(withAgents("a"), event)
    expect(state.agents.a.logs).toBe("partial answer\n[error] boom\n")
    expect(reduceEvent(state, event).agents.a.logs).toBe(state.agents.a.logs)
  })

  it("does not duplicate streamed output or an already buffered error", () => {
    const state = reduceEvent(reduceEvent(withAgents("a"), output("a", "partial answer\nboom")), {
      type: "agent:failed",
      timestamp: TS,
      payload: result("a", { status: "failed", output: "partial answer", error: "boom" }),
    })
    expect(state.agents.a.logs).toBe("partial answer\nboom")
  })

  it("does not replace a successful agent's streamed output", () => {
    const state = reduceEvent(reduceEvent(withAgents("a"), output("a", "answer")), {
      type: "agent:complete",
      timestamp: TS,
      payload: result("a", { output: "answer" }),
    })
    expect(state.agents.a.logs).toBe("answer")
  })

  it("marks an existing agent skipped", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "agent:skipped",
      timestamp: TS,
      payload: { agentId: "a", agentName: "a" },
    })
    expect(state.agents.a.status).toBe("skipped")
  })

  it("records an unseen skipped agent", () => {
    const state = reduceEvent(initialState, {
      type: "agent:skipped",
      timestamp: TS,
      payload: { agentId: "ghost", agentName: "ghost", icon: "◆" },
    })
    expect(state.agents.ghost.status).toBe("skipped")
    expect(state.agents.ghost.icon).toBe("◆")
  })

  it("annotates a retry on an existing agent", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "agent:retrying",
      timestamp: TS,
      payload: { agentId: "a", agentName: "a", attempt: 2, maxAttempts: 3, error: "flaky" },
    })
    expect(state.agents.a.status).toBe("retrying")
    expect(state.agents.a.logs).toContain("[retry 2/3] flaky")
  })

  it("records a retry for an unseen agent", () => {
    const state = reduceEvent(initialState, {
      type: "agent:retrying",
      timestamp: TS,
      payload: { agentId: "ghost", agentName: "ghost", attempt: 1, maxAttempts: 2, error: "x" },
    })
    expect(state.agents.ghost.status).toBe("retrying")
  })

  it("stores warnings", () => {
    const state = reduceEvent(initialState, {
      type: "orchestration:warning",
      timestamp: TS,
      payload: { message: "could not parse task-plan.json" },
    })
    expect(state.warning).toBe("could not parse task-plan.json")
  })

  it("closes the orchestration", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: false,
        totalDuration: 9000,
        agentResults: [],
        startTime: TS,
        endTime: TS,
      },
    })
    expect(state.phase).toBe("complete")
    expect(state.success).toBe(false)
    expect(state.totalDuration).toBe(9000)
  })

  it("records a reply the leader gave instead of a plan", () => {
    const state = reduceEvent(initialState, {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: true,
        totalDuration: 120,
        agentResults: [],
        startTime: TS,
        endTime: TS,
        reply: { mode: "reply", message: "hello there" },
      },
    })
    expect(state.reply).toEqual({ mode: "reply", message: "hello there" })
  })

  it("records a question the leader asked", () => {
    const state = reduceEvent(initialState, {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: true,
        totalDuration: 120,
        agentResults: [],
        startTime: TS,
        endTime: TS,
        reply: { mode: "ask", message: "which db?" },
      },
    })
    expect(state.reply?.mode).toBe("ask")
  })

  it("ignores an unknown event type", () => {
    const unknown = {
      type: "nope:unknown",
      timestamp: TS,
      payload: {},
    } as unknown as MultiClawEvent
    expect(reduceEvent(initialState, unknown)).toBe(initialState)
  })
})

describe("tuiReducer", () => {
  it("starts a fresh turn from the configured roster", () => {
    const previous = withAgents("a", "b")
    const roster = seedAgents(config())
    const state = tuiReducer(previous, {
      type: "turn:start",
      requirement: "second",
      agents: roster,
      leaderIds: leaderAgentIds(config()),
      startedAt: T0,
    })

    expect(state.turn).toBe(1)
    expect(state.requirement).toBe("second")
    expect(state.phase).toBe("running")
    expect(state.startedAt).toBe(T0)
    // The roster is present from the first render of the turn, not empty until
    // the orchestrator gets around to announcing it.
    expect(Object.keys(state.agents)).toEqual(["leader", "architect", "dev"])
    expect(state.agents.leader.status).toBe("pending")
    expect(state.stages).toEqual([])
    expect(state.autoFollow).toBe(true)
    expect(state.name).toBe("demo")
    expect(state.leaderIds).toEqual(["leader"])
  })

  it("cycles focus forward and turns off auto-follow", () => {
    // Auto-follow leaves the focus on the last agent to start ("b").
    const state = tuiReducer(withAgents("a", "b"), { type: "focus:cycle", delta: 1 })
    expect(state.focusId).toBe("a")
    expect(state.autoFollow).toBe(false)
  })

  it("cycles focus backwards", () => {
    const state = tuiReducer(withAgents("a", "b"), { type: "focus:cycle", delta: -1 })
    expect(state.focusId).toBe("a")
  })

  it("wraps focus around the agent list", () => {
    const pinned = tuiReducer(withAgents("a", "b"), { type: "focus:set", agentId: "b" })
    const state = tuiReducer(pinned, { type: "focus:cycle", delta: 1 })
    expect(state.focusId).toBe("a")
  })

  it("cycles from the front when nothing is focused", () => {
    const noFocus = { ...withAgents("a", "b"), focusId: undefined }
    expect(tuiReducer(noFocus, { type: "focus:cycle", delta: 1 }).focusId).toBe("a")
  })

  it("is a no-op when there are no agents", () => {
    const state = tuiReducer(initialState, { type: "focus:cycle", delta: 1 })
    expect(state).toBe(initialState)
  })

  it("pins focus explicitly", () => {
    const state = tuiReducer(withAgents("a", "b"), { type: "focus:set", agentId: "a" })
    expect(state.focusId).toBe("a")
    expect(state.autoFollow).toBe(false)
  })

  it("is a no-op cycling focus when there is a single agent", () => {
    const state = withAgents("a")
    expect(tuiReducer(state, { type: "focus:cycle", delta: 1 })).toBe(state)
  })

  it("is a no-op focusing the agent that is already focused and pinned", () => {
    const pinned = tuiReducer(withAgents("a", "b"), { type: "focus:set", agentId: "b" })
    expect(tuiReducer(pinned, { type: "focus:set", agentId: "b" })).toBe(pinned)
  })
})

describe("turn history", () => {
  const start = (state: TuiState, requirement: string) =>
    tuiReducer(state, {
      type: "turn:start",
      requirement,
      agents: seedAgents(config()),
      leaderIds: ["leader"],
      startedAt: T0,
    })

  /** A finished turn, shaped the way the reducer snapshots one. */
  const record = (turn: number, agents: Record<string, AgentView>, focusId?: string): TurnView => ({
    ...initialState,
    turn,
    phase: "complete",
    agents,
    focusId,
  })

  /** A console running a live turn, with one finished turn behind it. */
  const withHistory = (turn1: TurnView): TuiState => ({
    ...start(initialState, "live"),
    history: [turn1],
  })

  it("remembers a finished turn when the next one begins", () => {
    const first = start(withAgents("a"), "first")
    // Still live, so there is nothing to remember yet.
    expect(first.history).toEqual([])

    const second = start(reduceEvent(first, output("leader", "work")), "second")

    expect(second.history).toHaveLength(1)
    expect(second.history[0].turn).toBe(1)
    expect(second.history[0].requirement).toBe("first")
    // The logs go with it — a history entry you cannot read is not history.
    expect(second.history[0].agents.leader.logs).toBe("work")
  })

  it("does not record the seeded roster as a turn nobody asked for", () => {
    expect(start(initialState, "first").history).toEqual([])
  })

  it("records the live turn only once it has finished", () => {
    const running = start(withAgents("a"), "first")
    // Mid-flight the live turn is half a turn — the requirement is known but the
    // outcome is not — so it must not be written to disk as a finished turn.
    expect(recordedTurns(running)).toEqual([])

    const done = reduceEvent(running, {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: true,
        totalDuration: 5,
        agentResults: [],
        startTime: TS,
        endTime: TS,
      },
    })

    const recorded = recordedTurns(done)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].turn).toBe(1)
    expect(recorded[0].requirement).toBe("first")
    expect(recorded[0].phase).toBe("complete")
  })

  // A console restored from disk has a turn number but no turn on screen:
  // `requirement` is the field that says a turn is live, not `turn`. Keying the
  // guard off `turn` would push this empty initial state into history as a
  // phantom "interrupted" record the moment the user asked for the next turn.
  it("does not invent a turn when history is restored but nothing is running", () => {
    const restored: TuiState = {
      ...initialState,
      turn: 5,
      history: [record(4, {}, "leader")],
    }

    const next = start(restored, "next")

    expect(next.history).toHaveLength(1)
    expect(next.history[0].turn).toBe(4)
  })

  it("still remembers the turn on screen when one is actually running", () => {
    const running: TuiState = { ...initialState, turn: 5, requirement: "x" }

    const next = start(running, "next")

    expect(next.history).toHaveLength(1)
    expect(next.history[0].turn).toBe(5)
    expect(next.history[0].requirement).toBe("x")
  })

  it("caps how many turns it keeps, dropping the oldest", () => {
    const older = Array.from(
      { length: MAX_HISTORY },
      (_, i): TurnView => ({ ...initialState, turn: i + 1 })
    )
    // A live turn (requirement set) sitting on top of a full history. `turn`
    // alone would not say a turn is on screen — the guard keys off `requirement`
    // — so the fixture has to carry both, the way `turn:start` writes them.
    const full: TuiState = {
      ...initialState,
      turn: MAX_HISTORY + 1,
      requirement: "running",
      history: older,
    }

    const next = start(full, "next")

    expect(next.history).toHaveLength(MAX_HISTORY)
    expect(next.history[MAX_HISTORY - 1].turn).toBe(MAX_HISTORY + 1)
    expect(next.history[0].turn).toBe(2)
  })

  it("opens a finished turn for reading", () => {
    const twoTurns = start(start(withAgents("a"), "first"), "second")
    const opened = tuiReducer(twoTurns, { type: "view:open", turn: 1 })

    expect(opened.view?.turn).toBe(1)
    expect(opened.view?.requirement).toBe("first")
  })

  it("ignores a request for a turn it never recorded", () => {
    const state = start(withAgents("a"), "first")
    expect(tuiReducer(state, { type: "view:open", turn: 99 })).toBe(state)
  })

  it("closes the open turn, and does nothing when none is open", () => {
    const state = start(withAgents("a"), "first")
    expect(tuiReducer(state, { type: "view:close" })).toBe(state)

    const opened = tuiReducer(start(state, "second"), { type: "view:open", turn: 1 })
    expect(tuiReducer(opened, { type: "view:close" }).view).toBeUndefined()
  })

  // Browsing has to be harmless: an edit that landed on the live turn would move
  // the focus out from under a run in progress.
  it("scrolls the turn being read, not the one that is running", () => {
    const agents = reduceEvent(withAgents("a"), output("a", "1\n2\n3\n4\n5")).agents
    const opened = tuiReducer(withHistory(record(1, agents, "a")), { type: "view:open", turn: 1 })

    const scrolled = tuiReducer(opened, {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
      width: WIDTH,
    })

    expect(scrolled.view?.scroll).toBe(2)
    expect(scrolled.scroll).toBe(0)
    // And the record itself is left as it was, so reopening shows the tail.
    expect(scrolled.history[0].scroll).toBe(0)
  })

  it("focuses within the turn being read, not the one that is running", () => {
    const agents = withAgents("a", "b").agents
    // Auto-follow left the focus on the last agent to start.
    const opened = tuiReducer(withHistory(record(1, agents, "b")), { type: "view:open", turn: 1 })

    const cycled = tuiReducer(opened, { type: "focus:cycle", delta: 1 })

    expect(cycled.view?.focusId).toBe("a")
    expect(cycled.focusId).toBe("leader")
  })

  // A console note is about work happening *now*, so it belongs to the live
  // turn even while an old one is open: writing it into the record on screen
  // would edit history that the run never produced.
  it("writes a console note to the live turn, not the one being read", () => {
    const live: TuiState = { ...withAgents("a"), phase: "running", requirement: "live" }
    const opened = tuiReducer(
      { ...live, history: [record(1, live.agents, "a")] },
      { type: "view:open", turn: 1 }
    )

    const noted = tuiReducer(opened, { type: "stream:note", agentId: "a", text: "[steer] go left" })

    expect(noted.agents.a.logs).toBe("\n[steer] go left\n")
    expect(noted.view?.agents.a.logs).toBe("")
    expect(noted.history[0].agents.a.logs).toBe("")
  })

  it("goes back to the live turn when a new one starts", () => {
    const opened = tuiReducer(start(start(withAgents("a"), "first"), "second"), {
      type: "view:open",
      turn: 1,
    })
    expect(start(opened, "third").view).toBeUndefined()
  })
})

describe("stageStatus", () => {
  const agents = (statuses: Record<string, AgentView["status"]>): Record<string, AgentView> =>
    Object.fromEntries(
      Object.entries(statuses).map(([id, status]) => [id, { id, name: id, status, logs: "" }])
    )

  it("is failed when any member failed", () => {
    expect(stageStatus(stage(0, ["a", "b"]), agents({ a: "success", b: "failed" }))).toBe("failed")
  })

  it("is running when any member is running or retrying", () => {
    expect(stageStatus(stage(0, ["a", "b"]), agents({ a: "success", b: "running" }))).toBe(
      "running"
    )
    expect(stageStatus(stage(0, ["a", "b"]), agents({ a: "success", b: "retrying" }))).toBe(
      "running"
    )
  })

  it("is success when every member succeeded", () => {
    expect(stageStatus(stage(0, ["a", "b"]), agents({ a: "success", b: "success" }))).toBe(
      "success"
    )
  })

  it("is skipped when every member was skipped", () => {
    expect(stageStatus(stage(0, ["a", "b"]), agents({ a: "skipped", b: "skipped" }))).toBe(
      "skipped"
    )
  })

  it("is cancelled when every member was cancelled, not pending", () => {
    expect(stageStatus(stage(0, ["a", "b"]), agents({ a: "cancelled", b: "cancelled" }))).toBe(
      "cancelled"
    )
  })

  it("is pending when members are missing or mixed", () => {
    expect(stageStatus(stage(0, ["a"]), {})).toBe("pending")
    expect(stageStatus(stage(0, ["a", "b"]), agents({ a: "success", b: "pending" }))).toBe(
      "pending"
    )
  })

  it("is pending for an empty stage", () => {
    expect(stageStatus(stage(0, []), {})).toBe("pending")
  })
})

describe("seedAgents", () => {
  it("lists the whole team before the first run, leader first", () => {
    const agents = seedAgents(config())
    expect(Object.keys(agents)).toEqual(["leader", "architect", "dev"])
    expect(agents.architect.status).toBe("pending")
    expect(agents.architect.logs).toBe("")
  })

  it("shows the model the agent will actually run with", () => {
    const agents = seedAgents(
      config({
        agents: [agent("dev", { models: { acp: "opus" } }), agent("qa", { model: "haiku" })],
      })
    )
    expect(agents.dev.model).toBe("opus")
    expect(agents.qa.model).toBe("haiku")
  })

  it("omits the leader when useLeader is false", () => {
    expect(Object.keys(seedAgents(config({ useLeader: false })))).toEqual(["architect", "dev"])
  })

  it("works without a leader", () => {
    expect(Object.keys(seedAgents(config({ leader: undefined })))).toEqual(["architect", "dev"])
  })

  it("returns a fresh roster each call so turns never share mutable state", () => {
    const first = seedAgents(config())
    const second = seedAgents(config())
    expect(first).not.toBe(second)
    expect(first.architect).not.toBe(second.architect)
  })

  // The console's first screen has no task plan to read, so the role has to
  // come from the config — and survive the roster being rebuilt from events.
  it("carries each agent's role from the config", () => {
    const agents = seedAgents(
      config({ agents: [agent("architect", { description: "designs the architecture" })] })
    )
    expect(agents.architect.description).toBe("designs the architecture")
  })
})

describe("agent descriptions", () => {
  it("survives an orchestration:start whose payload omits them", () => {
    const seeded = createInitialState(
      config({ agents: [agent("architect", { description: "designs the architecture" })] })
    )
    const state = reduceEvent(seeded, {
      type: "orchestration:start",
      timestamp: TS,
      payload: { name: "demo", totalAgents: 1, stages: [stage(0, ["architect"])] },
    })
    expect(state.agents.architect.description).toBe("designs the architecture")
  })

  it("takes the role from the event when the payload carries one", () => {
    const state = reduceEvent(initialState, {
      type: "orchestration:start",
      timestamp: TS,
      payload: {
        name: "demo",
        totalAgents: 1,
        stages: [
          {
            stageIndex: 0,
            agents: [{ id: "architect", name: "Architect", description: "from the event" }],
          },
        ],
      },
    })
    expect(state.agents.architect.description).toBe("from the event")
  })
})

describe("orchestration:stages", () => {
  it("replaces the grouping without disturbing the live agents", () => {
    const state = reduceEvent(withAgents("a"), output("a", "hello"))
    const next = reduceEvent(state, {
      type: "orchestration:stages",
      timestamp: TS,
      payload: { totalAgents: 2, stages: [stage(0, ["a"]), stage(1, ["b"])] },
    })

    expect(next.stages.map((s) => s.agents.map((x) => x.id))).toEqual([["a"], ["b"]])
    // The regroup must not reset what already ran: agent `a` keeps its log, and
    // `b` — newly named by the plan — is folded in as pending.
    expect(next.agents.a.logs).toBe("hello")
    expect(next.agents.b.status).toBe("pending")
  })
})

describe("leaderAgentIds", () => {
  it("names the configured leader", () => {
    expect(leaderAgentIds(config())).toEqual(["leader"])
  })

  it("is empty when the leader is disabled or absent", () => {
    expect(leaderAgentIds(config({ useLeader: false }))).toEqual([])
    expect(leaderAgentIds(config({ leader: undefined }))).toEqual([])
  })
})

describe("createInitialState", () => {
  it("opens on the configured team instead of an empty list", () => {
    const state = createInitialState(config())
    expect(state.phase).toBe("idle")
    expect(state.name).toBe("demo")
    expect(state.turn).toBe(0)
    expect(Object.keys(state.agents)).toEqual(["leader", "architect", "dev"])
    // Focus starts on the first agent so the log pane is not blank on open.
    expect(state.focusId).toBe("leader")
    expect(state.leaderIds).toEqual(["leader"])
  })

  it("leaves focus unset when there is no team at all", () => {
    const state = createInitialState(config({ leader: undefined, agents: [] }))
    expect(state.agents).toEqual({})
    expect(state.focusId).toBeUndefined()
  })

  it("opens with the stream live rather than scrolled back", () => {
    expect(createInitialState(config()).scroll).toBe(0)
  })

  it("continues the turn number from restored history", () => {
    const earlier: TurnView = { ...initialState, turn: 4, phase: "complete", requirement: "old" }

    const state = createInitialState(config(), [earlier])

    // Numbering has to keep climbing across sessions, or `/replay 4` would name
    // two different turns the moment a second session began.
    expect(state.turn).toBe(4)
    expect(state.history).toEqual([earlier])
    // A restored console is idle: nothing is running, so no requirement is set.
    expect(state.phase).toBe("idle")
    expect(state.requirement).toBeUndefined()
  })

  it("matches the argument-less call exactly when no history is given", () => {
    // The second parameter is additive: every existing caller must behave as it
    // did before history existed.
    expect(createInitialState(config(), [])).toEqual(createInitialState(config()))
  })
})

describe("progress", () => {
  it("counts settled agents out of the roster", () => {
    const state = withAgents("a", "b", "c")
    expect(progress(state)).toEqual({ done: 0, total: 3 })

    const one = reduceEvent(state, { type: "agent:complete", timestamp: TS, payload: result("a") })
    expect(progress(one)).toEqual({ done: 1, total: 3 })
  })

  it("counts failures and skips as settled", () => {
    let state = withAgents("a", "b")
    state = reduceEvent(state, {
      type: "agent:failed",
      timestamp: TS,
      payload: result("a", { status: "failed" }),
    })
    state = reduceEvent(state, {
      type: "agent:skipped",
      timestamp: TS,
      payload: { agentId: "b", agentName: "b" },
    })
    expect(progress(state)).toEqual({ done: 2, total: 2 })
  })

  it("does not count a retrying agent as settled", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "agent:retrying",
      timestamp: TS,
      payload: { agentId: "a", agentName: "a", attempt: 1, maxAttempts: 3, error: "flaky" },
    })
    expect(progress(state)).toEqual({ done: 0, total: 1 })
  })

  it("is zero over an empty roster", () => {
    expect(progress(initialState)).toEqual({ done: 0, total: 0 })
  })
})

describe("live clocks", () => {
  it("stamps an agent's start time from the event timestamp", () => {
    const state = reduceEvent(initialState, started("a"))
    expect(state.agents.a.startedAt).toBe(T0)
  })

  it("counts up while an agent runs", () => {
    const state = reduceEvent(initialState, started("a"))
    expect(agentElapsed(state.agents.a, T0 + 2500)).toBe(2500)
  })

  it("freezes on the recorded duration once the agent stops", () => {
    const running = reduceEvent(initialState, started("a"))
    const done = reduceEvent(running, {
      type: "agent:complete",
      timestamp: TS,
      payload: result("a", { duration: 1234 }),
    })
    // The reported duration wins, so the column cannot jump as stages finish.
    expect(agentElapsed(done.agents.a, T0 + 99_000)).toBe(1234)
  })

  it("has no clock for an agent that never started", () => {
    expect(agentElapsed({ id: "a", name: "a", status: "pending", logs: "" }, 5000)).toBeUndefined()
  })

  it("runs the turn clock live, then reports the orchestrator's total", () => {
    const state = tuiReducer(withAgents("a"), {
      type: "turn:start",
      requirement: "go",
      agents: seedAgents(config()),
      leaderIds: ["leader"],
      startedAt: T0,
    })
    expect(turnElapsed(state, T0 + 3000)).toBe(3000)

    const done = reduceEvent(state, {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: true,
        totalDuration: 9000,
        agentResults: [],
        startTime: TS,
        endTime: TS,
      },
    })
    expect(turnElapsed(done, T0 + 99_000)).toBe(9000)
  })

  it("has no turn clock before the first turn", () => {
    expect(turnElapsed(initialState, 5000)).toBeUndefined()
  })

  it("falls back to the completion timestamp when no total was reported", () => {
    const state = { ...initialState, startedAt: T0, phase: "complete" as const, endedAt: T0 + 700 }
    expect(turnElapsed(state, T0 + 99_000)).toBe(700)
  })
})

describe("visibleLog", () => {
  /** A focused agent with a known number of log lines. */
  function logged(text: string) {
    return reduceEvent(withAgents("a"), output("a", text))
  }

  it("shows the tail while following", () => {
    const window = visibleLog(logged("1\n2\n3\n4\n5"), 2, WIDTH)
    expect(window.rows).toEqual(["4", "5"])
    expect(window.following).toBe(true)
    expect(window.scrolledBack).toBe(0)
  })

  it("scrolls back by whole rows", () => {
    const state = tuiReducer(logged("1\n2\n3\n4\n5"), {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
      width: WIDTH,
    })
    const window = visibleLog(state, 2, WIDTH)
    expect(window.rows).toEqual(["2", "3"])
    expect(window.scrolledBack).toBe(2)
    expect(window.following).toBe(false)
  })

  it("clamps at the tail, so scrolling past the end re-arms follow", () => {
    const state = logged("1\n2\n3\n4\n5")
    const up = tuiReducer(state, { type: "stream:scroll", delta: 2, viewport: 2, width: WIDTH })
    const back = tuiReducer(up, { type: "stream:scroll", delta: -99, viewport: 2, width: WIDTH })
    expect(back.scroll).toBe(0)
    expect(visibleLog(back, 2, WIDTH).following).toBe(true)
  })

  it("clamps at the head", () => {
    const state = logged("1\n2\n3\n4\n5")
    expect(
      tuiReducer(state, { type: "stream:scroll", delta: 99, viewport: 2, width: WIDTH }).scroll
    ).toBe(3)
  })

  it("is a no-op when there is nothing to scroll", () => {
    const state = logged("1\n2")
    expect(tuiReducer(state, { type: "stream:scroll", delta: 5, viewport: 10, width: WIDTH })).toBe(
      state
    )
  })

  it("is empty when nothing is focused, or nothing has been written", () => {
    expect(visibleLog(initialState, 5, WIDTH).rows).toEqual([])
    expect(visibleLog(withAgents("a"), 5, WIDTH).rows).toEqual([])
  })

  it("re-clamps a parked offset when the pane is resized under it", () => {
    const state = tuiReducer(logged("1\n2\n3\n4\n5"), {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
      width: WIDTH,
    })
    expect(state.scroll).toBe(2)
    // The pane grew since the scroll, so the offset is re-clamped on read.
    expect(visibleLog(state, 5, WIDTH).scrolledBack).toBe(0)
  })

  // The window is a number of *rows*, not a number of log lines. A line wider
  // than the pane spends several rows, and a window that sliced by lines would
  // hand the pane more rows than it has — pushing the newest output out of view.
  it("counts a wrapped line as the rows it spends, not as one", () => {
    const window = visibleLog(logged("short\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), 2, 10)
    // Four rows in the buffer: the short line, then three of ten `x`. A two-row
    // window can only show the last two, so the short line is gone.
    expect(window.rows).toEqual(["xxxxxxxxxx", "xxxxxxxxxx"])
  })

  it("scrolls a wrapped line one row at a time", () => {
    const state = tuiReducer(logged("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), {
      type: "stream:scroll",
      delta: 1,
      viewport: 2,
      width: 10,
    })
    // Three rows of ten, so the head is one row back from the two-row window.
    expect(state.scroll).toBe(1)
    expect(visibleLog(state, 2, 10).rows).toEqual(["xxxxxxxxxx", "xxxxxxxxxx"])
    // And the clamp knows the buffer is three rows, not one line.
    const head = tuiReducer(state, { type: "stream:scroll", delta: 99, viewport: 2, width: 10 })
    expect(head.scroll).toBe(1)
  })

  // Resizing the pane changes how many rows each line spends, so a parked
  // offset has to be re-clamped against the new width on read, not just on
  // scroll — otherwise widening the terminal strands the reader mid-buffer.
  it("re-clamps a parked offset when the pane widens", () => {
    const state = tuiReducer(logged("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), {
      type: "stream:scroll",
      delta: 1,
      viewport: 2,
      width: 10,
    })
    // Three rows at ten columns, so there is a row to scroll back to.
    expect(state.scroll).toBe(1)
    // At thirty columns the whole buffer is one row, so the offset is dropped.
    expect(visibleLog(state, 2, 30).scrolledBack).toBe(0)
    expect(visibleLog(state, 2, 30).following).toBe(true)
  })

  it("searches the newest matching wrapped row", () => {
    const state = logged("alpha\nbeta\ngamma\nbeta later\nomega")
    const searched = tuiReducer(state, {
      type: "stream:search",
      query: "beta",
      viewport: 2,
      width: WIDTH,
    })
    expect(searched.scroll).toBe(1)
    expect(searched.autoFollow).toBe(false)
    expect(visibleLog(searched, 2, WIDTH).rows).toEqual(["gamma", "beta later"])
  })

  it("latest returns the stream to the tail and re-arms follow", () => {
    const scrolled = tuiReducer(logged("1\n2\n3\n4\n5"), {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
      width: WIDTH,
    })
    const latest = tuiReducer(scrolled, { type: "stream:latest" })
    expect(latest.scroll).toBe(0)
    expect(latest.autoFollow).toBe(true)
  })
})

describe("stream:clear", () => {
  it("drops the focused buffer without touching status", () => {
    const state = reduceEvent(withAgents("a"), output("a", "noise"))
    const cleared = tuiReducer(state, { type: "stream:clear" })
    expect(cleared.agents.a.logs).toBe("")
    expect(cleared.agents.a.status).toBe("running")
    expect(cleared.scroll).toBe(0)
  })

  it("is a no-op when nothing is focused", () => {
    expect(tuiReducer(initialState, { type: "stream:clear" })).toBe(initialState)
  })
})

describe("focus and window resets", () => {
  it("ignores a focus request for an unknown agent", () => {
    const state = withAgents("a")
    expect(tuiReducer(state, { type: "focus:set", agentId: "ghost" })).toBe(state)
  })

  it("returns the window to the tail when the focus changes", () => {
    const scrolled = tuiReducer(reduceEvent(withAgents("a"), output("a", "1\n2\n3\n4\n5")), {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
      width: WIDTH,
    })
    expect(scrolled.scroll).toBe(2)
    expect(tuiReducer(scrolled, { type: "focus:set", agentId: "a" }).scroll).toBe(0)
  })

  it("returns the window to the tail when the focus cycles to another agent", () => {
    // Both agents have output, so whichever one is focused has a window to reset.
    const base = reduceEvent(
      reduceEvent(withAgents("a", "b"), output("a", "1\n2\n3\n4\n5")),
      output("b", "1\n2\n3\n4\n5")
    )
    const scrolled = tuiReducer(base, {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
      width: WIDTH,
    })
    expect(scrolled.scroll).toBe(2)
    // Auto-follow left the focus on "b"; cycling moves to "a" and resets the window.
    expect(tuiReducer(scrolled, { type: "focus:cycle", delta: 1 }).scroll).toBe(0)
  })

  it("leaves the window alone when a cycle has nowhere to go", () => {
    // One agent: the focus cannot move, so the reader's position is not yanked.
    const scrolled = tuiReducer(reduceEvent(withAgents("a"), output("a", "1\n2\n3\n4\n5")), {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
      width: WIDTH,
    })
    expect(tuiReducer(scrolled, { type: "focus:cycle", delta: 1 })).toBe(scrolled)
  })

  it("returns the window to the tail when a new turn starts", () => {
    const scrolled = tuiReducer(reduceEvent(withAgents("a"), output("a", "1\n2\n3\n4\n5")), {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
      width: WIDTH,
    })
    const next = tuiReducer(scrolled, {
      type: "turn:start",
      requirement: "again",
      agents: seedAgents(config()),
      leaderIds: ["leader"],
      startedAt: T0,
    })
    expect(next.scroll).toBe(0)
  })

  // The previous answer belongs to the previous requirement. Leaving it up would
  // make it read as the response to whatever was just asked.
  it("drops the previous reply when a new turn starts", () => {
    const answered = reduceEvent(withAgents("a"), {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: true,
        totalDuration: 10,
        agentResults: [],
        startTime: TS,
        endTime: TS,
        reply: { mode: "reply", message: "hi" },
      },
    })
    const next = tuiReducer(answered, {
      type: "turn:start",
      requirement: "again",
      agents: seedAgents(config()),
      leaderIds: ["leader"],
      startedAt: T0,
    })
    expect(next.reply).toBeUndefined()
  })
})

describe("conversationTurns", () => {
  /** Run one turn to completion, optionally ending it in words. */
  function ran(state: TuiState, requirement: string, reply?: LeaderMessage): TuiState {
    const started = tuiReducer(state, {
      type: "turn:start",
      requirement,
      agents: seedAgents(config()),
      leaderIds: ["leader"],
      startedAt: T0,
    })
    return reduceEvent(started, {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: true,
        totalDuration: 10,
        agentResults: [],
        startTime: TS,
        endTime: TS,
        ...(reply ? { reply } : {}),
      },
    })
  }

  function completed(patch: Partial<TuiState> = {}): TuiState {
    return {
      ...createInitialState(config()),
      phase: "complete",
      turn: 1,
      requirement: "build it",
      ...patch,
    }
  }

  function statuses(values: Record<string, AgentView["status"]>): Record<string, AgentView> {
    return Object.fromEntries(
      Object.entries(values).map(([id, status]) => [id, { id, name: id, status, logs: "" }])
    )
  }

  it("projects successful workers without the successful leader or unscheduled roster", () => {
    expect(
      conversationTurns(
        completed({
          success: true,
          agents: statuses({ leader: "success", architect: "success", dev: "pending" }),
          stages: [stage(0, ["architect"])],
        })
      )
    ).toEqual([
      {
        requirement: "build it",
        outcome: { execution: "success", completedAgents: ["architect"], failedAgents: [] },
      },
    ])
  })

  it("keeps success when only workers outside the selected pipeline were skipped", () => {
    expect(
      conversationTurns(
        completed({
          success: true,
          agents: statuses({ architect: "success", dev: "skipped" }),
          stages: [stage(0, ["architect"])],
        })
      )[0]
    ).toEqual({
      requirement: "build it",
      outcome: { execution: "success", completedAgents: ["architect"], failedAgents: [] },
    })
  })

  it("projects only completed workers and factual failure reasons", () => {
    const agents = statuses({
      architect: "success",
      dev: "failed",
      qa: "skipped",
      spare: "pending",
    })
    agents.dev.error = "compile error"
    expect(conversationTurns(completed({ success: false, agents }))).toEqual([
      {
        requirement: "build it",
        outcome: {
          execution: "failed",
          completedAgents: ["architect"],
          failedAgents: [{ agentId: "dev", reason: "compile error" }],
        },
      },
    ])
  })

  it.each([true, false])(
    "keeps successful fallback worker execution separate from failed leader (turn success %s)",
    (success) => {
      const agents = statuses({ leader: "failed", architect: "success" })
      agents.leader.error = "leader fallback"
      const acceptance = success
        ? undefined
        : { status: "failed" as const, reviewer: "qa", repairRounds: 0, reviews: [] }
      expect(conversationTurns(completed({ success, agents, acceptance }))[0]).toEqual({
        requirement: "build it",
        outcome: {
          execution: "success",
          completedAgents: ["architect"],
          failedAgents: [],
          ...(acceptance ? { acceptance: { status: "failed" } } : {}),
        },
      })
    }
  )

  it("keeps only worker failures when execution continued after leader fallback", () => {
    const agents = statuses({ leader: "failed", architect: "failed" })
    agents.architect.error = "worker error"
    expect(conversationTurns(completed({ success: false, agents }))[0]).toEqual({
      requirement: "build it",
      outcome: {
        execution: "failed",
        completedAgents: [],
        failedAgents: [{ agentId: "architect", reason: "worker error" }],
      },
    })
  })

  it("keeps cancelled fallback execution separate from a failed leader", () => {
    expect(
      conversationTurns(
        completed({
          success: false,
          agents: statuses({ leader: "failed", architect: "cancelled" }),
        })
      )[0]
    ).toEqual({
      requirement: "build it",
      outcome: { execution: "cancelled", completedAgents: [], failedAgents: [] },
    })
  })

  it("includes a failed preflight leader without inventing a worker completion", () => {
    const agents = statuses({ leader: "failed", architect: "pending" })
    agents.leader.error = "cannot plan"
    expect(conversationTurns(completed({ success: false, agents }))[0]).toEqual({
      requirement: "build it",
      outcome: {
        execution: "failed",
        completedAgents: [],
        failedAgents: [{ agentId: "leader", reason: "cannot plan" }],
      },
    })
  })

  it.each(["approved", "changes_required", "failed", "cancelled"] as const)(
    "keeps acceptance %s separate from successful worker execution",
    (status) => {
      const acceptance = {
        status,
        reviewer: "qa",
        repairRounds: 0,
        reviews: [],
        reason: "review reason",
      }
      const agents = statuses({
        leader: "success",
        architect: "success",
        qa: status === "failed" ? "failed" : "success",
      })
      agents.qa.error = "review process error"
      expect(
        conversationTurns(completed({ success: status === "approved", agents, acceptance }))[0]
      ).toEqual({
        requirement: "build it",
        outcome: {
          execution: "success",
          completedAgents: ["architect"],
          failedAgents: [],
          acceptance: { status, reason: "review reason" },
        },
      })
    }
  )

  it("preserves worker failures separately from acceptance reasons", () => {
    const agents = statuses({ architect: "failed", qa: "failed" })
    agents.architect.error = "worker error"
    const acceptance = {
      status: "failed" as const,
      reviewer: "qa",
      repairRounds: 0,
      reviews: [],
      reason: "review unavailable",
    }
    expect(conversationTurns(completed({ success: false, agents, acceptance }))[0]).toEqual({
      requirement: "build it",
      outcome: {
        execution: "failed",
        completedAgents: [],
        failedAgents: [{ agentId: "architect", reason: "worker error" }],
        acceptance: { status: "failed", reason: "review unavailable" },
      },
    })
  })

  it.each([undefined, true])("keeps empty legacy success %s unknown", (success) => {
    expect(conversationTurns(completed({ success, agents: {} }))[0]).toEqual({
      requirement: "build it",
      outcome: { execution: "unknown", completedAgents: [], failedAgents: [] },
    })
  })

  it("identifies pre-start failure even with no observed agents", () => {
    expect(conversationTurns(completed({ success: false }))[0]).toEqual({
      requirement: "build it",
      outcome: { execution: "failed", completedAgents: [], failedAgents: [] },
    })
  })

  it("does not convert acceptance-only empty failure into execution failure", () => {
    const acceptance = { status: "failed" as const, reviewer: "qa", repairRounds: 0, reviews: [] }
    expect(conversationTurns(completed({ success: false, acceptance }))[0]).toEqual({
      requirement: "build it",
      outcome: {
        execution: "unknown",
        completedAgents: [],
        failedAgents: [],
        acceptance: { status: "failed" },
      },
    })
  })

  it.each(["pending", "running", "retrying", "skipped", undefined] as const)(
    "does not claim success while a stage-selected worker is %s",
    (status) => {
      const agents = statuses({ architect: "success", ...(status ? { dev: status } : {}) })
      expect(
        conversationTurns(
          completed({ success: true, agents, stages: [stage(0, ["architect", "dev"])] })
        )[0]
      ).toEqual({
        requirement: "build it",
        outcome: { execution: "unknown", completedAgents: ["architect"], failedAgents: [] },
      })
    }
  )

  it("does not count skipped workers as completed or invent an all-skipped success", () => {
    expect(
      conversationTurns(completed({ success: true, agents: statuses({ architect: "skipped" }) }))[0]
    ).toEqual({
      requirement: "build it",
      outcome: { execution: "unknown", completedAgents: [], failedAgents: [] },
    })
  })

  it("projects cancelled worker execution without counting cancellation as failure", () => {
    expect(
      conversationTurns(
        completed({ success: false, agents: statuses({ architect: "cancelled" }) })
      )[0]
    ).toEqual({
      requirement: "build it",
      outcome: { execution: "cancelled", completedAgents: [], failedAgents: [] },
    })
  })

  it("preserves interruption over cancelled or failed worker execution", () => {
    expect(
      conversationTurns(
        completed({
          interrupted: true,
          agents: statuses({ architect: "success", dev: "cancelled", qa: "failed" }),
        })
      )[0]
    ).toEqual({
      requirement: "build it",
      outcome: {
        execution: "interrupted",
        completedAgents: ["architect"],
        failedAgents: [{ agentId: "qa" }],
      },
    })
  })

  it("keeps latest worker facts after a frozen failed stage is repaired", () => {
    const frozen = {
      ...stage(0, ["architect"]),
      outcome: "failed" as const,
      memberStatuses: { architect: "failed" as const },
    }
    expect(
      conversationTurns(
        completed({
          success: true,
          agents: statuses({ architect: "success" }),
          stages: [frozen, stage(1, ["architect"])],
        })
      )[0]
    ).toEqual({
      requirement: "build it",
      outcome: { execution: "success", completedAgents: ["architect"], failedAgents: [] },
    })
  })

  it.each(["ask", "reply"] as const)("preserves exact raw %s without adding an outcome", (mode) => {
    const reply = { mode, message: "  exact reply\n" }
    expect(
      conversationTurns(completed({ requirement: "  raw request  ", success: false, reply }))
    ).toEqual([{ requirement: "  raw request  ", reply }])
  })

  it("projects historical and live outcomes in absolute turn order without changing records", () => {
    const older: TurnView = {
      ...completed({ agents: statuses({ architect: "failed" }), success: false }),
      turn: 42,
    }
    const state = completed({ turn: 43, agents: statuses({ dev: "success" }), history: [older] })
    expect(conversationTurns(state)).toEqual([
      {
        requirement: "build it",
        outcome: {
          execution: "failed",
          completedAgents: [],
          failedAgents: [{ agentId: "architect" }],
        },
      },
      {
        requirement: "build it",
        outcome: { execution: "success", completedAgents: ["dev"], failedAgents: [] },
      },
    ])
    expect(recordedTurns(state).map((turn) => turn.turn)).toEqual([42, 43])
    expect(older.agents.architect.status).toBe("failed")
  })

  it("carries nothing before the first turn has run", () => {
    expect(conversationTurns(createInitialState(config()))).toEqual([])
  })

  it("carries the question a later answer belongs to", () => {
    const state = ran(createInitialState(config()), "build a web app", {
      mode: "ask",
      message: "which database?",
    })

    expect(conversationTurns(state)).toEqual([
      { requirement: "build a web app", reply: { mode: "ask", message: "which database?" } },
    ])
  })

  it("leaves out the leader line for a turn that ran the team", () => {
    const state = ran(createInitialState(config()), "add a --json flag")

    expect(conversationTurns(state)).toEqual([
      {
        requirement: "add a --json flag",
        outcome: { execution: "unknown", completedAgents: [], failedAgents: [] },
      },
    ])
  })

  it("keeps every finished turn, oldest first", () => {
    let state = createInitialState(config())
    state = ran(state, "build a web app", { mode: "ask", message: "which database?" })
    state = ran(state, "Postgres")

    expect(conversationTurns(state).map((turn) => turn.requirement)).toEqual([
      "build a web app",
      "Postgres",
    ])
  })

  // Half a turn is not context: a cancelled turn never emits
  // `orchestration:complete`, so it would otherwise be carried as a requirement
  // the team was asked for and never finished.
  it("leaves out a turn that is still running", () => {
    const state = tuiReducer(createInitialState(config()), {
      type: "turn:start",
      requirement: "build a web app",
      agents: seedAgents(config()),
      leaderIds: ["leader"],
      startedAt: T0,
    })

    expect(conversationTurns(state)).toEqual([])
  })

  it("keeps a completed cancelled turn browsable but out of the conversation", () => {
    const cancelled = reduceEvent(ran(createInitialState(config()), "doomed"), {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: false,
        cancelled: true,
        requirement: "resolved doomed request",
        totalDuration: 10,
        agentResults: [],
        startTime: TS,
        endTime: TS,
      },
    })
    expect(recordedTurns(cancelled)[0]).toMatchObject({
      requirement: "doomed",
      effectiveRequirement: "resolved doomed request",
      cancelled: true,
      phase: "complete",
    })
    expect(conversationTurns(cancelled)).toEqual([])

    const state = ran(cancelled, "second")
    expect(state.history[0].cancelled).toBe(true)
    expect(state.history[0].effectiveRequirement).toBe("resolved doomed request")
    expect(tuiReducer(state, { type: "view:open", turn: 1 }).view?.cancelled).toBe(true)
    expect(state.cancelled).toBeUndefined()
    expect(state.effectiveRequirement).toBeUndefined()
    expect(conversationTurns(state).map((turn) => turn.requirement)).toEqual(["second"])
  })

  it("records the short raw answer, not the resolved requirement, as dialogue", () => {
    const done = reduceEvent(ran(createInitialState(config()), "Postgres"), {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: true,
        requirement: "Build the web app with Postgres",
        totalDuration: 10,
        agentResults: [],
        startTime: TS,
        endTime: TS,
      },
    })
    expect(recordedTurns(done)[0].effectiveRequirement).toBe("Build the web app with Postgres")
    expect(conversationTurns(done)).toEqual([
      {
        requirement: "Postgres",
        outcome: { execution: "unknown", completedAgents: [], failedAgents: [] },
      },
    ])
  })
})

describe("verbose and tool detail", () => {
  const outputEvent = (
    agentId: string,
    chunk: string,
    kind?: "text" | "tool" | "tool-detail"
  ): MultiClawEvent => ({
    type: "agent:output",
    timestamp: TS,
    payload: { agentId, chunk, ...(kind ? { kind } : {}) },
  })

  it("defaults to off, on the console rather than the turn", () => {
    expect(initialState.verbose).toBe(false)
    expect(createInitialState(config()).verbose).toBe(false)
  })

  it("toggles", () => {
    expect(tuiReducer(initialState, { type: "verbose:toggle" }).verbose).toBe(true)
    expect(tuiReducer({ ...initialState, verbose: true }, { type: "verbose:toggle" }).verbose).toBe(
      false
    )
  })

  it("drops tool-detail output while verbose is off", () => {
    const state = withAgents("a")
    // Dropped at the reducer, not at render: a later toggle must not resurrect
    // history that was never buffered.
    expect(reduceEvent(state, outputEvent("a", "  ✓ detail\n", "tool-detail"))).toBe(state)
  })

  it("keeps tool-detail output while verbose is on", () => {
    const state = { ...withAgents("a"), verbose: true }
    const next = reduceEvent(state, outputEvent("a", "  ✓ detail\n", "tool-detail"))
    expect(next.agents.a.logs).toBe("  ✓ detail\n")
  })

  it("always keeps the tool summary line, and untagged text", () => {
    const state = withAgents("a")
    const tool = reduceEvent(state, outputEvent("a", "\n› Bash\n", "tool"))
    expect(tool.agents.a.logs).toContain("Bash")
    const text = reduceEvent(state, outputEvent("a", "prose"))
    expect(text.agents.a.logs).toBe("prose")
  })

  it("carries verbose across turns, since it is a console setting", () => {
    const on = { ...withAgents("a"), verbose: true }
    const next = tuiReducer(on, {
      type: "turn:start",
      requirement: "again",
      agents: seedAgents(config()),
      leaderIds: ["leader"],
      startedAt: T0,
    })
    expect(next.verbose).toBe(true)
  })
})

describe("cost and usage", () => {
  it("copies usage and cost from an agent's result", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "agent:complete",
      timestamp: TS,
      payload: result("a", {
        usage: { contextTokens: 45200, contextSize: 200000 },
        costUsd: 0.42,
      }),
    })
    expect(state.agents.a.usage).toEqual({ contextTokens: 45200, contextSize: 200000 })
    expect(state.agents.a.costUsd).toBe(0.42)
  })

  it("records the turn's total cost from orchestration:complete", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: true,
        totalDuration: 10,
        agentResults: [],
        startTime: TS,
        endTime: TS,
        totalCostUsd: 1.23,
      },
    })
    expect(state.totalCostUsd).toBe(1.23)
  })

  it("keeps the total cost when a finished turn is snapshotted into history", () => {
    // A real turn, not the seeded turn 0: it carries a requirement, which is
    // what marks a turn as on screen — only such a turn is snapshotted.
    const base = { ...withAgents("a"), turn: 1, requirement: "first" }
    const done = reduceEvent(base, {
      type: "orchestration:complete",
      timestamp: TS,
      payload: {
        name: "demo",
        success: true,
        totalDuration: 10,
        agentResults: [],
        startTime: TS,
        endTime: TS,
        totalCostUsd: 1.23,
      },
    })
    const next = tuiReducer(done, {
      type: "turn:start",
      requirement: "again",
      agents: seedAgents(config()),
      leaderIds: ["leader"],
      startedAt: T0,
    })
    // `snapshot()` is written field by field; a missing field here would drop
    // the cost from every historical turn.
    expect(next.history[next.history.length - 1].totalCostUsd).toBe(1.23)
  })
})

describe("cancelled agents", () => {
  it("takes the status from the result, not from the event type", () => {
    // A cancelled run arrives on `agent:failed`; the status is what tells the
    // roster it was stopped rather than broken.
    const state = reduceEvent(withAgents("a"), {
      type: "agent:failed",
      timestamp: TS,
      payload: result("a", { status: "cancelled" }),
    })
    expect(state.agents.a.status).toBe("cancelled")
  })

  it("counts a cancelled agent as settled, so the turn does not stall at N-1", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "agent:failed",
      timestamp: TS,
      payload: result("a", { status: "cancelled" }),
    })
    expect(progress(state)).toEqual({ done: 1, total: 1 })
  })
})

describe("session ids", () => {
  it("copies an agent's session id from its result", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "agent:complete",
      timestamp: TS,
      payload: result("a", { sessionId: "sess-7" }),
    })
    expect(state.agents.a.sessionId).toBe("sess-7")
  })

  it("keeps the session id when a finished turn is snapshotted into history", () => {
    // A real turn, not the seeded turn 0: it carries a requirement, which is
    // what marks a turn as on screen — only such a turn is snapshotted.
    const base = { ...withAgents("a"), turn: 1, requirement: "first" }
    const done = reduceEvent(base, {
      type: "agent:complete",
      timestamp: TS,
      payload: result("a", { sessionId: "sess-7" }),
    })
    const next = tuiReducer(done, {
      type: "turn:start",
      requirement: "again",
      agents: seedAgents(config()),
      leaderIds: ["leader"],
      startedAt: T0,
    })

    // `snapshot()` carries `agents` wholesale, so the id rides along without the
    // snapshot needing a field of its own.
    expect(next.history[next.history.length - 1].agents.a.sessionId).toBe("sess-7")
  })

  it("leaves the session id off a failed agent", () => {
    const state = reduceEvent(withAgents("a"), {
      type: "agent:failed",
      timestamp: TS,
      payload: result("a", { status: "failed", error: "boom" }),
    })
    // A failed agent has no session to continue, so `/retry` re-runs it cold.
    expect(state.agents.a.sessionId).toBeUndefined()
  })
})
