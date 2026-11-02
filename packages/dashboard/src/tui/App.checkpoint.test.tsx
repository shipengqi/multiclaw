import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { MultiClawConfig } from "@multiclawcli/core"
import { runtimeRegistry } from "@multiclawcli/core"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { stripAnsi } from "./state"
import { driveFrame } from "./test-helpers"

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

const RUNTIME = "tui-checkpoint"

let workDir: string
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-checkpoint-"))
})
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe("App · checkpoint interaction", () => {
  beforeAll(() => {
    runtimeRegistry.register({
      name: RUNTIME,
      describe: alwaysAvailable(RUNTIME),
      async execute(task) {
        if (task.agentId === "leader") {
          return {
            output: '{"mode":"run","run":["architect","developer"],"reason":"design first"}',
            exitCode: 0,
          }
        }
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  function config(checkpointLabel?: string): MultiClawConfig {
    return {
      name: "checkpoint-team",
      workDir,
      leader: {
        id: "leader",
        name: "Leader",
        icon: "◆",
        runtime: RUNTIME,
        taskTitle: "plans the pipeline",
        systemPrompt: "",
        taskPrompt: "",
      },
      agents: [
        {
          id: "architect",
          name: "Architect",
          icon: "◇",
          runtime: RUNTIME,
          model: "sonnet-4",
          taskTitle: "designs the solution",
          systemPrompt: "",
          taskPrompt: "",
        },
        {
          id: "developer",
          name: "Developer",
          icon: "◇",
          runtime: RUNTIME,
          model: "sonnet-4",
          taskTitle: "writes the code",
          dependsOn: ["architect"],
          systemPrompt: "",
          taskPrompt: "",
        },
      ],
      checkpoints: [{ afterAgents: ["architect"], label: checkpointLabel }],
    }
  }

  it("lets a caller-provided onCheckpoint pass through and still finish the turn", async () => {
    let checkpointCalled = false
    const cfg = config("design review")
    cfg.onCheckpoint = async (info) => {
      checkpointCalled = true
      expect(info.label).toBe("design review")
      expect(info.completedAgents[0].id).toBe("architect")
      return { action: "continue" }
    }

    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })

    const frame = stripAnsi(
      await driveFrame(
        <App
          config={cfg}
          onTurnStart={(bus) => {
            bus.subscribe((event) => {
              if (event.type === "orchestration:complete") complete()
            })
          }}
        />,
        {
          keys: ["build a login page", "\r"],
          ready: finished,
          timeoutMs: 10000,
        }
      )
    )

    expect(checkpointCalled).toBe(true)
    expect(frame).toContain("Architect")
    expect(frame).toContain("Developer")
  })

  it("cancels the turn when the checkpoint handler returns cancel", async () => {
    const cfg = config()
    cfg.onCheckpoint = async () => ({ action: "cancel" })

    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })

    const frame = stripAnsi(
      await driveFrame(
        <App
          config={cfg}
          onTurnStart={(bus) => {
            bus.subscribe((event) => {
              if (event.type === "orchestration:complete") complete()
            })
          }}
        />,
        {
          keys: ["build a login page", "\r"],
          ready: finished,
          timeoutMs: 10000,
        }
      )
    )

    expect(frame).not.toContain("2/2")
    expect(frame).toContain("cancelled")
  })
})
