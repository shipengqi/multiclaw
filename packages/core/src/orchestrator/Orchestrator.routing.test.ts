import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { agents as presets } from "../agents"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent, makeSessionRecord } from "../testing/helpers"
import {
  type TestConfig as MultiClawConfig,
  TestOrchestrator as Orchestrator,
} from "../testing/orchestration"
import type { AgentDefinition } from "../types/agent"
import type { WorkContext } from "../types/config"
import type { MultiClawEvent } from "../types/event"
import type {
  AgentOutput,
  AgentTask,
  RuntimeSession,
  RuntimeSessionOptions,
} from "../types/runtime"
import { imageReference } from "../utils/images"
import { AgentSessionManager } from "./AgentSessionManager"

const runtime = "test-work-routing"
let dir: string
let handler: (task: AgentTask) => Promise<AgentOutput>
let seen: AgentTask[]
const agent = (id: string, extra: Partial<AgentDefinition> = {}) =>
  makeAgent({ id, runtime, ...extra })
const ok = (output = "done", costUsd?: number): AgentOutput => ({
  output,
  exitCode: 0,
  ...(costUsd === undefined ? {} : { costUsd }),
})
const route = (run: string[], more = {}) => ok(JSON.stringify({ mode: "run", run, ...more }))
const handoff = (reason = "Needs another role") =>
  ok("<multiclaw-handoff>" + JSON.stringify({ reason }) + "</multiclaw-handoff>", 2)
const previous = (): WorkContext => ({
  id: "work-1",
  originalRequirement: "Build an API",
  requirement: "Build an API using SQLite",
  agents: [
    {
      agentId: "dev",
      scope: "API",
      plan: "Inspect and verify",
      session: makeSessionRecord(
        { runtime, agentId: "dev", workId: "work-1", sessionId: "session-1" },
        { workDir: dir }
      ),
    },
  ],
  outcome: { execution: "success", completedAgents: ["dev"], failedAgents: [] },
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-"))
  seen = []
  handler = async () => ok()
  runtimeRegistry.register({
    ...fakeRuntime(runtime, async (task) => {
      seen.push(task)
      return handler(task)
    }),
    openSession: async (options) => {
      let state: RuntimeSession["state"] = "idle"
      const sessionId = options.sessionId ?? "new-" + options.agentId
      return {
        sessionId,
        get state() {
          return state
        },
        capabilities: { continuation: true, load: true, supplement: false },
        prompt: async (prompt, callbacks) => {
          state = "running"
          const task = { ...options, prompt, timeout: options.timeout ?? 1000, ...callbacks }
          seen.push(task)
          try {
            return { ...(await handler(task)), sessionId }
          } finally {
            state = "idle"
          }
        },
        close: async () => {
          state = "closed"
        },
        cancelTurn: async () => {},
      }
    },
  })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
const config = (overrides: Partial<MultiClawConfig> = {}): MultiClawConfig => ({
  name: "routing",
  workDir: dir,
  context: { requirement: "Add pagination" },
  agents: [agent("dev"), agent("other")],
  coordinatorFixture: agent("leader"),
  ...overrides,
})
async function run(overrides: Partial<MultiClawConfig> = {}, sessions?: AgentSessionManager) {
  const orchestrator = new Orchestrator(config(overrides), sessions)
  const events: MultiClawEvent[] = []
  orchestrator.eventBus.subscribe((event) => events.push(event))
  return { result: await orchestrator.run(), events }
}

describe("work routing", () => {
  it("preserves native images when the leader rewrites the requirement", async () => {
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64"
    )
    const file = path.join(dir, "screenshot.png")
    fs.writeFileSync(file, image)
    handler = async (task) =>
      task.agentId === "leader"
        ? route(["dev"], { requirement: "Build the pictured interface" })
        : ok()
    const { result } = await run({
      context: { requirement: `Use this screenshot\n${imageReference(file)}` },
    })
    expect(result.success).toBe(true)
    expect(result.requirement).toContain(imageReference(file))
    expect(seen.map((task) => task.images)).toEqual([
      [{ data: image.toString("base64"), mimeType: "image/png" }],
      [{ data: image.toString("base64"), mimeType: "image/png" }],
    ])
  })
  it("continues only the supplied work and preserves source and full requirements", async () => {
    handler = async (task) =>
      task.agentId === "leader"
        ? ok(
            JSON.stringify({
              mode: "continue",
              workId: "work-1",
              run: ["dev"],
              tasks: [{ agentId: "dev", scope: "Pagination" }],
            })
          )
        : ok()
    const { result } = await run({ latestWork: previous() })
    expect(result.success).toBe(true)
    expect(result.work?.id).toBe("work-1")
    expect(result.originalRequirement).toBe("Add pagination")
    expect(result.requirement).toContain("Build an API using SQLite")
    expect(result.requirement).toContain("Add pagination")
    expect(seen[1].sessionId).toBe("session-1")
    expect(seen[1].prompt).toContain("Pagination")
    expect(seen[1].prompt).toContain("Inspect the workspace")
  })

  it.each([
    undefined,
    { ...previous(), id: "other-work" },
    {
      ...previous(),
      outcome: { execution: "cancelled" as const, completedAgents: [], failedAgents: [] },
    },
  ])(
    "rejects an unknown or cancelled continuation without executing workers",
    async (latestWork) => {
      handler = async () => ok('{"mode":"continue","workId":"work-1","run":["dev"]}')
      const { result, events } = await run({ latestWork })
      expect(result.success).toBe(false)
      expect(result.routing?.error).toContain("Routing incomplete")
      expect(seen.map((item) => item.agentId)).toEqual(["leader", "leader"])
      expect(events.filter((event) => event.type === "orchestration:complete")).toHaveLength(1)
    }
  )

  it("corrects an invalid decision once and does not turn malformed JSON into a reply", async () => {
    let calls = 0
    handler = async (task) =>
      task.agentId !== "leader" ? ok() : ++calls === 1 ? ok('{"mode":"continue"}') : route(["dev"])
    expect((await run()).result.success).toBe(true)
    expect(calls).toBe(2)
    expect(seen[1].prompt).toContain("previous routing decision was invalid")
  })

  it("keeps legacy code explanations as replies", async () => {
    handler = async () =>
      ok(
        "Use this expression:\n" +
          String.fromCharCode(96).repeat(3) +
          "ts\nx + 1\n" +
          String.fromCharCode(96).repeat(3)
      )
    expect((await run()).result.reply?.mode).toBe("reply")
    expect(seen).toHaveLength(1)
  })

  it("runs multiple workers without a planner using configuration dependencies", async () => {
    handler = async (task) => (task.agentId === "leader" ? route(["dev", "other"]) : ok())
    const { result } = await run({ agents: [agent("dev"), agent("other", { dependsOn: ["dev"] })] })
    expect(result.success).toBe(true)
    expect(seen.map((task) => task.agentId)).toEqual(["leader", "dev", "other"])
    for (const task of seen.slice(1)) expect(task.prompt).toContain("Add pagination")
  })

  it("does not reuse an unbound old planner file on continuation", async () => {
    fs.writeFileSync(
      path.join(dir, "task-plan.json"),
      JSON.stringify({ tasks: [{ id: "dev", scope: "stale plan" }] })
    )
    handler = async (task) =>
      task.agentId === "leader"
        ? ok('{"mode":"continue","workId":"work-1","run":["planner","dev"]}')
        : ok()
    const { result } = await run({
      latestWork: previous(),
      agents: [agent("planner", { role: "planner" }), agent("dev", { dependsOn: ["planner"] })],
    })
    expect(result.success).toBe(true)
    expect(seen.find((task) => task.agentId === "dev")?.prompt).not.toContain("stale plan")
  })

  it("retains plain legacy replies without assigning work", async () => {
    handler = async () => ok("Hello, what would you like to build?")
    const { result } = await run()
    expect(result.reply?.mode).toBe("reply")
    expect(result.work).toBeUndefined()
    expect(seen).toHaveLength(1)
  })

  it.each([
    { tasks: [{ agentId: "other", scope: "unselected" }] },
    { tasks: [{ agentId: "dev", scope: "" }] },
    {
      tasks: [
        { agentId: "dev", scope: "one" },
        { agentId: "dev", scope: "two" },
      ],
    },
  ])("rejects malformed responsibility assignments", async (more) => {
    handler = async () => route(["dev"], more)
    expect((await run()).result.success).toBe(false)
    expect(seen).toHaveLength(2)
  })

  it.each([false, true])(
    "runs a built-in developer without requiring a selected architect (%s)",
    async (configuredArchitect) => {
      handler = async (task) =>
        task.agentId === "leader"
          ? route(["backend-developer"], {
              tasks: [{ agentId: "backend-developer", scope: "Implement pagination only" }],
            })
          : ok()
      const developer = presets.backendDeveloper({ runtime })
      const { result } = await run({
        agents: [developer, ...(configuredArchitect ? [agent("architect")] : [])],
      })
      expect(result.success).toBe(true)
      expect(seen.map((task) => task.agentId)).toEqual(["leader", "backend-developer"])
      expect(seen[1].prompt).toContain("optional context")
      expect(seen[1].prompt).toContain("Implement pagination only")
      expect(seen[1].prompt).toContain("[file not found: artifact:architecture.md]")
      expect(seen[1].prompt).not.toContain("{{agentScope}}")
    }
  )

  it("supports another planner id and applies its plan after its stage", async () => {
    handler = async (task) => {
      if (task.agentId === "leader") return route(["planner", "dev"])
      if (task.agentId === "planner")
        fs.writeFileSync(
          task.prompt.match(/^Task plan: (.+)$/m)![1],
          JSON.stringify({ tasks: [{ id: "dev", scope: "Scoped by planner", plan: ["Verify"] }] })
        )
      return ok()
    }
    const { result } = await run({
      agents: [agent("planner", { role: "planner" }), agent("dev", { dependsOn: ["planner"] })],
    })
    expect(result.success).toBe(true)
    expect(seen[2].prompt).toContain("Scoped by planner")
    expect(result.work?.agents.find((item) => item.agentId === "dev")?.plan).toContain("Verify")
  })

  it("preserves this turn's responsibility over a planner's broader scope", async () => {
    handler = async (task) => {
      if (task.agentId === "leader")
        return route(["planner", "dev"], { tasks: [{ agentId: "dev", scope: "Pagination only" }] })
      if (task.agentId === "planner")
        fs.writeFileSync(
          task.prompt.match(/^Task plan: (.+)$/m)![1],
          JSON.stringify({
            tasks: [{ id: "dev", scope: "Rewrite API", plan: ["Verify pagination"] }],
          })
        )
      return ok()
    }
    const { result } = await run({
      agents: [agent("planner", { role: "planner" }), agent("dev", { dependsOn: ["planner"] })],
    })
    expect(result.success).toBe(true)
    expect(result.work?.agents.find((item) => item.agentId === "dev")?.scope).toBe(
      "Pagination only"
    )
    expect(seen.find((task) => task.agentId === "dev")?.prompt).toContain("Verify pagination")
  })

  it("continues a recorded DAG without reading an unrelated plan file", async () => {
    const work = {
      ...previous(),
      agents: [
        { agentId: "dev", dependsOn: ["other"], scope: "API", plan: "Verify" },
        { agentId: "other", dependsOn: [], scope: "Prepare data" },
      ],
    }
    handler = async (task) =>
      task.agentId === "leader"
        ? ok('{"mode":"continue","workId":"work-1","run":["dev","other"]}')
        : ok()
    const { result } = await run({ latestWork: work })
    expect(result.success).toBe(true)
    expect(seen.map((task) => task.agentId)).toEqual(["leader", "other", "dev"])
    expect(result.work?.agents.find((item) => item.agentId === "dev")?.dependsOn).toEqual(["other"])
  })

  it("preview leaves existing plans and worker sessions untouched", async () => {
    handler = async () => route(["dev"])
    const plan = path.join(dir, "task-plan.json")
    fs.writeFileSync(plan, "sentinel")
    const sessions = new AgentSessionManager()
    const preview = await new Orchestrator(config(), sessions).preview()
    expect(preview.routing?.mode).toBe("run")
    expect(fs.readFileSync(plan, "utf8")).toBe("sentinel")
    expect(seen.map((item) => item.agentId)).toEqual(["leader"])
    await sessions.close()
  })

  it("emits coordinator dispatch message with plan and agent assignments", async () => {
    handler = async (task) =>
      task.agentId === "leader"
        ? route(["dev"], {
            message: "I will coordinate dev to add pagination.",
            tasks: [{ agentId: "dev", scope: "Implement page query" }],
          })
        : ok()
    const { events } = await run()
    const msg = events.find((e) => e.type === "coordinator:message" && e.payload.mode === "route")
    expect(msg).toBeDefined()
    if (msg?.type !== "coordinator:message") throw new Error("Missing dispatch message")
    expect(msg?.payload.message).toContain("I will coordinate dev to add pagination.")
    expect(msg?.payload.message).toContain("dev")
    expect(msg?.payload.message).toContain("Implement page query")
    expect(msg?.payload.message).toContain("Ctrl+T")
    expect(events.indexOf(msg!)).toBeLessThan(events.findIndex((e) => e.type === "stage:start"))
  })

  it("formats default coordinator dispatch message when leader message is omitted", async () => {
    handler = async (task) =>
      task.agentId === "leader"
        ? route(["dev"], {
            reason: "Only developer is needed",
          })
        : ok()
    const { events } = await run()
    const msg = events.find((e) => e.type === "coordinator:message" && e.payload.mode === "route")
    expect(msg).toBeDefined()
    if (msg?.type !== "coordinator:message") throw new Error("Missing dispatch message")
    expect(msg?.payload.message).toContain("Only developer is needed")
    expect(msg?.payload.message).toContain("dev")
  })
})

describe("worker handoff", () => {
  it("reroutes once after the entire stage, retaining audit and replacing effective results", async () => {
    let calls = 0
    handler = async (task) =>
      task.agentId === "leader"
        ? route(++calls === 1 ? ["dev"] : ["other"])
        : task.agentId === "dev"
          ? handoff()
          : ok("repaired", 3)
    const { result, events } = await run()
    expect(result.success).toBe(true)
    expect(result.agentResults.map((item) => item.status)).toEqual(["handed_back", "success"])
    expect(result.effectiveAgentResults?.map((item) => item.agentId)).toEqual(["other"])
    expect(result.work?.outcome?.completedAgents).toEqual(["other"])
    expect(result.routing?.reroutes).toBe(1)
    expect(result.totalCostUsd).toBe(5)
    expect(events.filter((event) => event.type === "orchestration:complete")).toHaveLength(1)
    expect(seen[2].prompt).toContain("Needs another role")
    expect(seen[2].prompt).toContain("Add pagination")
    expect(seen[3].prompt).toContain("Check the workspace")
  })

  it("merges multiple handbacks and never starts old downstream stages", async () => {
    let calls = 0
    handler = async (task) =>
      task.agentId === "leader"
        ? route(++calls === 1 ? ["dev", "other", "later"] : ["replacement"])
        : ["dev", "other"].includes(task.agentId)
          ? handoff(task.agentId)
          : ok()
    const { result } = await run({
      agents: [
        agent("dev"),
        agent("other"),
        agent("later", { dependsOn: ["dev", "other"] }),
        agent("replacement"),
      ],
    })
    expect(result.success).toBe(true)
    expect(seen.some((task) => task.agentId === "later")).toBe(false)
    expect(result.agentResults.filter((item) => item.status === "handed_back")).toHaveLength(2)
    expect(seen.find((task, index) => index > 0 && task.agentId === "leader")?.prompt).toContain(
      '"handoffReason":"other"'
    )
  })

  it("stops on a second handback", async () => {
    let calls = 0
    handler = async (task) =>
      task.agentId === "leader" ? route(++calls === 1 ? ["dev"] : ["other"]) : handoff()
    const { result } = await run()
    expect(result.success).toBe(false)
    expect(result.routing?.error).toContain("budget exhausted")
    expect(calls).toBe(2)
  })

  it.each([false, true])("does not expand a leaderless or fixed retry team (%s)", async (fixed) => {
    handler = async () => handoff()
    const { result } = await run(
      fixed
        ? { resume: { agents: ["dev"] } }
        : { coordinatorFixture: undefined, agents: [agent("dev")] }
    )
    expect(result.success).toBe(false)
    expect(seen.map((task) => task.agentId)).toEqual(["dev"])
    expect(result.routing?.error).toContain(fixed ? "fixed team" : "Routing incomplete")
  })

  it.each(["failed", "cancelled"])("does not reroute over a same-stage %s", async (status) => {
    handler = async (task) =>
      task.agentId === "leader"
        ? route(["dev", "other"])
        : task.agentId === "dev"
          ? handoff()
          : {
              output: "failure",
              exitCode: 1,
              stopReason: status === "cancelled" ? "cancelled" : "error",
            }
    const { result } = await run({ continueOnError: true })
    expect(result.success).toBe(false)
    expect(seen.filter((task) => task.agentId === "leader")).toHaveLength(1)
  })

  it("reroutes a repair handoff, rechecks checkpoints and never reuses the old approval", async () => {
    let routes = 0
    let devCalls = 0
    let reviews = 0
    let checkpoints = 0
    handler = async (task) => {
      if (task.agentId === "leader") return route(++routes === 1 ? ["dev"] : ["other"])
      if (task.agentId === "reviewer")
        return ok(
          JSON.stringify(
            ++reviews === 1
              ? { verdict: "changes_required", summary: "Fix", issues: ["bug"] }
              : { verdict: "approved", summary: "verified", issues: [] }
          )
        )
      if (task.agentId === "dev" && ++devCalls === 2) return handoff()
      return ok()
    }
    const { result } = await run({
      agents: [agent("dev"), agent("other"), agent("reviewer")],
      review: { reviewer: "reviewer", repairAgents: ["dev", "other"], maxRepairRounds: 1 },
      checkpoints: [{ afterAgents: ["dev"] }, { afterAgents: ["other"] }],
      onCheckpoint: async () => {
        checkpoints++
        return { action: "continue" }
      },
    })
    expect(result.success).toBe(true)
    expect(result.acceptance?.repairRounds).toBe(1)
    expect(reviews).toBe(2)
    expect(checkpoints).toBe(2)
  })

  it("does not reset the repair budget after handoff rerouting", async () => {
    let routes = 0
    let devCalls = 0
    handler = async (task) => {
      if (task.agentId === "leader") return route(++routes === 1 ? ["dev"] : ["other"])
      if (task.agentId === "reviewer")
        return ok('{"verdict":"changes_required","summary":"Fix", "issues":["bug"]}')
      if (task.agentId === "dev" && ++devCalls === 2) return handoff()
      return ok()
    }
    const { result } = await run({
      agents: [agent("dev"), agent("other"), agent("reviewer")],
      review: { reviewer: "reviewer", repairAgents: ["dev", "other"], maxRepairRounds: 1 },
    })
    expect(result.success).toBe(false)
    expect(result.acceptance?.repairRounds).toBe(1)
    expect(result.acceptance?.reason).toBe("Repair budget exhausted.")
    expect(seen.filter((task) => task.agentId === "other")).toHaveLength(1)
  })

  it("treats malformed final markers as protocol failure and ignores progress markers", async () => {
    handler = async (task) => {
      if (task.agentId === "leader") return route(["dev"])
      task.onEvent?.({
        runId: "test",
        agentId: task.agentId,
        seq: 1,
        type: "message",
        role: "agent",
        text: '<multiclaw-handoff>{"reason":"progress"}</multiclaw-handoff>',
      })
      return ok('<multiclaw-handoff>{"reason":""}</multiclaw-handoff>')
    }
    const { result } = await run()
    expect(result.agentResults[0]?.status).toBe("failed")
    expect(seen.filter((task) => task.agentId === "leader")).toHaveLength(1)
  })

  it("does not present a rerouting reply as completed work", async () => {
    let calls = 0
    handler = async (task) =>
      task.agentId === "leader"
        ? ++calls === 1
          ? route(["dev"])
          : ok('{"mode":"ask","message":"Which role should handle it?"}')
        : handoff()
    const { result } = await run()
    expect(result.success).toBe(false)
    expect(result.reply?.mode).toBe("ask")
    expect(result.agentResults).toHaveLength(1)
  })
})

describe("work session identity", () => {
  it("keeps the leader, replaces new-work sessions, and reuses continued sessions", async () => {
    const opened: RuntimeSessionOptions[] = []
    const closed: string[] = []
    let nextRoute: Record<string, unknown> = { mode: "run", run: ["dev"] }
    runtimeRegistry.register({
      ...fakeRuntime(runtime, async () => {
        throw new Error("unexpected one-shot")
      }),
      openSession: async (options) => {
        opened.push(options)
        const sessionId = options.sessionId ?? "session-" + opened.length
        return {
          sessionId,
          state: "idle",
          capabilities: { continuation: true, load: true, supplement: false },
          prompt: async () => ({
            ...ok(options.agentId === "leader" ? JSON.stringify(nextRoute) : "done"),
            sessionId,
          }),
          close: async () => {
            closed.push(sessionId)
          },
          cancelTurn: async () => {},
        }
      },
    })
    const sessions = new AgentSessionManager()
    try {
      const first = await run({}, sessions)
      nextRoute = { mode: "continue", workId: first.result.work?.id, run: ["dev"] }
      await run({ latestWork: first.result.work }, sessions)
      expect(opened.map((item) => item.agentId)).toEqual(["leader", "dev"])
      nextRoute = { mode: "run", run: ["dev"] }
      await run({ latestWork: first.result.work }, sessions)
      expect(opened.map((item) => item.agentId)).toEqual(["leader", "dev", "dev"])
      expect(closed).toEqual(["session-2"])
    } finally {
      await sessions.close()
    }
  })

  it("retains a loaded session across subsequent continuations", async () => {
    const opened: RuntimeSessionOptions[] = []
    runtimeRegistry.register({
      ...fakeRuntime(runtime, async () => ok()),
      openSession: async (options) => {
        opened.push(options)
        const sessionId = options.sessionId ?? "new-" + options.agentId
        return {
          sessionId,
          state: "idle",
          capabilities: { continuation: true, load: true, supplement: false },
          prompt: async () => ({
            ...ok(
              options.agentId === "leader"
                ? '{"mode":"continue","workId":"work-1","run":["dev"]}'
                : "done"
            ),
            sessionId,
          }),
          close: async () => {},
          cancelTurn: async () => {},
        }
      },
    })
    const sessions = new AgentSessionManager()
    try {
      const first = await run({ latestWork: previous() }, sessions)
      await run({ latestWork: first.result.work }, sessions)
      expect(opened.filter((item) => item.agentId === "dev")).toHaveLength(1)
      expect(opened.find((item) => item.agentId === "dev")?.sessionId).toBe("session-1")
    } finally {
      await sessions.close()
    }
  })
  it("reports a failed Session load without claiming restoration", async () => {
    runtimeRegistry.register({
      ...fakeRuntime(runtime, async () => ok()),
      openSession: async (options) => {
        if (options.sessionId) throw new Error("Session load failed")
        return {
          sessionId: "leader-session",
          state: "idle",
          capabilities: { continuation: true, load: true, supplement: false },
          prompt: async () => ok('{"mode":"continue","workId":"work-1","run":["dev"]}'),
          close: async () => {},
          cancelTurn: async () => {},
        }
      },
    })
    const sessions = new AgentSessionManager()
    try {
      const { result } = await run(
        { latestWork: previous(), agents: [agent("dev", { retries: 0 })] },
        sessions
      )
      expect(result.success).toBe(false)
      expect(result.agentResults[0]?.error).toContain("Session load failed")
      expect(result.agentResults[0]?.session?.sessionId).toBeUndefined()
    } finally {
      await sessions.close()
    }
  })
  it("creates a new executor Session when continuation is unsupported", async () => {
    let opened = 0
    let nextRoute: Record<string, unknown> = { mode: "run", run: ["dev"] }
    runtimeRegistry.register({
      ...fakeRuntime(runtime, async () => ok()),
      openSession: async (options) => {
        const sessionId = "session-" + ++opened
        return {
          sessionId,
          state: "idle",
          capabilities: {
            continuation: options.agentId === "leader",
            load: options.agentId === "leader",
            supplement: false,
          },
          prompt: async () => ({
            ...ok(options.agentId === "leader" ? JSON.stringify(nextRoute) : "done"),
            sessionId,
          }),
          close: async () => {},
          cancelTurn: async () => {},
        }
      },
    })
    const sessions = new AgentSessionManager()
    try {
      const first = await run({}, sessions)
      nextRoute = { mode: "continue", workId: first.result.work?.id, run: ["dev"] }
      const second = await run({ latestWork: first.result.work }, sessions)
      expect(second.result.success).toBe(true)
      expect(second.result.agentResults[0]?.session?.sessionId).not.toBe(
        first.result.agentResults[0]?.session?.sessionId
      )
      expect(
        second.events.some(
          (event) =>
            event.type === "agent:session" &&
            event.payload.action === "created" &&
            event.payload.record.agentId === "dev"
        )
      ).toBe(true)
      expect(opened).toBe(3)
    } finally {
      await sessions.close()
    }
  })
})
