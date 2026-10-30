import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { MultiClawConfig } from "@multiclawcli/core"
import { runtimeRegistry } from "@multiclawcli/core"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { historyPath } from "./history"
import { stripAnsi, type TurnView } from "./state"
import { driveFrame } from "./test-helpers"

const RUNTIME = "tui-integration-history"

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
    stages: [],
    agents: {},
    leaderIds: [],
    autoFollow: true,
    scroll: 0,
  }
}

function seedHistory(turns: TurnView[]): void {
  const target = historyPath(workDir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(turns), "utf-8")
}

/** Poll a predicate, so a test never races the effect's asynchronous write. */
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
      if (task.agentId === "leader") {
        return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
      }
      return { output: `${task.agentId} finished`, exitCode: 0 }
    },
  })
})

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-app-history-"))
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe("App · remembering turns across sessions", () => {
  // The whole point of T9: a restart shows what the last session did, instead of
  // a console that has forgotten every turn.
  it("lists turns restored from disk when /history is opened", async () => {
    seedHistory([savedTurn(1, "restored task")])

    const frame = stripAnsi(
      await driveFrame(<App config={config()} />, { keys: ["/history", "\r"], settleMs: 200 })
    )

    expect(frame).toContain("restored task")
    expect(frame).toContain("1 earlier")
  })

  it.each([
    ["approved", "approved"],
    ["changes_required", "changes required"],
    ["failed", "acceptance failed"],
    ["cancelled", "acceptance cancelled"],
  ] as const)("shows acceptance %s in restored history", async (status, label) => {
    seedHistory([
      {
        ...savedTurn(1, "reviewed task"),
        success: status === "approved",
        acceptance: { status, reviewer: "qa", repairRounds: 1, reviews: [] },
      },
    ])
    const frame = stripAnsi(
      await driveFrame(<App config={config()} />, { keys: ["/history", "\r"], settleMs: 200 })
    )
    expect(frame).toContain(label)
    expect(frame).not.toContain("· done")
    if (status === "changes_required") expect(frame).not.toContain("· failed")
  })

  it("keeps a cancelled execution distinct from failed history", async () => {
    seedHistory([{ ...savedTurn(1, "stopped task"), cancelled: true, success: false }])
    const frame = stripAnsi(
      await driveFrame(<App config={config()} />, { keys: ["/history", "\r"], settleMs: 200 })
    )
    expect(frame).toContain("cancelled")
    expect(frame).not.toContain("· failed")
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

    const target = historyPath(workDir)
    await until(() => fs.existsSync(target))

    const turns = JSON.parse(fs.readFileSync(target, "utf-8")) as TurnView[]
    expect(turns.some((t) => t.requirement === "persist me" && t.phase === "complete")).toBe(true)
  })
})
