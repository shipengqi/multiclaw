import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agents, type OrchestratorResult, runtimeRegistry } from "@multiclawcli/core"
import { expect, it } from "vitest"
import { App } from "./App"
import { formatTurnMarkdown, loadTurns } from "./history"
import { latestSession } from "./sessions"
import { stripAnsi } from "./state"
import { driveFrame, removeWorkDir } from "./test-helpers"

it("retries a rejected pipeline gate and persists the multi-reviewer audit", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "multiclaw-tui-gates-"))
  const runtime = "tui-gate-retry"
  const calls: string[] = []
  const completed: OrchestratorResult[] = []
  let tests = 0
  let firstDone = () => {}
  let secondDone = () => {}
  const first = new Promise<void>((resolve) => {
    firstDone = resolve
  })
  const second = new Promise<void>((resolve) => {
    secondDone = resolve
  })
  runtimeRegistry.register({
    name: runtime,
    describe: async () => ({
      name: runtime,
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
    }),
    execute: async (task) => {
      calls.push(task.agentId)
      if (task.agentId === "leader")
        return {
          exitCode: 0,
          output: '{"mode":"run","run":["backend-developer","tester","code-reviewer"]}',
        }
      if (task.agentId === "backend-developer") return { exitCode: 0, output: "updated backend" }
      const approved = task.agentId !== "tester" || ++tests > 2
      return {
        exitCode: 0,
        output: JSON.stringify({
          verdict: approved ? "approved" : "changes_required",
          summary: approved ? "Verified" : "Fix API",
          issues: approved ? [] : ["backend-developer: wrong API response"],
        }),
      }
    },
  })
  try {
    const frame = await driveFrame(
      <App
        config={{
          name: "gate-team",
          workDir,
          leader: agents.leader({ runtime }),
          agents: [
            agents.backendDeveloper({ runtime }),
            agents.tester({ runtime, dependsOn: ["backend-developer"] }),
            agents.codeReviewer({ runtime, dependsOn: ["tester"] }),
          ],
          reviewGates: [
            { reviewer: "tester", repairAgents: ["backend-developer"], maxRepairRounds: 1 },
            {
              reviewer: "code-reviewer",
              repairAgents: ["backend-developer", "tester"],
              maxRepairRounds: 1,
            },
          ],
        }}
        onTurnStart={(bus) =>
          bus.subscribe((event) => {
            if (event.type !== "orchestration:complete") return
            completed.push(event.payload)
            if (completed.length === 1) setTimeout(firstDone, 120)
            else secondDone()
          })
        }
      />,
      {
        keys: ["build the API", "\r"],
        ready: first,
        thenKeys: ["/retry tester", "\r"],
        thenReady: second,
      }
    )
    expect(completed).toHaveLength(2)
    expect(completed[0].success).toBe(false)
    expect(completed[1].success).toBe(true)
    expect(calls).toEqual([
      "leader",
      "backend-developer",
      "tester",
      "backend-developer",
      "tester",
      "backend-developer",
      "tester",
      "code-reviewer",
    ])
    expect(stripAnsi(frame)).toContain("delivery approved")
    const session = latestSession(workDir)
    expect(session).toBeDefined()
    if (!session) throw new Error("Missing persisted session")
    const turns = loadTurns(workDir, session.id)
    expect(turns).toHaveLength(2)
    expect(turns[1].gateResults?.map((gate) => gate.reviewer)).toEqual(["tester", "code-reviewer"])
    const exported = formatTurnMarkdown(turns[1])
    expect(exported).toContain("Reviewer: tester")
    expect(exported).toContain("Reviewer: code-reviewer")
  } finally {
    removeWorkDir(workDir)
  }
})
