import type {
  AgentDefinition,
  AgentResult,
  MultiClawConfig,
  MultiClawEvent,
  StageInfo,
} from "@multiclawcli/core"
import { describe, expect, it } from "vitest"
import {
  type AgentView,
  agentElapsed,
  appendLog,
  createInitialState,
  initialState,
  leaderAgentIds,
  MAX_HISTORY,
  MAX_LOG_CHARS,
  progress,
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
        totalAgents: 2,
        stages: [stage(0, ["architect"]), stage(1, ["dev", "qa"])],
      },
    })

    expect(state.phase).toBe("running")
    expect(state.name).toBe("demo")
    expect(state.requirement).toBe("build it")
    expect(state.stages).toHaveLength(2)
    expect(Object.keys(state.agents).sort()).toEqual(["architect", "dev", "qa"])
    expect(state.agents.architect.status).toBe("pending")
    expect(state.agents.architect.logs).toBe("")
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

  it("caps how many turns it keeps, dropping the oldest", () => {
    const older = Array.from(
      { length: MAX_HISTORY },
      (_, i): TurnView => ({ ...initialState, turn: i + 1 })
    )
    const full: TuiState = { ...initialState, turn: MAX_HISTORY + 1, history: older }

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

    const scrolled = tuiReducer(opened, { type: "stream:scroll", delta: 2, viewport: 2 })

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
        agents: [agent("dev", { models: { claude: "opus" } }), agent("qa", { model: "haiku" })],
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
    const window = visibleLog(logged("1\n2\n3\n4\n5"), 2)
    expect(window.lines).toEqual(["4", "5"])
    expect(window.following).toBe(true)
    expect(window.scrolledBack).toBe(0)
  })

  it("scrolls back by whole lines", () => {
    const state = tuiReducer(logged("1\n2\n3\n4\n5"), {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
    })
    const window = visibleLog(state, 2)
    expect(window.lines).toEqual(["2", "3"])
    expect(window.scrolledBack).toBe(2)
    expect(window.following).toBe(false)
  })

  it("clamps at the tail, so scrolling past the end re-arms follow", () => {
    const state = logged("1\n2\n3\n4\n5")
    const up = tuiReducer(state, { type: "stream:scroll", delta: 2, viewport: 2 })
    const back = tuiReducer(up, { type: "stream:scroll", delta: -99, viewport: 2 })
    expect(back.scroll).toBe(0)
    expect(visibleLog(back, 2).following).toBe(true)
  })

  it("clamps at the head", () => {
    const state = logged("1\n2\n3\n4\n5")
    expect(tuiReducer(state, { type: "stream:scroll", delta: 99, viewport: 2 }).scroll).toBe(3)
  })

  it("is a no-op when there is nothing to scroll", () => {
    const state = logged("1\n2")
    expect(tuiReducer(state, { type: "stream:scroll", delta: 5, viewport: 10 })).toBe(state)
  })

  it("is empty when nothing is focused, or nothing has been written", () => {
    expect(visibleLog(initialState, 5).lines).toEqual([])
    expect(visibleLog(withAgents("a"), 5).lines).toEqual([])
  })

  it("re-clamps a parked offset when the pane is resized under it", () => {
    const state = tuiReducer(logged("1\n2\n3\n4\n5"), {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
    })
    expect(state.scroll).toBe(2)
    // The pane grew since the scroll, so the offset is re-clamped on read.
    expect(visibleLog(state, 5).scrolledBack).toBe(0)
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
    })
    expect(scrolled.scroll).toBe(2)
    expect(tuiReducer(scrolled, { type: "focus:set", agentId: "a" }).scroll).toBe(0)
    expect(tuiReducer(scrolled, { type: "focus:cycle", delta: 1 }).scroll).toBe(0)
  })

  it("returns the window to the tail when a new turn starts", () => {
    const scrolled = tuiReducer(reduceEvent(withAgents("a"), output("a", "1\n2\n3\n4\n5")), {
      type: "stream:scroll",
      delta: 2,
      viewport: 2,
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
