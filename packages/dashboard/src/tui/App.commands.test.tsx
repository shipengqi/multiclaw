import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { type AgentTask, type MultiClawConfig, runtimeRegistry } from "@multiclawcli/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { exportPath } from "./history"
import { listSessions } from "./sessions"
import { stripAnsi } from "./state"
import { driveFrame, removeWorkDir } from "./test-helpers"

const RUNTIME = "tui-command-flows"
let config: MultiClawConfig
let tasks: AgentTask[]
let completed: number
let finish: () => void
let ready: Promise<void>
let failures: Set<string>

beforeEach(() => {
  tasks = []
  completed = 0
  failures = new Set()
  ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  config = {
    name: "command-team",
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-commands-")),
    useLeader: false,
    agents: [
      {
        id: "worker",
        name: "Worker",
        runtime: RUNTIME,
        systemPrompt: "",
        taskPrompt: "{{requirement}}",
      },
    ],
  }
  runtimeRegistry.register({
    name: RUNTIME,
    describe: async () => ({
      name: RUNTIME,
      available: true,
      capabilities: {
        streaming: true,
        sessions: false,
        resume: false,
        permissions: false,
        models: false,
        images: false,
        usage: false,
        cost: false,
        sandbox: false,
      },
    }),
    async execute(task) {
      tasks.push(task)
      task.onEvent?.({
        runId: "test",
        agentId: task.agentId,
        seq: 0,
        type: "message_delta",
        role: "agent",
        text: "needle first\nspacer\nneedle second\nend\n",
      })
      const failed = failures.delete(task.agentId)
      return { output: failed ? "failed" : "done", exitCode: failed ? 1 : 0 }
    },
  })
})

afterEach(() => removeWorkDir(config.workDir))

function view() {
  return (
    <App
      config={config}
      onTurnStart={(bus) => {
        bus.subscribe((event) => {
          if (event.type === "orchestration:complete") {
            completed += 1
            finish()
          }
        })
      }}
    />
  )
}

async function run(thenKeys: string[]) {
  return stripAnsi(
    await driveFrame(view(), { keys: ["first task", "\r"], ready, thenKeys, settleMs: 150 })
  )
}

describe("App · retained command flows", () => {
  it("creates an empty session without running a requirement", async () => {
    const frame = await run(["/new", "\r"])
    expect(tasks).toHaveLength(1)
    expect(listSessions(config.workDir)).toHaveLength(2)
    expect(frame).toContain("turn 0")
    expect(frame).toContain("new session")
    expect(frame).not.toContain("first task")
  })

  it("chooses a permission mode and applies it to the next turn", async () => {
    await driveFrame(view(), { keys: ["/mode", "\r", "\u001b[B", "\r", "work", "\r"], ready })
    expect(tasks[0].permissionMode).toBe("auto")
  })

  it("reaches agents beyond the first selector window", async () => {
    config.agents = Array.from({ length: 12 }, (_, index) => ({
      id: `worker-${index}`,
      name: `Worker ${index}`,
      runtime: RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    }))
    const frame = stripAnsi(
      await driveFrame(view(), {
        keys: ["/focus", "\r", ...Array.from({ length: 11 }, () => "\u001b[B"), "\r"],
      })
    )
    expect(frame).toContain("focused worker-11")
    expect(tasks).toHaveLength(0)
  })

  it("searches from the menu and navigates both matches", async () => {
    const frame = await run(["/search", "\r", "needle", "\r", "\u0010"])
    expect(frame).toContain("match 1/2")
    expect(frame).not.toContain("usage:")
    expect(tasks).toHaveLength(1)
  })

  it("reports no match and does not submit a search as work", async () => {
    const frame = await run(["/search", "\r", "missing", "\r"])
    expect(frame).toContain("no matches for missing")
    expect(tasks).toHaveLength(1)
  })

  it("replays the selected turn through the selector", async () => {
    await run(["/replay", "\r", "\r"])
    expect(tasks).toHaveLength(2)
    expect(tasks[1].prompt).toBe(tasks[0].prompt)
    expect(tasks[1].prompt).toContain("first task")
    expect(completed).toBe(2)
  })

  it("edits a selected requirement without starting a turn", async () => {
    const frame = await run(["/edit", "\r", "\r"])
    expect(frame).toContain("› first task")
    expect(tasks).toHaveLength(1)
  })

  it("exports the selected turn to its default file", async () => {
    await run(["/export", "\r", "\r"])
    const session = listSessions(config.workDir)[0]
    expect(fs.readFileSync(exportPath(config.workDir, session.id, 1), "utf8")).toContain(
      "first task"
    )
  })

  it("retries a failed agent selected from the menu", async () => {
    failures.add("worker")
    await run(["/retry", "\r", "\u001b[B", "\r"])
    expect(tasks.map((task) => task.agentId)).toEqual(["worker", "worker"])
    expect(completed).toBe(2)
  })

  it("retries the last failed turn after restoring a saved session", async () => {
    failures.add("worker")
    await run([])
    const frame = stripAnsi(
      await driveFrame(view(), { keys: ["/retry", "\r", "\u001b[B", "\r"], settleMs: 150 })
    )
    expect(tasks).toHaveLength(2)
    expect(completed).toBe(2)
    expect(frame).not.toContain("nothing failed")
  })

  it("cancels a selector without changing settings or starting work", async () => {
    const frame = stripAnsi(
      await driveFrame(view(), { keys: ["/mode", "\r", "\u001b[B", "\u001b"], settleMs: 250 })
    )
    expect(frame).toContain("· ask")
    expect(frame).not.toContain("choose mode")
    expect(tasks).toHaveLength(0)
  })

  it("treats removed commands as unknown", async () => {
    const frame = stripAnsi(await driveFrame(view(), { keys: ["/answer obsolete", "\r"] }))
    expect(frame).toContain("unknown command: /answer")
    expect(tasks).toHaveLength(0)
  })
})
