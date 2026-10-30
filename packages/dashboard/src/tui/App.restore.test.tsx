import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { MultiClawConfig } from "@multiclawcli/core"
import { runtimeRegistry } from "@multiclawcli/core"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { historyPath } from "./history"
import { loadJournal, SESSION_VERSION, sessionPath } from "./session"
import { stripAnsi, type TurnView } from "./state"
import { driveFrame } from "./test-helpers"

const RUNTIME = "tui-integration-restore"

/** `describe()` for a fake runtime: present, but claiming no capabilities. */
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

/** A fresh temp workspace per test, so nothing leaks into the repo. */
let workDir: string
/** Every prompt the runtime was asked to run, so "did anything run" is provable. */
let prompts: string[] = []
/** Per-execution delay, so a turn can be caught mid-flight. */
let delayMs = 0

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

/** A journal entry for a turn that was still running when the console stopped. */
function inFlight(turn: number, requirement: string) {
  const now = Date.now()
  return {
    turn,
    requirement,
    startedAt: now - 1000,
    savedAt: now,
    leaderIds: ["leader"],
    stages: [],
    agents: { leader: { id: "leader", name: "Leader", status: "running", logs: "working" } },
    pending: { permissions: 0, questions: 0 },
  }
}

function seedHistory(turns: TurnView[]): void {
  const target = historyPath(workDir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(turns), "utf-8")
}

function seedJournal(value: unknown): void {
  const target = sessionPath(workDir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(value), "utf-8")
}

/** Poll a predicate, so a test never races an effect's asynchronous write. */
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

beforeAll(() => {
  runtimeRegistry.register({
    name: RUNTIME,
    describe: alwaysAvailable(RUNTIME),
    async execute(task) {
      prompts.push(task.prompt)
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (task.agentId === "leader") {
        return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
      }
      return { output: `${task.agentId} finished`, exitCode: 0 }
    },
  })
})

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-app-restore-"))
  prompts = []
  delayMs = 0
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe("App · picking the session back up after a restart", () => {
  it("opens saying what the previous session left behind", async () => {
    seedHistory([savedTurn(1, "first task")])
    seedJournal({
      version: SESSION_VERSION,
      queue: ["add tests"],
      inFlight: inFlight(2, "refactor the parser"),
    })

    const frame = stripAnsi(await driveFrame(<App config={config()} />, { settleMs: 200 }))

    expect(frame).toContain("turn 2 was interrupted by a restart")
    expect(frame).toContain("1 queued follow-up restored")
    // Restored follow-ups do not start themselves: the user was not watching.
    expect(prompts).toEqual([])
  })

  it("lists the interrupted turn as a turn, not a hole in the history", async () => {
    seedHistory([savedTurn(1, "first task")])
    seedJournal({ version: SESSION_VERSION, inFlight: inFlight(2, "refactor the parser") })

    const frame = stripAnsi(
      await driveFrame(<App config={config()} />, { keys: ["/history", "\r"], settleMs: 250 })
    )

    expect(frame).toContain("refactor the parser")
    expect(frame).toContain("interrupted")
    expect(frame).toContain("2 earlier")
  })

  it("runs the restored queue only when the user resumes it", async () => {
    seedJournal({ version: SESSION_VERSION, queue: ["follow up"] })

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
      { keys: ["/continue", "\r"], ready: finished, settleMs: 200 }
    )

    expect(prompts.some((prompt) => prompt.includes("follow up"))).toBe(true)
  })

  it("journals a running turn, and clears it once the turn ends", async () => {
    delayMs = 150
    let captured: string | undefined
    const seen = (async () => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const requirement = loadJournal(workDir)?.inFlight?.requirement
        if (requirement === "persist me") {
          captured = requirement
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
    })()

    await driveFrame(<App config={config()} />, {
      keys: ["persist me", "\r"],
      ready: seen,
      settleMs: 300,
    })

    expect(captured).toBe("persist me")
    // A finished turn must not come back as "interrupted" next time.
    await until(() => loadJournal(workDir)?.inFlight === undefined)
    expect(loadJournal(workDir)?.inFlight).toBeUndefined()
  })
})
