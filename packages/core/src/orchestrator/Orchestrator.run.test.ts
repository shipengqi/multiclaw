import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import type { AgentDefinition } from "../types/agent"
import type { MultiClawConfig } from "../types/config"
import type { MultiClawEvent } from "../types/event"
import type { AgentOutput, AgentTask } from "../types/runtime"
import { Orchestrator } from "./Orchestrator"

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

const warningsOf = (events: MultiClawEvent[]) =>
  events.filter(
    (e): e is Extract<MultiClawEvent, { type: "orchestration:warning" }> =>
      e.type === "orchestration:warning"
  )

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
    const { result, events } = await runOrch([agent("a"), agent("b", { dependsOn: ["a"] })])

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
    const { result } = await runOrch([agent("a"), agent("b", { dependsOn: ["a"] })], {
      continueOnError: true,
    })

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

    const { result } = await runOrch([agent("a"), agent("b"), agent("c"), agent("d")], {
      maxConcurrency: 2,
    })

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
    // Written while the architect runs, which is when it really appears — and
    // which is also why a plan left over from a previous turn has to be cleared.
    handler = async (task) => {
      if (task.agentId === "architect") {
        fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify(plan))
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

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

  it("warns instead of failing silently when task-plan.json is malformed", async () => {
    handler = async (task) => {
      if (task.agentId === "architect") {
        fs.writeFileSync(path.join(workDir, "task-plan.json"), "{ not valid json")
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [agent("architect"), agent("dev", { dependsOn: ["architect"] })],
    }
    const orch = new Orchestrator(config)
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => events.push(e))

    const result = await orch.run()

    const warnings = warningsOf(events)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].payload.message).toMatch(/task-plan\.json/)
    // Degrades gracefully: the original agent set still runs.
    expect(result.success).toBe(true)
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["architect", "dev"])
  })

  it("warns when task-plan.json has no tasks array", async () => {
    handler = async (task) => {
      if (task.agentId === "architect") {
        fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify({ projectName: "x" }))
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [agent("architect"), agent("dev", { dependsOn: ["architect"] })],
    }
    const orch = new Orchestrator(config)
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => events.push(e))

    const result = await orch.run()

    const warnings = warningsOf(events)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].payload.message).toMatch(/tasks/)
    expect(result.success).toBe(true)
  })

  it("fails loudly when the leader selects no configured agent", async () => {
    handler = async (task) =>
      task.agentId === "leader"
        ? { output: '{"mode":"run","run":["ghost"]}', exitCode: 0 }
        : { output: "should not have run", exitCode: 0 }

    const { result, events } = await runOrch([agent("a"), agent("b")], {
      leader: agent("leader"),
    })

    // The bug this guards: `filter` returned an empty list, so zero stages ran —
    // and the run still reported success, which the console rendered as a green
    // "done" for a turn in which nobody worked.
    expect(result.success).toBe(false)
    expect(result.agentResults).toEqual([])

    const messages = warningsOf(events).map((w) => w.payload.message)
    expect(messages.some((m) => m.includes("ghost"))).toBe(true)
    expect(messages.some((m) => m.includes("none of the configured agents"))).toBe(true)
  })

  it("warns about an unknown agent but still runs the known ones", async () => {
    handler = async (task) =>
      task.agentId === "leader"
        ? { output: '{"mode":"run","run":["a","ghost"]}', exitCode: 0 }
        : { output: `out:${task.agentId}`, exitCode: 0 }

    const { result, events } = await runOrch([agent("a"), agent("b")], {
      leader: agent("leader"),
    })

    expect(result.agentResults.map((r) => r.agentId)).toEqual(["a"])
    expect(result.success).toBe(true)
    expect(warningsOf(events).some((w) => w.payload.message.includes("ghost"))).toBe(true)
  })

  it("does not blame the leader when the config simply has no agents", async () => {
    const { result, events } = await runOrch([])

    expect(result.success).toBe(false)
    expect(warningsOf(events)[0].payload.message).toMatch(/config lists no agents/)
  })

  // The console runs every turn in the same workspace, so the plan file outlives
  // the turn that wrote it. Re-applying it would hand this turn's agents the last
  // turn's titles and dependencies.
  it("drops a task plan left behind by an earlier turn", async () => {
    const stale = {
      projectName: "old",
      requirement: "old",
      tasks: [{ id: "dev", title: "Stale title", scope: "stale" }],
    }
    fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify(stale))

    const starts: Array<Record<string, unknown>> = []
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      // An architect that writes no plan of its own is exactly the case where a
      // stale file would otherwise be read as if it were this turn's.
      agents: [agent("architect"), agent("dev", { dependsOn: ["architect"] })],
    }
    const orch = new Orchestrator(config)
    orch.eventBus.subscribe((e) => {
      if (e.type === "agent:start") starts.push(e.payload as unknown as Record<string, unknown>)
    })

    await orch.run()

    expect(fs.existsSync(path.join(workDir, "task-plan.json"))).toBe(false)
    expect(starts.find((p) => p.agentId === "dev")?.taskTitle).toBeUndefined()
  })
})

/** Ids of the agents that actually started, in start order. */
function startedIds(events: MultiClawEvent[]): string[] {
  return events
    .filter((e): e is Extract<MultiClawEvent, { type: "agent:start" }> => e.type === "agent:start")
    .map((e) => e.payload.agentId)
}

/** Make the leader answer with `output`; every other agent runs normally. */
function leaderSays(output: string): void {
  handler = async (task) =>
    task.agentId === "leader"
      ? { output, exitCode: 0 }
      : { output: `out:${task.agentId}`, exitCode: 0 }
}

describe("Orchestrator.run · intent routing", () => {
  it("runs the whole configured team when no leader is configured", async () => {
    const { result, events } = await runOrch([agent("a"), agent("b")])

    expect(startedIds(events)).toEqual(["a", "b"])
    expect(result.reply).toBeUndefined()
  })

  it("ignores the leader when useLeader is false", async () => {
    leaderSays('{"mode":"run","run":["a"]}')
    const { result, events } = await runOrch([agent("a"), agent("b")], {
      leader: agent("leader"),
      useLeader: false,
    })

    expect(startedIds(events)).toEqual(["a", "b"])
    expect(result.success).toBe(true)
  })

  it("keeps only the agents the leader named, and skips the rest", async () => {
    leaderSays('Here is the plan: {"mode":"run","run":["a","c"]} — done.')
    const { events } = await runOrch([agent("a"), agent("b"), agent("c")], {
      leader: agent("leader"),
    })

    expect(startedIds(events)).toEqual(["leader", "a", "c"])
    const skipped = events.filter((e) => e.type === "agent:skipped")
    expect(skipped.map((e) => e.payload.agentId)).toEqual(["b"])
  })

  it("honours a plan that omits the mode", async () => {
    leaderSays('{"run":["b"]}')
    const { events } = await runOrch([agent("a"), agent("b")], { leader: agent("leader") })

    expect(startedIds(events)).toEqual(["leader", "b"])
  })

  it("drops dependsOn entries that point at a skipped agent", async () => {
    leaderSays('{"mode":"run","run":["a","c"]}')
    // Without the prune, `buildStages` would throw on c's dangling dependency.
    const { result, events } = await runOrch(
      [agent("a"), agent("b", { dependsOn: ["a"] }), agent("c", { dependsOn: ["b"] })],
      { leader: agent("leader") }
    )

    expect(result.success).toBe(true)
    expect(startedIds(events)).toEqual(["leader", "a", "c"])
  })

  it("falls back to the full team, loudly, when the leader fails", async () => {
    handler = async (task) => {
      if (task.agentId === "leader") throw new Error("leader exploded")
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }
    const { result, events } = await runOrch([agent("a"), agent("b")], {
      leader: agent("leader"),
    })

    expect(startedIds(events)).toEqual(["leader", "a", "b"])
    expect(result.success).toBe(true)
    expect(
      warningsOf(events).some((w) => w.payload.message.includes("leader could not be reached"))
    ).toBe(true)
  })

  it("falls back to the full team when the leader returns nothing at all", async () => {
    leaderSays("   \n  ")
    const { result, events } = await runOrch([agent("a"), agent("b")], {
      leader: agent("leader"),
    })

    expect(startedIds(events)).toEqual(["leader", "a", "b"])
    expect(result.success).toBe(true)
  })
})

describe("Orchestrator.run · a turn that ends in words", () => {
  // The behaviour this whole contract exists for: before it, "hello" reached the
  // pipeline with no plan JSON, and the fallback ran every configured agent.
  it("answers prose instead of running the team", async () => {
    leaderSays("Hi! I'm the leader for this project — ask me for a change.")
    const { result, events } = await runOrch([agent("a"), agent("b")], {
      leader: agent("leader"),
    })

    expect(startedIds(events)).toEqual(["leader"])
    expect(result.agentResults).toEqual([])
    expect(result.success).toBe(true)
    expect(result.reply).toEqual({
      mode: "reply",
      message: "Hi! I'm the leader for this project — ask me for a change.",
    })
    // No pipeline means no orchestration:start, so nothing is drawn as if a
    // stage had been scheduled.
    expect(events.map((e) => e.type)).not.toContain("orchestration:start")
  })

  it("carries an explicit reply through", async () => {
    leaderSays('{"mode":"reply","message":"Nothing to do here."}')
    const { result, events } = await runOrch([agent("a")], { leader: agent("leader") })

    expect(result.reply).toEqual({ mode: "reply", message: "Nothing to do here." })
    expect(startedIds(events)).toEqual(["leader"])
  })

  it("carries a question through", async () => {
    leaderSays('{"mode":"ask","message":"Which database should I target?"}')
    const { result, events } = await runOrch([agent("a")], { leader: agent("leader") })

    expect(result.reply).toEqual({ mode: "ask", message: "Which database should I target?" })
    expect(startedIds(events)).toEqual(["leader"])
    // A question is not a failure — the turn did what it could with what it had.
    expect(result.success).toBe(true)
  })

  it("publishes the reply on the completion event, like every other outcome", async () => {
    leaderSays("just a greeting")
    const { events } = await runOrch([agent("a")], { leader: agent("leader") })

    const complete = events.find((e) => e.type === "orchestration:complete")
    expect(complete?.payload).toMatchObject({
      reply: { mode: "reply", message: "just a greeting" },
    })
  })
})
