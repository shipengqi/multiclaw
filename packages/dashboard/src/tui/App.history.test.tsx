import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { MultiClawConfig } from "@multiclawcli/core"
import { runtimeRegistry } from "@multiclawcli/core"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { turnsPath } from "./history"
import { createSession, latestSession } from "./sessions"
import { stripAnsi, type TurnView } from "./state"
import { driveFrame, removeWorkDir } from "./test-helpers"

const RUNTIME = "tui-integration-history"

function alwaysAvailable(name: string) {
  return async () => ({
    name,
    available: true,
    capabilities: {
      streaming: false,
      sessions: false,
      resume: false,
      permissions: false,
      models: false,
      images: false,
      usage: false,
      cost: false,
      sandbox: false,
    },
  })
}

let workDir: string
let seenSessionIds: Record<string, string | undefined> = {}

function config(): MultiClawConfig {
  return {
    name: "dev-team",
    workDir,
    leader: {
      id: "leader",
      name: "Leader",
      runtime: RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    },
    agents: [
      {
        id: "architect",
        name: "Architect",
        runtime: RUNTIME,
        systemPrompt: "",
        taskPrompt: "",
      },
    ],
  }
}

function savedTurn(turn: number, requirement: string): TurnView {
  return {
    turn,
    phase: "complete",
    requirement,
    stages: [],
    agents: {},
    leaderIds: [],
    autoFollow: true,
    scroll: 0,
  }
}

function seedSession(turns: TurnView[]): string {
  const { id } = createSession(workDir)
  const target = turnsPath(workDir, id)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${turns.map((turn) => JSON.stringify(turn)).join("\n")}\n`, "utf-8")
  return id
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-app-history-"))
  seenSessionIds = {}
})

afterEach(() => {
  removeWorkDir(workDir)
})

describe("App · remembering turns across sessions", () => {
  it("shows the last turn when a session is resumed by id", async () => {
    const id = seedSession([savedTurn(1, "restored task")])

    const frame = stripAnsi(
      await driveFrame(<App config={config()} initialSession={{ kind: "resume", id }} />, {
        settleMs: 200,
      })
    )

    // The requirement appears in the stream panel's turn-divider row.
    expect(frame).toContain("restored task")
  })

  it.each([
    ["approved", "approved"],
    ["changes_required", "changes required"],
    ["failed", "acceptance failed"],
    ["cancelled", "acceptance cancelled"],
  ] as const)(
    "shows the requirement in the stream when resumed with acceptance %s",
    async (status, _label) => {
      const id = seedSession([
        {
          ...savedTurn(1, "reviewed task"),
          success: status === "approved",
          acceptance: { status, reviewer: "qa", repairRounds: 1, reviews: [] },
        },
      ])
      const frame = stripAnsi(
        await driveFrame(<App config={config()} initialSession={{ kind: "resume", id }} />, {
          settleMs: 200,
        })
      )
      // The requirement appears in the stream panel's turn-divider row.
      expect(frame).toContain("reviewed task")
    }
  )

  it("keeps a cancelled execution distinct from failed in the opened turn", async () => {
    const id = seedSession([{ ...savedTurn(1, "stopped task"), cancelled: true, success: false }])
    const frame = stripAnsi(
      await driveFrame(<App config={config()} initialSession={{ kind: "resume", id }} />, {
        settleMs: 200,
      })
    )
    expect(frame).toContain("stopped task")
  })

  it("writes a finished turn to disk so the next session can restore it", async () => {
    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })

    await driveFrame(
      <App
        config={config()}
        onTurnStart={(bus) => {
          bus.subscribe((event) => {
            if (event.type === "orchestration:complete") complete()
          })
        }}
      />,
      { keys: ["persist me", "\r"], ready: finished, settleMs: 300 }
    )

    const id = latestSession(workDir)?.id
    expect(id).toBeDefined()
    const target = turnsPath(workDir, id as string)
    await until(() => fs.existsSync(target))

    const turns = fs
      .readFileSync(target, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line)) as TurnView[]
    expect(turns.some((t) => t.requirement === "persist me" && t.phase === "complete")).toBe(true)
  })

  it("continues the most recent turn's sessions automatically when resumed", async () => {
    const id = seedSession([
      {
        ...savedTurn(1, "design the thing"),
        agents: {
          architect: {
            id: "architect",
            name: "Architect",
            status: "success",
            sessionId: "sess-1",
            logs: [],
          },
        },
      },
    ])
    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })

    await driveFrame(
      <App
        config={config()}
        initialSession={{ kind: "resume", id }}
        onTurnStart={(bus) => {
          bus.subscribe((event) => {
            if (event.type === "orchestration:complete") complete()
          })
        }}
      />,
      { keys: ["next step", "\r"], ready: finished, settleMs: 200 }
    )

    expect(seenSessionIds.architect).toBe("sess-1")
  })
})
