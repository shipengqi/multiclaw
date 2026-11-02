import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AgentResult, WorkContext } from "@multiclawcli/core"
import { afterEach, describe, expect, it } from "vitest"
import { appendTurns, formatTurnMarkdown, loadTurns } from "./history"
import { interruptedTurn, journalTurn, loadJournal, saveJournal } from "./session"
import {
  createInitialState,
  latestWorkFromTurns,
  reduceEvent,
  type TuiState,
  type TurnView,
} from "./state"
import { makeSessionRecord } from "./test-helpers"

const work: WorkContext = {
  id: "work-api",
  originalRequirement: "Build API",
  requirement: "Build API with SQLite",
  agents: [
    {
      agentId: "dev",
      scope: "API",
      session: makeSessionRecord({ sessionId: "dev-session", agentId: "dev", workId: "work-api" }),
    },
  ],
  outcome: { execution: "success", completedAgents: ["dev"], failedAgents: [] },
}
const audit: AgentResult[] = [
  {
    agentId: "dev",
    agentName: "Dev",
    status: "handed_back",
    handoffReason: "UI work needs another role",
    output: "investigated",
    startTime: "2026-11-02T00:00:00Z",
    endTime: "2026-11-02T00:00:01Z",
    duration: 1,
    attempts: 1,
    session: makeSessionRecord({ sessionId: "dev-session", agentId: "dev", workId: "work-api" }),
  },
]
const turn = (n: number, patch: Partial<TurnView> = {}): TurnView => ({
  turn: n,
  phase: "complete",
  stages: [],
  agents: {},
  leaderIds: [],
  scroll: 0,
  autoFollow: false,
  ...patch,
})
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-routing-"))
  dirs.push(dir)
  return dir
}

describe("routing persistence", () => {
  it("keeps latest work across reply and ask turns", () => {
    expect(
      latestWorkFromTurns([
        turn(1, { work }),
        turn(2, { reply: { mode: "reply", message: "explained" } }),
        turn(3, { reply: { mode: "ask", message: "which API?" } }),
      ])
    ).toEqual(work)
  })
  it("does not infer missing ownership or fall back across newer cancelled work", () => {
    const stage = { stageIndex: 0, agents: [{ id: "dev", name: "Dev" }] }
    expect(latestWorkFromTurns([turn(1, { work }), turn(2, { stages: [stage] })])).toBeUndefined()
    expect(
      latestWorkFromTurns([
        turn(1, { work }),
        turn(2, { work: { ...work, id: "new" }, cancelled: true }),
      ])
    ).toBeUndefined()
  })
  it("keeps an unfinished rerouting ask as the latest target", () => {
    const newer = {
      ...work,
      id: "new",
      outcome: {
        execution: "failed" as const,
        completedAgents: [],
        failedAgents: [{ agentId: "dev", reason: "handed back" }],
      },
    }
    expect(
      latestWorkFromTurns([
        turn(1, { work }),
        turn(2, { work: newer, reply: { mode: "ask", message: "Who can do this?" } }),
      ])?.id
    ).toBe("new")
  })
  it("round-trips work, routing and all attempts alongside question turns", async () => {
    const dir = tempDir()
    const entry = turn(2, {
      work,
      routing: { mode: "continue", workId: work.id, reroutes: 1 },
      agentResults: audit,
    })
    await appendTurns(dir, "session", [turn(1), entry])
    expect(loadTurns(dir, "session")).toEqual([turn(1), entry])
    const markdown = formatTurnMarkdown(entry)
    expect(markdown).toContain("Type: continue")
    expect(markdown).toContain("Work: work-api")
    expect(markdown).toContain("dev: handed_back — UI work needs another role")
  })
  it("restores interrupted work with reliable completed Session IDs and audit", async () => {
    const dir = tempDir()
    const state = {
      ...createInitialState({ name: "routing", workDir: dir, agents: [] }),
      turn: 2,
      phase: "running" as const,
      work,
      routing: { mode: "continue" as const, workId: work.id, reroutes: 1 },
      agentResults: audit,
    }
    const entry = journalTurn(state, { permissions: 0, questions: 0 })
    await saveJournal(dir, "session", { version: 1, inFlight: entry })
    const loaded = loadJournal(dir, "session")
    expect(loaded?.inFlight?.work).toEqual(work)
    const restored = interruptedTurn(loaded?.inFlight ?? entry)
    expect(restored.agentResults).toEqual(audit)
    expect(latestWorkFromTurns([restored])?.outcome?.execution).toBe("interrupted")
    expect(latestWorkFromTurns([restored])?.agents[0].session?.sessionId).toBe("dev-session")
  })
})

describe("Session persistence", () => {
  const initial = (): TuiState => ({
    ...createInitialState({ name: "sessions", workDir: "/tmp", agents: [] }),
    turn: 1,
    phase: "running" as const,
    work: structuredClone(work),
    agents: { dev: { id: "dev", name: "Dev", status: "running" as const, logs: [] } },
  })
  it("persists an opened Session before a worker result and restores its state as unknown", async () => {
    const dir = tempDir()
    const record = makeSessionRecord({
      bindingId: "opened",
      sessionId: "opened-id",
      agentId: "dev",
      workId: work.id,
      state: "running",
    })
    const payload = { action: "created" as const, executionId: "execution", attempt: 1, record }
    const state = reduceEvent(initial(), {
      type: "agent:session",
      timestamp: record.observedAt,
      payload,
    })
    await saveJournal(dir, "console", {
      version: 1,
      inFlight: journalTurn(state, { permissions: 0, questions: 0 }),
    })
    const restored = interruptedTurn(loadJournal(dir, "console")!.inFlight!)
    expect(restored.agents.dev.session).toMatchObject({
      sessionId: "opened-id",
      bindingId: "opened",
      state: "unknown",
    })
    expect(restored.work?.agents[0].session).toMatchObject({
      workId: work.id,
      sessionId: "opened-id",
      state: "unknown",
    })
    expect(restored.sessionEvents).toEqual([payload])
    expect(restored.agentResults).toBeUndefined()
  })
  it("keeps late closure on its historical binding without replacing the current Session", () => {
    const old = makeSessionRecord({ agentId: "dev", workId: work.id, bindingId: "old" })
    const current = makeSessionRecord({ agentId: "dev", workId: "new-work", bindingId: "new" })
    const state = initial()
    state.work = { ...work, id: "new-work", agents: [{ agentId: "dev", session: current }] }
    state.agents.dev = { ...state.agents.dev, session: current }
    state.history = [
      turn(1, {
        work: { ...work, agents: [{ agentId: "dev", session: old }] },
        agents: { dev: { ...state.agents.dev, session: old } },
      }),
    ]
    const closed = { ...old, state: "closed" as const }
    const next = reduceEvent(state, {
      type: "agent:session",
      timestamp: old.observedAt,
      payload: { action: "closed", executionId: "old-execution", attempt: 1, record: closed },
    })
    expect(next.agents.dev.session).toEqual(current)
    expect(next.history[0].work?.agents[0].session?.state).toBe("closed")
    expect(next.history[0].agents.dev.session?.state).toBe("closed")
    const sameWork = {
      ...next,
      work: { ...work, agents: [{ agentId: "dev", session: { ...current, workId: work.id } }] },
    }
    expect(
      reduceEvent(sameWork, {
        type: "agent:session",
        timestamp: old.observedAt,
        payload: { action: "closed", executionId: "old-execution", attempt: 1, record: closed },
      }).agents.dev.session
    ).toEqual(current)
  })
  it("rejects corrupted lifecycle records before history rendering", async () => {
    const dir = tempDir()
    const invalid = { ...turn(1), sessionEvents: [null] } as unknown as TurnView
    await appendTurns(dir, "console", [invalid])
    expect(loadTurns(dir, "console")).toEqual([])
    const entry = {
      ...journalTurn(initial(), { permissions: 0, questions: 0 }),
      sessionEvents: [null],
    }
    await saveJournal(dir, "console", { version: 1, inFlight: entry as never })
    expect(loadJournal(dir, "console")?.inFlight).toBeUndefined()
  })
})
