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
import { AgentSessionManager } from "./AgentSessionManager"
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

describe("review-gated orchestration", () => {
  it("accepts one terminal verdict code block after streamed tool narration", async () => {
    handler = async (task) => ({
      output:
        task.agentId === "reviewer"
          ? 'I will read the file.\nThe artifact is verified.\n```json\n{"verdict":"approved","summary":"Checked","issues":[]}\n```'
          : "work",
      exitCode: 0,
    })
    const { result } = await runOrch([agent("worker"), agent("reviewer")], {
      review: { reviewer: "reviewer", repairAgents: ["worker"] },
    })
    expect(result.success).toBe(true)
    expect(result.acceptance?.status).toBe("approved")
  })

  it.each([
    '```json\n{"verdict":"changes_required","summary":"Fix","issues":["Bug"]}\n```\n```json\n{"verdict":"approved","summary":"Checked","issues":[]}\n```',
    '```json\n{"verdict":"approved","summary":"Checked","issues":[]}\n```\nActually do not approve this.',
  ])("rejects ambiguous or nonterminal verdict blocks", async (output) => {
    handler = async (task) => ({
      output: task.agentId === "reviewer" ? output : "work",
      exitCode: 0,
    })
    const { result } = await runOrch([agent("worker"), agent("reviewer")], {
      review: { reviewer: "reviewer", repairAgents: ["worker"] },
    })
    expect(result.acceptance?.status).toBe("failed")
  })

  it("reuses live worker and reviewer sessions throughout repair and the next turn", async () => {
    const runtimeName = "test-review-live-sessions"
    const opened: string[] = []
    const prompts: string[] = []
    let reviews = 0
    runtimeRegistry.register({
      ...fakeRuntime(runtimeName, async () => {
        throw new Error("one-shot execution should not run")
      }),
      openSession: async (options) => {
        opened.push(options.agentId)
        return {
          sessionId: `review-session:${options.agentId}`,
          state: "idle" as const,
          capabilities: { continuation: true, supplement: false },
          prompt: async (text) => {
            prompts.push(text)
            return {
              output:
                options.agentId === "reviewer"
                  ? JSON.stringify({
                      verdict: ++reviews === 1 ? "changes_required" : "approved",
                      summary: "Checked",
                      issues: reviews === 1 ? ["Fix bug"] : [],
                    })
                  : "work",
              exitCode: 0,
            }
          },
          cancelTurn: async () => {},
          close: async () => {},
        }
      },
    })
    const sessions = new AgentSessionManager()
    const config: MultiClawConfig = {
      name: "live-review",
      workDir,
      agents: [
        agent("worker", { runtime: runtimeName }),
        agent("reviewer", { runtime: runtimeName }),
      ],
      review: { reviewer: "reviewer", repairAgents: ["worker"] },
    }
    try {
      expect((await new Orchestrator(config, sessions).run()).success).toBe(true)
      expect((await new Orchestrator(config, sessions).run()).success).toBe(true)
      expect(opened).toEqual(["worker", "reviewer"])
      expect(prompts).toHaveLength(6)
      expect(prompts[2]).toContain("Fix bug")
    } finally {
      await sessions.close()
    }
  })

  it("previews the reserved final reviewer without running workers", async () => {
    const orch = new Orchestrator({
      name: "preview-review",
      workDir,
      agents: [agent("worker"), agent("reviewer")],
      review: { reviewer: "reviewer", repairAgents: ["worker"] },
    })
    const preview = await orch.preview()
    expect(preview.stages.map((stage) => stage.agents.map((a) => a.id))).toEqual([
      ["worker"],
      ["reviewer"],
    ])
    expect(preview.totalAgents).toBe(2)
  })

  it("omits the reserved reviewer from leader choices and never marks it skipped", async () => {
    let leaderPrompt = ""
    handler = async (task) => {
      if (task.agentId === "leader") {
        leaderPrompt = task.prompt
        return { output: '{"mode":"run","run":["worker"]}', exitCode: 0 }
      }
      return {
        output:
          task.agentId === "reviewer"
            ? '{"verdict":"approved","summary":"Checked","issues":[]}'
            : "work",
        exitCode: 0,
      }
    }
    const { result, events } = await runOrch([agent("worker"), agent("reviewer")], {
      leader: agent("leader", { taskPrompt: "{{availableAgents}}" }),
      review: { reviewer: "reviewer", repairAgents: ["worker"] },
    })
    expect(leaderPrompt).not.toContain("reviewer")
    expect(result.success).toBe(true)
    expect(
      events.filter((e) => e.type === "agent:skipped" && e.payload.agentId === "reviewer")
    ).toHaveLength(0)
  })

  it("validates policy in preview without launching the leader", async () => {
    const orch = new Orchestrator({
      name: "bad-review",
      workDir,
      agents: [agent("worker")],
      review: { reviewer: "missing", repairAgents: ["worker"] },
    })
    await expect(orch.preview()).rejects.toThrow("configured non-leader reviewer")
  })

  it("never marks an ordinary unreviewed pipeline as accepted", async () => {
    const { result } = await runOrch([agent("worker")])
    expect(result.success).toBe(true)
    expect("acceptance" in result).toBe(false)
  })

  it("allows review-only validation with no repair passes", async () => {
    handler = async () => ({
      output: '```json\n{"verdict":"approved","summary":"Checked","issues":[]}\n```',
      exitCode: 0,
    })
    const { result } = await runOrch([agent("worker"), agent("reviewer")], {
      review: { reviewer: "reviewer", repairAgents: ["worker"], maxRepairRounds: 0 },
    })
    expect(result.success).toBe(true)
    expect(result.acceptance).toMatchObject({ status: "approved", repairRounds: 0 })
  })

  it("preserves cancellation during review and does not start repairs", async () => {
    const controller = new AbortController()
    const seen: string[] = []
    handler = async (task) => {
      seen.push(task.agentId)
      if (task.agentId === "reviewer") controller.abort()
      return { output: "partial", exitCode: 0 }
    }
    const orch = new Orchestrator({
      name: "cancel-review",
      workDir,
      agents: [agent("worker"), agent("reviewer")],
      review: { reviewer: "reviewer", repairAgents: ["worker"] },
    })
    const result = await orch.run({ signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(result.success).toBe(false)
    expect(result.acceptance?.status).toBe("cancelled")
    expect(seen).toEqual(["worker", "reviewer"])
  })

  it.each(["reviewer", "repair"])("stops when %s execution fails", async (failure) => {
    let workers = 0
    handler = async (task) => {
      const failed =
        task.agentId === "reviewer" ? failure === "reviewer" : ++workers > 1 && failure === "repair"
      return {
        output:
          task.agentId === "reviewer"
            ? '{"verdict":"changes_required","summary":"Fix","issues":["Bug"]}'
            : "work",
        exitCode: failed ? 1 : 0,
      }
    }
    const { result } = await runOrch([agent("worker"), agent("reviewer")], {
      review: { reviewer: "reviewer", repairAgents: ["worker"] },
    })
    expect(result.success).toBe(false)
    expect(result.acceptance?.status).toBe("failed")
    expect(result.agentResults).toHaveLength(failure === "reviewer" ? 2 : 3)
  })

  const review = { reviewer: "reviewer", repairAgents: ["worker"], maxRepairRounds: 1 }
  const verdict = (approved: boolean) =>
    JSON.stringify({
      verdict: approved ? "approved" : "changes_required",
      summary: approved ? "Verified" : "Fix validation",
      issues: approved ? [] : ["Missing input validation"],
    })

  it("reserves the reviewer and repairs before accepting, preserving every cost and output", async () => {
    const seen: AgentTask[] = []
    let reviews = 0
    handler = async (task) => {
      seen.push(task)
      return {
        output: task.agentId === "reviewer" ? verdict(++reviews > 1) : `worker:${seen.length}`,
        exitCode: 0,
        costUsd: 0.25,
      }
    }
    const { result, events } = await runOrch([agent("worker"), agent("reviewer")], {
      review,
      context: { requirement: "Build a validated API" },
    })
    expect(seen.map((task) => task.agentId)).toEqual(["worker", "reviewer", "worker", "reviewer"])
    expect(seen[2].prompt).toContain("Missing input validation")
    expect(seen[2].prompt).toContain("Build a validated API")
    expect(seen[3].prompt).toContain("worker:3")
    expect(seen[3].prompt).not.toContain("worker:1")
    expect(result.acceptance).toMatchObject({
      status: "approved",
      repairRounds: 1,
      reviews: [{ verdict: "changes_required" }, { verdict: "approved" }],
    })
    expect(result.success).toBe(true)
    expect(result.agentResults).toHaveLength(4)
    expect(result.totalCostUsd).toBe(1)
    expect(events.filter((event) => event.type === "orchestration:complete")).toHaveLength(1)
  })

  it("blocks approval when the repair budget is exhausted", async () => {
    handler = async (task) => ({
      output: task.agentId === "reviewer" ? verdict(false) : "work",
      exitCode: 0,
    })
    const { result } = await runOrch([agent("worker"), agent("reviewer")], { review })
    expect(result.success).toBe(false)
    expect(result.acceptance).toMatchObject({ status: "changes_required", repairRounds: 1 })
    expect(result.agentResults).toHaveLength(4)
  })

  it.each(["Approved", "{}", '{"verdict":"approved","summary":"ok","issues":["Unresolved"]}'])(
    "fails closed for invalid verdict %s",
    async (output) => {
      handler = async (task) => ({
        output: task.agentId === "reviewer" ? output : "work",
        exitCode: 0,
      })
      const { result } = await runOrch([agent("worker"), agent("reviewer")], { review })
      expect(result.success).toBe(false)
      expect(result.acceptance?.status).toBe("failed")
      expect(result.agentResults).toHaveLength(2)
    }
  )

  it("does not run a reviewer after pipeline failure", async () => {
    handler = async () => ({ output: "partial", exitCode: 1 })
    const { result } = await runOrch([agent("worker"), agent("reviewer")], { review })
    expect(result.acceptance?.status).toBe("failed")
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["worker"])
  })

  it("rejects invalid policy before launching agents", async () => {
    const seen: string[] = []
    handler = async (task) => {
      seen.push(task.agentId)
      return { output: "work", exitCode: 0 }
    }
    const { result } = await runOrch([agent("worker"), agent("reviewer")], {
      review: { ...review, maxRepairRounds: -1 },
    })
    expect(result.success).toBe(false)
    expect(result.acceptance?.status).toBe("failed")
    expect(seen).toEqual([])
  })

  it("does not widen a leader-selected task during repair", async () => {
    handler = async (task) => ({
      output:
        task.agentId === "leader"
          ? '{"mode":"run","run":["other"]}'
          : task.agentId === "reviewer"
            ? verdict(false)
            : "work",
      exitCode: 0,
    })
    const { result } = await runOrch([agent("worker"), agent("other"), agent("reviewer")], {
      review,
      leader: agent("leader"),
    })
    expect(result.success).toBe(false)
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["other", "reviewer"])
    expect(result.acceptance?.status).toBe("changes_required")
  })
})

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

  it("omits selectionReason entirely when the leader gave none", async () => {
    const { result, events } = await runOrch([agent("a")])
    expect("selectionReason" in result).toBe(false)
    const start = events.find((e) => e.type === "orchestration:start")
    expect(start && "selectionReason" in start.payload).toBe(false)
  })

  it("launches each agent with the command/args its provider resolves to", async () => {
    // Regression: an agent that pins `provider` with no literal `command` must be
    // launched as that provider's bridge — `claude` → `claude-agent-acp` (args
    // []), not the runtime's built-in `opencode acp` default. The dev-team example
    // configures providers without a literal command and spawned `opencode`, which
    // ENOENT'd wherever it was not on PATH. Keeps the runner in step with the
    // CLI's availability gate, which already resolves the command.
    const seen: Array<{ command?: string; args?: string[] }> = []
    handler = async (task) => {
      seen.push({ command: task.command, args: task.args })
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }
    await runOrch([agent("a", { provider: "claude" }), agent("b", { provider: "opencode" })])

    expect(seen).toEqual([
      { command: "claude-agent-acp", args: [] },
      { command: "opencode", args: ["acp"] },
    ])
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

  it("previews the routed stages without running the pipeline", async () => {
    const ran: string[] = []
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      leader: agent("leader"),
      agents: [agent("a"), agent("b", { dependsOn: ["a"] })],
      context: { requirement: "ship it" },
    }
    handler = async (task) => {
      ran.push(task.agentId)
      if (task.agentId === "leader")
        return { output: '{"mode":"run","run":["a","b"]}', exitCode: 0 }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

    const preview = await new Orchestrator(config).preview()

    expect(ran).toEqual(["leader"])
    expect(preview).toMatchObject({ name: "test", requirement: "ship it", totalAgents: 2 })
    expect(preview.stages.map((s) => s.agents.map((a) => a.id))).toEqual([["a"], ["b"]])
  })

  it("carries the leader's reason through preview, the start event, and the result", async () => {
    handler = async (task) =>
      task.agentId === "leader"
        ? {
            output: '{"mode":"run","reason":"only a docs change","run":["a"]}',
            exitCode: 0,
          }
        : { output: `out:${task.agentId}`, exitCode: 0 }
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      leader: agent("leader"),
      agents: [agent("a"), agent("b")],
      context: { requirement: "fix the typo" },
    }

    const preview = await new Orchestrator(config).preview()
    expect(preview.selectionReason).toBe("only a docs change")

    const orch = new Orchestrator(config)
    const starts: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => {
      if (e.type === "orchestration:start") starts.push(e)
    })
    const result = await orch.run()

    // The reason is orchestration metadata: it must survive on both the live
    // event (so a console can show it while the team runs) and the result (so a
    // report can explain the run afterwards).
    expect(starts).toHaveLength(1)
    expect(starts[0].payload).toMatchObject({ selectionReason: "only a docs change" })
    expect(result.selectionReason).toBe("only a docs change")
  })

  it("previews a leader reply as words instead of a pipeline", async () => {
    handler = async () => ({ output: '{"mode":"ask","message":"Which target?"}', exitCode: 0 })
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      leader: agent("leader"),
      agents: [agent("a")],
    }

    const preview = await new Orchestrator(config).preview()

    expect(preview).toEqual({
      name: "test",
      totalAgents: 0,
      stages: [],
      reply: { mode: "ask", message: "Which target?" },
    })
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

  it("caps parallelism at maxConcurrency and refills freed slots", async () => {
    let concurrent = 0
    let peak = 0
    const started: string[] = []
    const finished: string[] = []
    const delays: Record<string, number> = { a: 50, b: 5, c: 5, d: 5 }
    handler = async (task) => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      started.push(task.agentId)
      await new Promise((r) => setTimeout(r, delays[task.agentId] ?? 5))
      finished.push(task.agentId)
      concurrent -= 1
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

    const { result } = await runOrch([agent("a"), agent("b"), agent("c"), agent("d")], {
      maxConcurrency: 2,
    })

    expect(result.agentResults.map((r) => r.agentId)).toEqual(["a", "b", "c", "d"])
    expect(peak).toBeLessThanOrEqual(2)
    expect(started.indexOf("c")).toBeLessThan(finished.indexOf("a"))
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

  it("applies the task plan when the planner runs in a later stage", async () => {
    // Regression: the guard used to require the planner in stage 0. A preset
    // that front-loads a product-manager puts the architect in stage 1, so the
    // plan was never applied and every task title / scope / dependency was lost.
    const plan = {
      projectName: "demo",
      requirement: "build it",
      tasks: [
        {
          id: "dev",
          title: "Implement",
          scope: "s2",
          plan: ["first", "second"],
          dependsOn: ["architect"],
        },
      ],
    }
    handler = async (task) => {
      if (task.agentId === "architect") {
        fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify(plan))
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [
        agent("product-manager"),
        agent("architect", { dependsOn: ["product-manager"] }),
        agent("dev", { dependsOn: ["architect"] }),
      ],
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
    // The regroup is announced so the console draws the pipeline that ran.
    expect(regroupedStages(events)).toEqual([[["product-manager"], ["architect"], ["dev"]]])
  })

  it("honours a custom planner id declared with role: planner", async () => {
    // The planner is identified by role, not by a hard-coded "architect" id, so
    // a team can name the decomposer anything and still get its task plan.
    const plan = {
      projectName: "demo",
      requirement: "build it",
      tasks: [{ id: "dev", title: "Implement", scope: "s2", dependsOn: ["lead-designer"] }],
    }
    handler = async (task) => {
      if (task.agentId === "lead-designer") {
        fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify(plan))
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [
        agent("pm"),
        agent("lead-designer", { role: "planner", dependsOn: ["pm"] }),
        agent("dev", { dependsOn: ["lead-designer"] }),
      ],
    }
    const orch = new Orchestrator(config)
    const starts: Array<Record<string, unknown>> = []
    orch.eventBus.subscribe((e) => {
      if (e.type === "agent:start") starts.push(e.payload as unknown as Record<string, unknown>)
    })

    const result = await orch.run()

    expect(starts.find((p) => p.agentId === "dev")?.taskTitle).toBe("Implement")
    expect(result.success).toBe(true)
  })

  it("does not apply a task plan for an agent that is neither planner nor architect", async () => {
    // Negative invariant: an ordinary agent that happens to write task-plan.json
    // must not trigger the plan — only a planner (by role or by the architect
    // fallback) does.
    const plan = {
      projectName: "x",
      requirement: "y",
      tasks: [{ id: "dev", title: "Should not apply", scope: "s" }],
    }
    handler = async (task) => {
      if (task.agentId === "designer") {
        fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify(plan))
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [agent("designer"), agent("dev", { dependsOn: ["designer"] })],
    }
    const orch = new Orchestrator(config)
    const starts: Array<Record<string, unknown>> = []
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => {
      events.push(e)
      if (e.type === "agent:start") starts.push(e.payload as unknown as Record<string, unknown>)
    })

    await orch.run()

    expect(starts.find((p) => p.agentId === "dev")?.taskTitle).toBeUndefined()
    expect(regroupedStages(events)).toEqual([])
  })

  it("does not apply the task plan when the planner's stage fails", async () => {
    // The success check is half the guard. Without it a planner that wrote a
    // half-finished plan and then crashed would still hand that plan to the
    // rest of the team.
    const plan = {
      projectName: "demo",
      requirement: "build it",
      tasks: [{ id: "dev", title: "Implement", scope: "s2", dependsOn: ["architect"] }],
    }
    handler = async (task) => {
      if (task.agentId === "architect") {
        // Writes a plan, then fails — so a wrongly-applied plan shows up as a
        // task title on dev rather than as an absent file.
        fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify(plan))
        throw new Error("architect exploded")
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

    const config: MultiClawConfig = {
      name: "test",
      workDir,
      // continueOnError so dev still runs — otherwise it is merely skipped and
      // the assertion would hold for the wrong reason.
      continueOnError: true,
      agents: [
        agent("product-manager"),
        agent("architect", { dependsOn: ["product-manager"] }),
        agent("dev", { dependsOn: ["architect"] }),
      ],
    }
    const orch = new Orchestrator(config)
    const starts: Array<Record<string, unknown>> = []
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => {
      events.push(e)
      if (e.type === "agent:start") starts.push(e.payload as unknown as Record<string, unknown>)
    })

    const result = await orch.run()

    // dev really did start, so its missing title is meaningful.
    expect(starts.some((p) => p.agentId === "dev")).toBe(true)
    expect(starts.find((p) => p.agentId === "dev")?.taskTitle).toBeUndefined()
    // And the console was never told the team had been regrouped.
    expect(regroupedStages(events)).toEqual([])
    expect(result.agentResults.find((r) => r.agentId === "architect")?.status).toBe("failed")
  })

  it("applies the task plan only once when several planners run", async () => {
    // `planApplied` is what stops the regroup from firing again for a second
    // planner. A second re-emit would make the console redraw the pipeline
    // mid-run.
    const plan = {
      projectName: "demo",
      requirement: "build it",
      tasks: [{ id: "dev", title: "Implement", scope: "s2", dependsOn: ["planner-b"] }],
    }
    handler = async (task) => {
      if (task.agentId === "planner-a") {
        fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify(plan))
      }
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [
        agent("planner-a", { role: "planner" }),
        agent("planner-b", { role: "planner", dependsOn: ["planner-a"] }),
        agent("dev", { dependsOn: ["planner-b"] }),
      ],
    }
    const orch = new Orchestrator(config)
    const starts: Array<Record<string, unknown>> = []
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => {
      events.push(e)
      if (e.type === "agent:start") starts.push(e.payload as unknown as Record<string, unknown>)
    })

    const result = await orch.run()

    // Exactly one regroup, even though two planners ran.
    expect(regroupedStages(events)).toHaveLength(1)
    // The plan still took effect — once.
    expect(starts.find((p) => p.agentId === "dev")?.taskTitle).toBe("Implement")
    expect(result.success).toBe(true)
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

  it.each([
    null,
    42,
    { tasks: [null] },
    { tasks: [{ id: "dev", dependsOn: "architect" }] },
    { tasks: [{ id: "dev", dependsOn: [42] }] },
    { tasks: [{ id: "dev", plan: "implement" }] },
    { tasks: [{ id: "dev", plan: [null] }] },
    { tasks: [{ id: "dev", title: {}, scope: 42 }] },
  ])("ignores malformed model task-plan shapes without crashing: %j", async (plan) => {
    handler = async (task) => {
      if (task.agentId === "architect")
        fs.writeFileSync(path.join(workDir, "task-plan.json"), JSON.stringify(plan))
      return { output: "done", exitCode: 0 }
    }
    const { result, events } = await runOrch([
      agent("architect"),
      agent("dev", { dependsOn: ["architect"], taskTitle: "Original title" }),
    ])
    expect(result.success).toBe(true)
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["architect", "dev"])
    expect(warningsOf(events).length).toBeGreaterThan(0)
    expect(
      events.find((e) => e.type === "agent:start" && e.payload.agentId === "dev")?.payload
    ).toMatchObject({ taskTitle: "Original title" })
    expect(events.filter((e) => e.type === "orchestration:complete")).toHaveLength(1)
  })

  it("keeps valid tasks while warning and ignoring malformed, duplicate, and unknown entries", async () => {
    handler = async (task) => {
      if (task.agentId === "architect")
        fs.writeFileSync(
          path.join(workDir, "task-plan.json"),
          JSON.stringify({
            tasks: [
              null,
              { id: "dev", title: "Valid title", scope: "Valid scope", plan: ["Implement"] },
              { id: "dev", title: "Duplicate title" },
              { id: "ghost", title: "Unknown task" },
            ],
          })
        )
      return { output: "done", exitCode: 0 }
    }
    const { result, events } = await runOrch([
      agent("architect"),
      agent("dev", { dependsOn: ["architect"] }),
    ])
    expect(result.success).toBe(true)
    expect(
      events.find((e) => e.type === "agent:start" && e.payload.agentId === "dev")?.payload
    ).toMatchObject({ taskTitle: "Valid title" })
    const messages = warningsOf(events)
      .map((e) => e.payload.message)
      .join("\n")
    expect(messages).toMatch(/malformed/)
    expect(messages).toMatch(/duplicate/i)
    expect(messages).toContain("ghost")
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

describe("Orchestrator.run · regression boundaries", () => {
  it("uses the complete leader requirement without mutating the raw input", async () => {
    const effective = "Build a web app using Postgres, without authentication"
    const prompts: Record<string, string> = {}
    handler = async (task) => {
      prompts[task.agentId] = task.prompt
      return {
        output:
          task.agentId === "leader"
            ? JSON.stringify({ mode: "run", run: ["dev"], requirement: effective })
            : "done",
        exitCode: 0,
      }
    }
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      leader: agent("leader"),
      agents: [agent("dev", { taskPrompt: "{{requirement}}" })],
      context: { requirement: "Postgres, without authentication" },
      history: [
        { requirement: "Build a web app", reply: { mode: "ask", message: "Which database?" } },
      ],
    }
    const preview = await new Orchestrator(config).preview()
    expect(preview.requirement).toBe(effective)
    const orch = new Orchestrator(config)
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => events.push(e))
    const result = await orch.run()
    expect(result.requirement).toBe(effective)
    expect(events.find((e) => e.type === "orchestration:start")?.payload).toMatchObject({
      requirement: effective,
    })
    expect(prompts.dev).toContain(effective)
    expect(config.context?.requirement).toBe("Postgres, without authentication")
  })

  it("never starts an agent for a pre-aborted run", async () => {
    const controller = new AbortController()
    controller.abort()
    const orch = new Orchestrator({
      name: "test",
      workDir,
      leader: agent("leader"),
      agents: [agent("a")],
    })
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => events.push(e))
    const result = await orch.run({ signal: controller.signal })
    expect(result).toMatchObject({ success: false, cancelled: true, agentResults: [] })
    expect(startedIds(events)).toEqual([])
    expect(events.map((e) => e.type)).toEqual(["orchestration:complete"])
  })

  it("does not fall back to the team when the provider cancels the leader", async () => {
    handler = async () => ({ output: "", exitCode: 0, stopReason: "cancelled" })
    const { result, events } = await runOrch([agent("a")], { leader: agent("leader") })
    expect(result).toMatchObject({ success: false, cancelled: true, agentResults: [] })
    expect(startedIds(events)).toEqual(["leader"])
    expect(warningsOf(events)).toEqual([])
  })

  it("stops after the leader is aborted rather than answering or running", async () => {
    const controller = new AbortController()
    handler = async () => {
      controller.abort()
      return { output: '{"mode":"reply","message":"done"}', exitCode: 0 }
    }
    const orch = new Orchestrator({
      name: "test",
      workDir,
      leader: agent("leader"),
      agents: [agent("a")],
    })
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => events.push(e))
    const result = await orch.run({ signal: controller.signal })
    expect(result).toMatchObject({ success: false, cancelled: true, agentResults: [] })
    expect(result.reply).toBeUndefined()
    expect(startedIds(events)).toEqual(["leader"])
    expect(events.map((e) => e.type)).not.toContain("orchestration:start")
  })

  it("does not start later stages after provider cancellation", async () => {
    handler = async () => ({ output: "", exitCode: 0, stopReason: "cancelled" })
    const { result, events } = await runOrch([agent("a"), agent("b", { dependsOn: ["a"] })], {
      continueOnError: true,
    })
    expect(result).toMatchObject({ success: false, cancelled: true })
    expect(startedIds(events)).toEqual(["a"])
    expect(events.filter((e) => e.type === "stage:start")).toHaveLength(1)
  })

  it("stops dequeuing agents after provider cancellation and returns no holes", async () => {
    handler = async () => ({ output: "", exitCode: 0, stopReason: "cancelled" })
    const { result, events } = await runOrch([agent("a"), agent("b"), agent("c")], {
      maxConcurrency: 1,
      continueOnError: true,
    })
    expect(result).toMatchObject({ success: false, cancelled: true })
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["a"])
    expect(startedIds(events)).toEqual(["a"])
    expect(events.map((e) => e.type)).not.toContain("stage:complete")
  })

  it("waits for started siblings while cancelling queued agents", async () => {
    let releaseSibling!: () => void
    const sibling = new Promise<void>((resolve) => {
      releaseSibling = resolve
    })
    handler = async (task) => {
      if (task.agentId === "a") {
        await sibling
        return { output: "done", exitCode: 0 }
      }
      releaseSibling()
      return { output: "", exitCode: 0, stopReason: "cancelled" }
    }
    const { result, events } = await runOrch([agent("a"), agent("b"), agent("c"), agent("d")], {
      maxConcurrency: 2,
    })
    expect(result).toMatchObject({ success: false, cancelled: true })
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["a", "b"])
    expect(startedIds(events)).toEqual(["a", "b"])
  })

  it("checks cancellation again when a slot is freed", async () => {
    const controller = new AbortController()
    handler = async () => {
      controller.abort()
      return { output: "done", exitCode: 0 }
    }
    const orch = new Orchestrator({
      name: "test",
      workDir,
      agents: [agent("a"), agent("b"), agent("c")],
      maxConcurrency: 1,
    })
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => events.push(e))
    const result = await orch.run({ signal: controller.signal })
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["a"])
    expect(startedIds(events)).toEqual(["a"])
  })

  it("stops before a stage when the start event aborts the run", async () => {
    const controller = new AbortController()
    const orch = new Orchestrator({ name: "test", workDir, agents: [agent("a")] })
    const events: MultiClawEvent[] = []
    orch.eventBus.subscribe((e) => {
      events.push(e)
      if (e.type === "orchestration:start") controller.abort()
    })
    const result = await orch.run({ signal: controller.signal })
    expect(result).toMatchObject({ success: false, cancelled: true, agentResults: [] })
    expect(startedIds(events)).toEqual([])
    expect(events.map((e) => e.type)).not.toContain("stage:start")
  })

  it("does not skip or repeat agents when a task plan collapses earlier stages", async () => {
    handler = async (task) => {
      if (task.agentId === "architect")
        fs.writeFileSync(
          path.join(workDir, "task-plan.json"),
          JSON.stringify({
            tasks: [
              { id: "architect", dependsOn: [] },
              { id: "dev", dependsOn: [] },
              { id: "review", dependsOn: ["dev"] },
            ],
          })
        )
      return { output: "done", exitCode: 0 }
    }
    const { result, events } = await runOrch([
      agent("pm"),
      agent("architect", { dependsOn: ["pm"] }),
      agent("dev", { dependsOn: ["architect"] }),
      agent("review", { dependsOn: ["dev"] }),
    ])
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["pm", "architect", "dev", "review"])
    expect(startedIds(events)).toEqual(["pm", "architect", "dev", "review"])
    expect(regroupedStages(events)).toEqual([[["pm"], ["architect"], ["dev"], ["review"]]])
    expect(events.filter((e) => e.type === "stage:start").map((e) => e.payload)).toEqual([
      { stageIndex: 0, agentIds: ["pm"] },
      { stageIndex: 1, agentIds: ["architect"] },
      { stageIndex: 2, agentIds: ["dev"] },
      { stageIndex: 3, agentIds: ["review"] },
    ])
    expect(
      events.filter((e) => e.type === "stage:complete").map((e) => e.payload.stageIndex)
    ).toEqual([0, 1, 2, 3])
  })

  it("does not repeat completed agents when a task plan moves them later", async () => {
    handler = async (task) => {
      if (task.agentId === "architect")
        fs.writeFileSync(
          path.join(workDir, "task-plan.json"),
          JSON.stringify({
            tasks: [
              { id: "pm", dependsOn: ["dev"] },
              { id: "architect", dependsOn: [] },
              { id: "dev", dependsOn: ["architect"] },
            ],
          })
        )
      return { output: "done", exitCode: 0 }
    }
    const { result, events } = await runOrch([
      agent("pm"),
      agent("architect", { dependsOn: ["pm"] }),
      agent("dev", { dependsOn: ["architect"] }),
    ])
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["pm", "architect", "dev"])
    expect(startedIds(events)).toEqual(["pm", "architect", "dev"])
  })

  it("ignores new completed-agent dependencies when ordering remaining work", async () => {
    handler = async (task) => {
      if (task.agentId === "architect")
        fs.writeFileSync(
          path.join(workDir, "task-plan.json"),
          JSON.stringify({
            tasks: [
              { id: "pm", title: "Changed completed title", dependsOn: ["x"] },
              { id: "x", dependsOn: ["architect"] },
              { id: "y", dependsOn: ["x"] },
            ],
          })
        )
      return { output: "done", exitCode: 0 }
    }
    const { result, events } = await runOrch([
      agent("pm", { taskTitle: "Original completed title" }),
      agent("architect", { dependsOn: ["pm"] }),
      agent("y", { dependsOn: ["architect"] }),
      agent("x", { dependsOn: ["architect"] }),
    ])
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["pm", "architect", "x", "y"])
    expect(warningsOf(events)).toEqual([])
    expect(regroupedStages(events)).toEqual([[["pm"], ["architect"], ["x"], ["y"]]])
    const regrouped = events.find((e) => e.type === "orchestration:stages")
    expect(regrouped?.payload.stages[0].agents[0].taskTitle).toBe("Original completed title")
  })

  it("runs broken dependency graphs truly sequentially", async () => {
    const order: string[] = []
    handler = async (task) => {
      order.push(`start:${task.agentId}`)
      await Promise.resolve()
      order.push(`end:${task.agentId}`)
      return { output: "done", exitCode: 0 }
    }
    const { events } = await runOrch([agent("a", { dependsOn: ["missing"] }), agent("b")])
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"])
    expect(events.find((e) => e.type === "orchestration:start")?.payload).toMatchObject({
      stages: [
        { stageIndex: 0, agents: [{ id: "a" }] },
        { stageIndex: 1, agents: [{ id: "b" }] },
      ],
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

  it("copies each agent's dependsOn so a mutation of the copy cannot reach the config", () => {
    // `configuredAgents` is private and its copies are not observable through
    // `run()` (`applyTaskPlan` reassigns `dependsOn` rather than mutating it), so
    // the invariant is checked directly: the copy's array must not be the
    // config's array.
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [agent("a", { dependsOn: ["b"] }), agent("b")],
    }
    const orch = new Orchestrator(config)
    const copies = (orch as unknown as { configuredAgents(): AgentDefinition[] }).configuredAgents()

    expect(copies[0].dependsOn).toEqual(["b"])
    expect(copies[0].dependsOn).not.toBe(config.agents[0].dependsOn)
    copies[0].dependsOn?.push("c")
    expect(config.agents[0].dependsOn).toEqual(["b"])
  })

  it("does not invent a dependsOn key on an agent that never had one", () => {
    const config: MultiClawConfig = { name: "test", workDir, agents: [agent("a")] }
    const orch = new Orchestrator(config)
    const copies = (orch as unknown as { configuredAgents(): AgentDefinition[] }).configuredAgents()

    expect("dependsOn" in copies[0]).toBe(false)
  })
})

describe("Orchestrator.run · cost and model reporting", () => {
  it("sums the costs the agents actually reported", async () => {
    handler = async (task) => ({
      output: `out:${task.agentId}`,
      exitCode: 0,
      ...(task.agentId === "a" ? { costUsd: 1.2 } : {}),
      ...(task.agentId === "b" ? { costUsd: 0.3 } : {}),
    })

    const { result } = await runOrch([agent("a"), agent("b")])

    expect(result.totalCostUsd).toBeCloseTo(1.5)
  })

  it("only counts the agents that reported a cost", async () => {
    handler = async (task) => ({
      output: `out:${task.agentId}`,
      exitCode: 0,
      ...(task.agentId === "a" ? { costUsd: 0.4 } : {}),
    })

    const { result } = await runOrch([agent("a"), agent("b")])

    expect(result.totalCostUsd).toBeCloseTo(0.4)
  })

  it("leaves totalCostUsd undefined when nobody reported a cost", async () => {
    const { result } = await runOrch([agent("a"), agent("b")])

    // "No data" must not read as "free": the field is absent, never 0.
    expect(result.totalCostUsd).toBeUndefined()
    expect("totalCostUsd" in result).toBe(false)
  })

  it("reports the model each agent will actually run in the stage list", async () => {
    // Regression: the old lookup read only `model` / `models[runtime]`, so a
    // tier-only agent reported `undefined` here while it really ran a concrete
    // model — the TUI's pipeline bar then showed no model at all.
    const events: MultiClawEvent[] = []
    const config: MultiClawConfig = {
      name: "test",
      workDir,
      agents: [agent("a", { provider: "claude", modelTier: "fast" })],
    }
    const orch = new Orchestrator(config)
    orch.eventBus.subscribe((e) => events.push(e))

    await orch.run()

    const start = events.find(
      (e): e is Extract<MultiClawEvent, { type: "orchestration:start" }> =>
        e.type === "orchestration:start"
    )
    expect(start?.payload.stages[0].agents[0].model).toBe("haiku")
  })
})

describe("Orchestrator.run · resume", () => {
  it("re-runs only the named agents and never asks the leader", async () => {
    let leaderCalls = 0
    handler = async (task) => {
      if (task.agentId === "leader") leaderCalls += 1
      return { output: `out:${task.agentId}`, exitCode: 0 }
    }

    const { result, events } = await runOrch([agent("architect"), agent("dev")], {
      leader: agent("leader"),
      resume: { agents: ["dev"] },
    })

    // The leader would re-route the turn and could pick a different team than
    // the one being resumed, so a resume bypasses it entirely.
    expect(leaderCalls).toBe(0)
    expect(startedIds(events)).toEqual(["dev"])
    expect(result.agentResults.map((r) => r.agentId)).toEqual(["dev"])
    expect(result.success).toBe(true)
  })

  it("warns about a resumed agent it does not recognise and drops it", async () => {
    const { result, events } = await runOrch([agent("dev")], {
      resume: { agents: ["dev", "ghost"] },
    })

    expect(startedIds(events)).toEqual(["dev"])
    const messages = warningsOf(events).map((w) => w.payload.message)
    expect(messages.some((m) => m.includes("ghost"))).toBe(true)
    // A resume runs no leader, so blaming "the leader" for a bad resumed id
    // would send the reader looking in the wrong place.
    expect(messages.some((m) => m.includes("leader"))).toBe(false)
    expect(result.success).toBe(true)
  })

  it("marks the agents it is not re-running as skipped", async () => {
    const { events } = await runOrch([agent("architect"), agent("dev")], {
      resume: { agents: ["dev"] },
    })

    const skipped = events.filter((e) => e.type === "agent:skipped")
    expect(skipped.map((e) => e.payload.agentId)).toEqual(["architect"])
  })

  it("clears a resumed agent's dependency on an agent that is not re-run", async () => {
    // A single-agent retry names one id. Without the prune, `buildStages` would
    // throw on the dependency the original run had, and the retry would degrade
    // to declaration order instead of running cleanly.
    const { result, events } = await runOrch(
      [agent("architect"), agent("dev", { dependsOn: ["architect"] })],
      { resume: { agents: ["dev"] } }
    )

    expect(result.success).toBe(true)
    expect(startedIds(events)).toEqual(["dev"])
    expect(warningsOf(events).some((w) => w.payload.message.includes("declaration order"))).toBe(
      false
    )
  })

  it("reports a resumed run that names no agents as an empty failure", async () => {
    const { result } = await runOrch([agent("dev")], { resume: { agents: [] } })

    expect(result.success).toBe(false)
    expect(result.agentResults).toEqual([])
  })

  it("carries the requirement onto the result", async () => {
    const { result } = await runOrch([agent("dev")], { context: { requirement: "ship it" } })

    expect(result.requirement).toBe("ship it")
  })

  it("omits the requirement when the caller supplied none", async () => {
    const { result } = await runOrch([agent("dev")])

    // Absent, not "": a run with no requirement must not report one.
    expect("requirement" in result).toBe(false)
  })

  it("carries the requirement onto a turn that ends in words", async () => {
    leaderSays("hello there")
    const { result } = await runOrch([agent("a")], {
      leader: agent("leader"),
      context: { requirement: "say hi" },
    })

    expect(result.reply).toBeDefined()
    expect(result.requirement).toBe("say hi")
  })

  it("carries the requirement onto an empty run", async () => {
    const { result } = await runOrch([], { context: { requirement: "nothing to do" } })

    expect(result.success).toBe(false)
    expect(result.requirement).toBe("nothing to do")
  })
})

describe("Orchestrator.run · upstream outputs", () => {
  // The bug this guards: `ContextManager` was written by the constructor and the
  // leader only — never with an agent's output — so a downstream agent's prompt
  // carried nothing about what upstream had said or decided.
  it("hands a downstream agent what the stage before it produced", async () => {
    const prompts: Record<string, string> = {}
    handler = async (task) => {
      prompts[task.agentId] = task.prompt
      return { output: task.agentId === "first" ? "UPSTREAM_MARKER" : "done", exitCode: 0 }
    }

    await runOrch([
      agent("first", { name: "First", taskPrompt: "{{upstreamOutputs}}" }),
      agent("second", { name: "Second", dependsOn: ["first"], taskPrompt: "{{upstreamOutputs}}" }),
    ])

    expect(prompts.second).toContain("UPSTREAM_MARKER")
    expect(prompts.second).toContain("## What upstream produced")
    // And the producer is named, so the reader knows whose conclusion it is.
    expect(prompts.second).toContain("(first)")
  })

  it("keeps a failed agent out of the upstream block", async () => {
    const prompts: Record<string, string> = {}
    handler = async (task) => {
      prompts[task.agentId] = task.prompt
      if (task.agentId === "first") throw new Error("boom")
      return { output: "done", exitCode: 0 }
    }

    await runOrch(
      [
        agent("first", { name: "FAILED_UPSTREAM", taskPrompt: "{{upstreamOutputs}}" }),
        agent("second", {
          name: "Second",
          dependsOn: ["first"],
          taskPrompt: "{{upstreamOutputs}}",
        }),
      ],
      { continueOnError: true }
    )

    // A failed agent's partial output is not a conclusion to build on, so it
    // must not appear as an upstream entry at all — not even as an empty bullet.
    expect(prompts.second).not.toContain("FAILED_UPSTREAM")
    expect(prompts.second).not.toContain("## What upstream produced")
  })

  it("leaves no upstream block before any stage has run", async () => {
    const prompts: Record<string, string> = {}
    handler = async (task) => {
      prompts[task.agentId] = task.prompt
      return { output: "out", exitCode: 0 }
    }

    await runOrch([agent("solo", { taskPrompt: "before\n{{upstreamOutputs}}\nafter" })])

    // Empty rather than a placeholder: the block is not there, so neither is its
    // heading, and the model is not handed the literal `{{upstreamOutputs}}`.
    expect(prompts.solo).not.toContain("## What upstream produced")
    expect(prompts.solo).not.toContain("{{upstreamOutputs}}")
  })
})
