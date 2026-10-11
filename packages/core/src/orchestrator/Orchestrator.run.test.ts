import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import type { AgentDefinition } from "../types/agent"
import type { MultiClawConfig, TurnRecord } from "../types/config"
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

const regroupedStages = (events: MultiClawEvent[]) =>
  events
    .filter(
      (e): e is Extract<MultiClawEvent, { type: "orchestration:stages" }> =>
        e.type === "orchestration:stages"
    )
    .map((e) => e.payload.stages.map((s) => s.agents.map((a) => a.id)))

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
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => {
      events.push(e)
      if (e.type === "agent:start") starts.push(e.payload as unknown as Record<string, unknown>)
    })

    const result = await orch.run()

    const dev = starts.find((p) => p.agentId === "dev")
    expect(dev?.taskTitle).toBe("Implement")
    expect(result.agentResults.find((r) => r.agentId === "dev")?.status).toBe("success")
    // The plan is applied after the architect stage, so the grouping published
    // by `orchestration:start` is the pre-plan one. The regroup has to be
    // announced separately or the console draws a pipeline that never ran.
    expect(regroupedStages(events)).toEqual([[["architect"], ["dev"]]])
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

describe("Orchestrator.run · earlier turns", () => {
  /**
   * Run one turn with a leader that plans, and return the prompt it was handed.
   *
   * The template names the placeholder explicitly: a context key that is never
   * set leaves the literal text in the prompt, which is exactly the failure this
   * guards.
   */
  async function leaderPromptWith(history: TurnRecord[] | undefined): Promise<string> {
    let prompt = ""
    handler = async (task) => {
      if (task.agentId === "leader") {
        prompt = task.prompt
        return { output: '{"mode":"run","run":["a"]}', exitCode: 0 }
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }
    await runOrch([agent("a")], {
      leader: agent("leader", { taskPrompt: "req: {{requirement}}\n{{conversation}}" }),
      context: { requirement: "Postgres" },
      ...(history ? { history } : {}),
    })
    return prompt
  }

  // Regression: an answer arrived with nothing behind it, so the leader was
  // handed "Postgres" as a requirement with no question for it to answer.
  it("hands the leader the turns behind a short answer", async () => {
    const prompt = await leaderPromptWith([
      { requirement: "build a web app", reply: { mode: "ask", message: "which database?" } },
    ])

    expect(prompt).toContain("req: Postgres")
    expect(prompt).toContain("build a web app")
    expect(prompt).toContain("you asked: which database?")
  })

  it("leaves no conversation behind on a single-turn run", async () => {
    const prompt = await leaderPromptWith(undefined)

    expect(prompt).toBe("req: Postgres\n")
    expect(prompt).not.toContain("{{conversation}}")
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

describe("Orchestrator.run · cancellation", () => {
  // Regression: the abort check used to `break` before the loop that clears
  // `allSuccess`, so a run the user stopped mid-stage resolved `success: true`
  // with a result list full of failures — and the CLI exited 0 on Ctrl-C.
  it("reports a cancelled run as cancelled, not as a success", async () => {
    const controller = new AbortController()
    handler = async (task) => {
      controller.abort()
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }
    const orch = new Orchestrator({ name: "test", workDir, agents: [agent("a"), agent("b")] })
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => events.push(e))

    const result = await orch.run({ signal: controller.signal })

    expect(result.cancelled).toBe(true)
    expect(result.success).toBe(false)
    // Cancelling mid-stage falls through rather than emitting a stage:complete
    // for a stage that did not finish.
    expect(events.map((e) => e.type)).not.toContain("stage:complete")
    const complete = events.find((e) => e.type === "orchestration:complete")
    expect(complete?.payload).toMatchObject({ cancelled: true, success: false })
  })

  it("omits the cancelled flag entirely on a run that finished", async () => {
    const { result } = await runOrch([agent("a")])
    expect(result.cancelled).toBeUndefined()
  })
})

describe("Orchestrator.run · a broken agent graph", () => {
  it("warns and runs in declaration order instead of rejecting", async () => {
    // A typo in a config's `dependsOn` used to throw straight out of `run()`,
    // so the caller saw an unhandled rejection and no completion event.
    const { result, events } = await runOrch([agent("a", { dependsOn: ["nope"] }), agent("b")])

    expect(result.success).toBe(true)
    expect(startedIds(events)).toEqual(["a", "b"])
    expect(warningsOf(events).some((w) => w.payload.message.includes("declaration order"))).toBe(
      true
    )
  })

  it("drops a task-plan dependency that is not part of this run", async () => {
    handler = async (task) => {
      if (task.agentId === "leader") {
        return { output: '{"mode":"run","run":["architect","dev"]}', exitCode: 0 }
      }
      if (task.agentId === "architect") {
        fs.writeFileSync(
          path.join(workDir, "task-plan.json"),
          JSON.stringify({
            tasks: [{ id: "dev", title: "Build it", dependsOn: ["unused"], scope: "s" }],
          })
        )
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }
    // Without the filter, `buildStages` would throw on dev's dangling dependency
    // even though the leader legitimately left `unused` out of the run.
    const { result, events } = await runOrch([agent("architect"), agent("dev"), agent("unused")], {
      leader: agent("leader"),
    })

    expect(result.success).toBe(true)
    expect(startedIds(events)).toEqual(["leader", "architect", "dev"])
    expect(warningsOf(events).some((w) => w.payload.message.includes("not in this run"))).toBe(true)
  })
})

describe("Orchestrator.run · config isolation", () => {
  // Regression: the no-leader path returned the config's own agent objects, so
  // `applyTaskPlan` wrote turn 1's titles and dependency graph onto the shared
  // config. The console reuses one config across turns, so turn 2 inherited them.
  it("does not write task-plan fields back onto the caller's config", async () => {
    handler = async (task) => {
      if (task.agentId === "dev") {
        fs.writeFileSync(
          path.join(workDir, "task-plan.json"),
          JSON.stringify({ tasks: [{ id: "dev", title: "Turn 1 title", scope: "Turn 1 scope" }] })
        )
      }
      return { output: "ok", exitCode: 0 }
    }
    const config: MultiClawConfig = { name: "test", workDir, agents: [agent("dev")] }
    const orch = new Orchestrator(config)

    await orch.run()

    expect(config.agents[0].taskTitle).toBeUndefined()
    expect(config.agents[0].agentScope).toBeUndefined()
  })
})
