import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { turnsPath } from "./history"
import {
  interruptedTurn,
  journalTurn,
  loadJournal,
  MAX_JOURNAL_LOG_CHARS,
  restoreConsole,
  SESSION_VERSION,
  type SessionJournal,
  saveJournal,
  sessionPath,
} from "./session"
import { createInitialState, type LogSegment, type TurnView } from "./state"

const SID = "session-1"

let workDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-session-"))
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

/** A finished turn, shaped the way the console writes one to disk. */
function savedTurn(turn: number, requirement: string): TurnView {
  return {
    turn,
    phase: "complete",
    requirement,
    success: true,
    stages: [],
    agents: {},
    leaderIds: [],
    autoFollow: true,
    scroll: 0,
  }
}

function seedHistory(turns: TurnView[]): void {
  const target = turnsPath(workDir, SID)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${turns.map((turn) => JSON.stringify(turn)).join("\n")}\n`, "utf-8")
}

function seedJournal(value: unknown): void {
  const target = sessionPath(workDir, SID)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(value), "utf-8")
}

/** A journal entry for a turn that was still running. */
function inFlight(overrides: Partial<SessionJournal["inFlight"]> = {}) {
  return {
    turn: 2,
    requirement: "refactor the parser",
    startedAt: 1_000,
    savedAt: 2_500,
    leaderIds: ["leader"],
    stages: [],
    agents: {
      leader: {
        id: "leader",
        name: "Leader",
        status: "running",
        logs: [{ kind: "text" as const, text: "thinking" }],
      },
    },
    pending: { permissions: 1, questions: 0 },
    ...overrides,
  }
}

describe("session journal · on disk", () => {
  it("round-trips the turn in flight and the queue", async () => {
    await saveJournal(workDir, SID, {
      version: SESSION_VERSION,
      queue: ["add tests", "then document it"],
      inFlight: inFlight() as SessionJournal["inFlight"],
    })

    const loaded = loadJournal(workDir, SID)
    expect(loaded?.queue).toEqual(["add tests", "then document it"])
    expect(loaded?.inFlight?.requirement).toBe("refactor the parser")
    expect(loaded?.inFlight?.turn).toBe(2)
  })

  it("does not create a file for a session with nothing to remember", async () => {
    await saveJournal(workDir, SID, { version: SESSION_VERSION })
    expect(fs.existsSync(sessionPath(workDir, SID))).toBe(false)
  })

  it("clears an existing journal rather than leaving a stale turn behind", async () => {
    seedJournal({ version: SESSION_VERSION, inFlight: inFlight() })
    expect(loadJournal(workDir, SID)?.inFlight).toBeDefined()

    await saveJournal(workDir, SID, { version: SESSION_VERSION })

    // The file has to survive as "nothing in flight": deleting it would be
    // indistinguishable from a session that never had a journal, and the next
    // start could not tell the two apart.
    expect(fs.existsSync(sessionPath(workDir, SID))).toBe(true)
    expect(loadJournal(workDir, SID)?.inFlight).toBeUndefined()
  })

  it.each([
    ["missing file", undefined],
    ["malformed JSON", "{not json"],
    ["an unknown version", JSON.stringify({ version: SESSION_VERSION + 1 })],
    ["a non-object payload", JSON.stringify(["nope"])],
  ])("reads %s as no journal", (_label, raw) => {
    if (raw !== undefined) {
      fs.mkdirSync(path.dirname(sessionPath(workDir, SID)), { recursive: true })
      fs.writeFileSync(sessionPath(workDir, SID), raw, "utf-8")
    }
    expect(loadJournal(workDir, SID)).toBeUndefined()
  })

  it("drops a turn in flight that the panes could not render", () => {
    // Built as a raw literal on purpose: this is what a hand-edited or
    // future-version file looks like, and the type system would reject it.
    seedJournal({
      version: SESSION_VERSION,
      inFlight: {
        ...inFlight(),
        agents: { leader: { id: "leader", name: "Leader", status: "confused", logs: [] } },
      },
    })
    expect(loadJournal(workDir, SID)?.inFlight).toBeUndefined()
  })

  it("keeps the queue but drops non-string entries", () => {
    seedJournal({ version: SESSION_VERSION, queue: ["keep me", 7, "", "and me"] })
    expect(loadJournal(workDir, SID)?.queue).toEqual(["keep me", "and me"])
  })
})

describe("journalTurn · what gets written", () => {
  it("keeps only the tail of a long log, and marks that it was cut", () => {
    const state = createInitialState({
      name: "t",
      workDir,
      agents: [{ id: "dev", name: "Dev", systemPrompt: "", taskPrompt: "" }],
    })
    const longText = `${"x".repeat(MAX_JOURNAL_LOG_CHARS)}THE END`
    const longLogs: LogSegment[] = [{ kind: "text", text: longText }]
    const entry = journalTurn(
      {
        ...state,
        turn: 3,
        requirement: "do it",
        phase: "running",
        agents: { dev: { id: "dev", name: "Dev", status: "running", logs: longLogs } },
      },
      { permissions: 0, questions: 0 }
    )

    expect(entry.turn).toBe(3)
    expect(entry.requirement).toBe("do it")
    const devLogs = entry.agents.dev.logs
    const totalChars = devLogs.reduce((sum, s) => sum + s.text.length, 0)
    expect(totalChars).toBe(MAX_JOURNAL_LOG_CHARS + 1)
    expect(devLogs[0].text.startsWith("…")).toBe(true)
    expect(devLogs[devLogs.length - 1].text.endsWith("THE END")).toBe(true)
  })
})

describe("interruptedTurn · what a restart can honestly claim", () => {
  it("stops agents that never reported back and ends the turn at the last write", () => {
    const turn = interruptedTurn({
      ...(inFlight() as NonNullable<SessionJournal["inFlight"]>),
      agents: {
        leader: {
          id: "leader",
          name: "Leader",
          status: "running",
          logs: [{ kind: "text" as const, text: "thinking" }],
        },
        dev: {
          id: "dev",
          name: "Dev",
          status: "success",
          logs: [{ kind: "text" as const, text: "done" }],
          duration: 900,
        },
        qa: { id: "qa", name: "QA", status: "pending", logs: [] },
      },
      stages: [
        {
          stageIndex: 0,
          agents: [{ id: "dev", name: "Dev" }],
          outcome: "success",
          memberStatuses: { dev: "success" },
        },
      ],
    })

    expect(turn.phase).toBe("complete")
    expect(turn.interrupted).toBe(true)
    expect(turn.success).toBe(false)
    expect(turn.cancelled).toBeUndefined()
    // Nothing is running any more — a spinner for a process that died with the
    // console is the one thing this record must not do.
    expect(turn.agents.leader.status).toBe("cancelled")
    expect(turn.agents.qa.status).toBe("cancelled")
    // A finished agent keeps what it actually achieved.
    expect(turn.agents.dev.status).toBe("success")
    // The clock stops at the last write, not at whatever time the turn is read.
    expect(turn.endedAt).toBe(2_500)
    // Frozen stage outcomes are dropped so they are re-derived from the agents.
    expect(turn.stages[0].outcome).toBeUndefined()
  })
})

describe("restoreConsole · opening a session again", () => {
  it("opens empty when the session has nothing", () => {
    expect(restoreConsole(workDir, SID)).toEqual({
      history: [],
      queue: [],
      persistedTurn: 0,
      awaitingAnswer: false,
    })
  })

  it("adds the interrupted turn to the restored history and says so", () => {
    seedHistory([savedTurn(1, "first task")])
    seedJournal({ version: SESSION_VERSION, inFlight: inFlight(), queue: ["follow up"] })

    const restored = restoreConsole(workDir, SID)

    expect(restored.history.map((turn) => turn.turn)).toEqual([1, 2])
    expect(restored.history[1].interrupted).toBe(true)
    // The watermark excludes the journal-recovered turn — it is not on disk yet.
    expect(restored.persistedTurn).toBe(1)
    expect(restored.queue).toEqual(["follow up"])
    expect(restored.notice).toContain("turn 2 was interrupted by a restart")
    expect(restored.notice).toContain("1 pending decision discarded")
    expect(restored.notice).toContain("1 queued follow-up restored")
  })

  it("does not add a turn the log already holds", () => {
    // A restored turn is written to the log by the very next save, so a second
    // restart sees both the log and the journal describing it.
    seedHistory([savedTurn(1, "first task"), { ...savedTurn(2, "refactor"), interrupted: true }])
    seedJournal({ version: SESSION_VERSION, inFlight: inFlight() })

    const restored = restoreConsole(workDir, SID)

    expect(restored.history).toHaveLength(2)
    expect(restored.persistedTurn).toBe(2)
    expect(restored.notice).toBeUndefined()
  })

  it("ignores a journal that is behind the recorded history", () => {
    seedHistory([savedTurn(1, "a"), savedTurn(2, "b"), savedTurn(3, "c")])
    seedJournal({ version: SESSION_VERSION, inFlight: inFlight({ turn: 2 }) })

    const restored = restoreConsole(workDir, SID)

    expect(restored.history.map((turn) => turn.turn)).toEqual([1, 2, 3])
    expect(restored.persistedTurn).toBe(3)
    expect(restored.notice).toBeUndefined()
  })

  it("restores the open question and the turn watermark", () => {
    seedHistory([
      savedTurn(1, "old task"),
      {
        ...savedTurn(2, "which database?"),
        success: true,
        reply: { mode: "ask", message: "Postgres or SQLite?" },
      },
    ])
    seedJournal({ version: SESSION_VERSION })

    const restored = restoreConsole(workDir, SID)

    expect(restored.persistedTurn).toBe(2)
    expect(restored.awaitingAnswer).toBe(true)
  })

  it("does not treat an interrupted turn as a pending question", () => {
    seedHistory([savedTurn(1, "old task")])
    seedJournal({ version: SESSION_VERSION, inFlight: inFlight({ turn: 2 }) })

    expect(restoreConsole(workDir, SID).awaitingAnswer).toBe(false)
  })
})
