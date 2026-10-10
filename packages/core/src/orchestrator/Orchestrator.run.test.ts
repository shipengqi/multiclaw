import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Orchestrator } from "./Orchestrator"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import type { AgentTask, AgentOutput } from "../types/runtime"
import type { MultiClawEvent } from "../types/event"
import type { MultiClawConfig } from "../types/config"
import type { AgentDefinition } from "../types/agent"

const RUNTIME = "test-orchestrator-run"

let handler: (task: AgentTask) => Promise<AgentOutput> = async (task) => ({
  output: `out:${task.agentId}`,
  exitCode: 0,
})

beforeAll(() => {
  runtimeRegistry.register(fakeRuntime(RUNTIME, (task) => handler(task)))
})

let workDir: string
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-run-"))
  handler = async (task) => ({ output: `out:${task.agentId}`, exitCode: 0 })
})
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

function agent(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return makeAgent({ id, runtime: RUNTIME, ...extra })
}

async function runOrch(
  agents: AgentDefinition[],
  overrides: Partial<MultiClawConfig> = {}
): Promise<{ result: Awaited<ReturnType<Orchestrator["run"]>>; events: MultiClawEvent[] }> {
  const config: MultiClawConfig = { name: "test", workDir, agents, ...overrides }
  const orch = new Orchestrator(config)
  const events: MultiClawEvent[] = []
  orch.eventBus.subscribe((e) => events.push(e))
  const result = await orch.run()
  return { result, events }
}

describe("Orchestrator.run", () => {
  it("runs independent agents and reports overall success", async () => {
    const { result, events } = await runOrch([agent("a"), agent("b")])

    expect(result.success).toBe(true)
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["a", "b"])
    expect(result.agentResults.every((r) => r.status === "success")).toBe(true)
    expect(result.agentResults.map((r) => r.output)).toEqual(["out:a", "out:b"])

    const types = events.map((e) => e.type)
    expect(types).toEqual(
      expect.arrayContaining([
        "orchestration:start",
        "stage:start",
        "stage:complete",
        "orchestration:complete",
      ])
    )
    const complete = events.find((e) => e.type === "orchestration:complete")
    expect(complete?.payload).toEqual(result)
  })

  it("runs dependent agents in dependency order", async () => {
    const started: string[] = []
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [agent("b", { dependsOn: ["a"] }), agent("a")],
    }
    const orch = new Orchestrator(config)
    orch.eventBus.subscribe((e) => {
      if (e.type === "agent:start") started.push(e.payload.agentId)
    })

    const result = await orch.run()

    expect(started).toEqual(["a", "b"])
    expect(result.success).toBe(true)
  })

  it("stops the pipeline on failure and marks later agents as skipped", async () => {
    handler = async (task) => {
      if (task.agentId === "a") throw new Error("boom")
      return { output: "ok", exitCode: 0 }
    }
    const { result, events } = await runOrch([
      agent("a"),
      agent("b", { dependsOn: ["a"] }),
    ])

    expect(result.success).toBe(false)
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["a"])
    expect(result.agentResults[0].status).toBe("failed")

    const skipped = events.filter((e) => e.type === "agent:skipped")
    expect(skipped.map((e) => e.payload.agentId)).toEqual(["b"])
  })

  it("continues past a failure when continueOnError is set", async () => {
    handler = async (task) => {
      if (task.agentId === "a") throw new Error("boom")
      return { output: "ok", exitCode: 0 }
    }
    const { result } = await runOrch(
      [agent("a"), agent("b", { dependsOn: ["a"] })],
      { continueOnError: true }
    )

    expect(result.success).toBe(false)
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["a", "b"])
    expect(result.agentResults.find((r) => r.agentId === "b")?.status).toBe("success")
  })

  it("caps parallelism at maxConcurrency", async () => {
    let concurrent = 0
    let peak = 0
    handler = async (task) => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise((r) => setTimeout(r, 10))
      concurrent -= 1
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

    const { result } = await runOrch(
      [agent("a"), agent("b"), agent("c"), agent("d")],
      { maxConcurrency: 2 }
    )

    expect(result.agentResults).toHaveLength(4)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it("applies the architect task plan to later agents", async () => {
    const plan = {
      projectName: "demo",
      requirement: "build it",
      tasks: [
        { id: "architect", title: "Design", scope: "s1" },
        {
          id: "dev",
          title: "Implement",
          scope: "s2",
          dependsOn: ["architect"],
          plan: ["first", "second"],
        },
      ],
    }
    fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify(plan))

    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [agent("architect"), agent("dev", { dependsOn: ["architect"] })],
    }
    const orch = new Orchestrator(config)
    const starts: Array<Record<string, unknown>> = []
    orch.eventBus.subscribe((e) => {
      if (e.type === "agent:start") starts.push(e.payload as unknown as Record<string, unknown>)
    })

    const result = await orch.run()

    const dev = starts.find((p) => p.agentId === "dev")
    expect(dev?.taskTitle).toBe("Implement")
    expect(result.agentResults.find((r) => r.agentId === "dev")?.status).toBe("success")
  })
})
