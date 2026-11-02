import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { EventBus, MultiClawConfig } from "@multiclawcli/core"
import { runtimeRegistry } from "@multiclawcli/core"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { turnsPath } from "./history"
import { createSession, latestSession, listSessions, touchSession } from "./sessions"
import { stripAnsi, type TurnView } from "./state"
import { driveFrame } from "./test-helpers"

const RUNTIME = "tui-integration-picker"
const DOWN = "\u001b[B"

function alwaysAvailable(name: string) {
  return async () => ({
    name,
    available: true,
    capabilities: {
      streaming: false,
      sessions: false,
      resume: false,
      permissions: false,
      tools: false,
      models: false,
      images: false,
      usage: false,
      cost: false,
      sandbox: false,
    },
  })
}

let workDir: string
/** The session id each agent was launched with, per test — proves a resume. */
let seenSessionIds: Record<string, string | undefined> = {}
/** A monotonic clock so the most recently seeded session is always the newest. */
let clock = 0

function config(): MultiClawConfig {
  return {
    name: "dev-team",
    workDir,
    leader: { id: "leader", name: "Leader", runtime: RUNTIME, systemPrompt: "", taskPrompt: "" },
    agents: [
      { id: "architect", name: "Architect", runtime: RUNTIME, systemPrompt: "", taskPrompt: "" },
    ],
  }
}

function turn(n: number, patch: Partial<TurnView> = {}): TurnView {
  return {
    turn: n,
    phase: "complete",
    requirement: `req ${n}`,
    stages: [],
    agents: {},
    leaderIds: [],
    autoFollow: true,
    scroll: 0,
    ...patch,
  }
}

/** Create a session, seed its turn log + index summary, return its id. */
function seedSession(turns: TurnView[]): string {
  const { id } = createSession(workDir)
  if (turns.length > 0) {
    const target = turnsPath(workDir, id)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${turns.map((t) => JSON.stringify(t)).join("\n")}\n`, "utf-8")
  }
  const title = turns.find((t) => t.requirement)?.requirement
  touchSession(workDir, id, {
    lastActiveAt: ++clock,
    turnCount: turns[turns.length - 1]?.turn ?? 0,
    ...(title ? { title } : {}),
  })
  return id
}

function completion() {
  let resolve: () => void = () => {}
  const ready = new Promise<void>((done) => {
    resolve = done
  })
  const onTurnStart = (bus: EventBus) => {
    bus.subscribe((event) => {
      if (event.type === "orchestration:complete") resolve()
    })
  }
  return { ready, onTurnStart }
}

beforeAll(() => {
  runtimeRegistry.register({
    name: RUNTIME,
    describe: alwaysAvailable(RUNTIME),
    async execute(task) {
      seenSessionIds[task.agentId] = task.sessionId
      if (task.agentId === "leader") {
        return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
      }
      return { output: `${task.agentId} finished`, exitCode: 0 }
    },
  })
})

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-app-picker-"))
  seenSessionIds = {}
  clock = 0
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe("App · the session picker", () => {
  it("lists every session, marking the current one", async () => {
    seedSession([turn(1, { requirement: "alpha task" })])
    seedSession([turn(1, { requirement: "beta task" })]) // newest → current

    const frame = stripAnsi(
      await driveFrame(<App config={config()} />, { keys: ["/sessions", "\r"], settleMs: 200 })
    )

    expect(frame).toContain("SESSIONS")
    expect(frame).toContain("alpha task")
    expect(frame).toContain("beta task")
    expect(frame).toContain("current")
  })

  it("switches to an older session and continues its agent sessions", async () => {
    // The older session's architect left a runtime session behind.
    seedSession([
      turn(1, {
        requirement: "design the thing",
        agents: {
          architect: {
            id: "architect",
            name: "Architect",
            status: "success",
            sessionId: "sess-A",
            logs: [],
          },
        },
      }),
    ])
    seedSession([turn(1, { requirement: "current session" })]) // newest → current on open

    const done = completion()
    await driveFrame(<App config={config()} onTurnStart={done.onTurnStart} />, {
      // Open the picker, move down onto the older session, switch to it.
      keys: ["/sessions", "\r", DOWN, "\r"],
      // Give the async switch a moment to arm the continuation before typing.
      ready: new Promise((resolve) => setTimeout(resolve, 80)),
      thenKeys: ["next step", "\r"],
      thenReady: done.ready,
      settleMs: 200,
    })

    // Resuming the session continued the architect's conversation rather than
    // starting it cold.
    expect(seenSessionIds.architect).toBe("sess-A")
  })

  it("deletes the session under the cursor with d", async () => {
    const olderId = seedSession([turn(1, { requirement: "alpha task" })])
    const currentId = seedSession([turn(1, { requirement: "beta task" })])

    await driveFrame(<App config={config()} />, {
      // Open the picker, move onto the older session, delete it.
      keys: ["/sessions", "\r", DOWN, "d"],
      settleMs: 200,
    })

    const left = listSessions(workDir).map((s) => s.id)
    expect(left).toEqual([currentId])
    expect(left).not.toContain(olderId)
    // The surviving session is still the one the console is attached to.
    expect(latestSession(workDir)?.id).toBe(currentId)
  })
})

describe("App · launch options", () => {
  it("--new starts a fresh session instead of continuing the latest", async () => {
    const existingId = seedSession([turn(1, { requirement: "existing task" })])

    const frame = stripAnsi(
      await driveFrame(<App config={config()} initialSession={{ kind: "new" }} />, {
        settleMs: 150,
      })
    )

    // A brand-new, empty session — the old one's work is not on screen.
    expect(frame).not.toContain("existing task")
    const ids = listSessions(workDir).map((s) => s.id)
    expect(ids).toHaveLength(2)
    expect(latestSession(workDir)?.id).not.toBe(existingId)
  })

  it("resume by id opens that session, not the most recent", async () => {
    const olderId = seedSession([turn(1, { requirement: "the older task" })])
    seedSession([turn(1, { requirement: "the newest task" })]) // latest by default

    const frame = stripAnsi(
      await driveFrame(<App config={config()} initialSession={{ kind: "resume", id: olderId }} />, {
        settleMs: 150,
      })
    )

    // The resumed session's requirement appears in the stream panel's turn-divider row.
    expect(frame).toContain("the older task")
    expect(frame).not.toContain("the newest task")
  })

  it("resume with an unknown id falls back to the latest and says so", async () => {
    seedSession([turn(1, { requirement: "the newest task" })])

    const frame = stripAnsi(
      await driveFrame(
        <App config={config()} initialSession={{ kind: "resume", id: "does-not-exist" }} />,
        { settleMs: 150 }
      )
    )

    expect(frame).toContain("not found")
  })

  it("resume with no id opens the picker on launch", async () => {
    seedSession([turn(1, { requirement: "pick me" })])

    const frame = stripAnsi(
      await driveFrame(<App config={config()} initialSession={{ kind: "resume" }} />, {
        settleMs: 150,
      })
    )

    expect(frame).toContain("SESSIONS")
    expect(frame).toContain("pick me")
  })
})
