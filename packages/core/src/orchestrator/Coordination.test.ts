import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import type { AgentRuntime, AgentTask, RuntimeSession } from "../types/runtime"
import { AgentSessionManager } from "./AgentSessionManager"
import { Coordinator } from "./Coordinator"
import { COORDINATOR_ID } from "./coordinatorAgent"
import { Orchestrator } from "./Orchestrator"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const original = runtimeRegistry.get("acp")
const dirs: string[] = []
afterEach(() => {
  runtimeRegistry.register(original)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function config(review = false) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "coordination-"))
  dirs.push(workDir)
  return {
    name: "test",
    workDir,
    context: { requirement: "Build API" },
    defaults: { model: "project-model" },
    agents: [makeAgent({ id: "dev" }), makeAgent({ id: "tester", dependsOn: ["dev"] })],
    ...(review
      ? { reviewGates: [{ reviewer: "tester", repairAgents: ["dev"], maxRepairRounds: 2 }] }
      : {}),
  }
}
function runtime(
  worker: (task: AgentTask) => Promise<string>,
  supplement: "supported" | "unsupported" | "unknown" = "unsupported",
  selected = ["dev", "tester"]
): AgentRuntime {
  const execute = async (task: AgentTask) => {
    let output: string
    if (task.agentId === COORDINATOR_ID) {
      if (task.prompt.includes("Phase: summary")) output = "Implemented and verified the API."
      else if (task.prompt.includes("Phase: chat")) {
        const facts = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf("\n") + 1))
        output = JSON.stringify(
          facts.message.includes("progress")
            ? { mode: "reply", message: "Developer is working." }
            : {
                mode: "supplement",
                message: "Updating developer",
                workId: facts.work.id,
                text: facts.message,
                agents: ["dev"],
              }
        )
      } else output = JSON.stringify({ mode: "run", run: selected, requirement: "Build API" })
    } else output = await worker(task)
    return { output, exitCode: 0 }
  }
  const r = fakeRuntime("acp", execute)
  let serial = 0
  r.openSession = async (task) => {
    let state: RuntimeSession["state"] = "idle"
    const session: RuntimeSession = {
      sessionId: "provider-" + ++serial,
      get state() {
        return state
      },
      capabilities: { continuation: true, load: false, supplement: supplement !== "unsupported" },
      async prompt(prompt, options) {
        state = "running"
        try {
          return await execute({
            ...task,
            ...options,
            prompt,
            timeout: options?.timeout ?? task.timeout ?? 1000,
          })
        } finally {
          state = "idle"
        }
      },
      async supplement() {
        if (supplement === "unknown") throw new Error("Connection lost after sending")
        return { status: state === "running" ? "injected" : "idle" }
      },
      async cancelTurn() {
        state = "idle"
      },
      async close() {
        state = "closed"
      },
    }
    return session
  }
  return r
}

describe("permanent coordinator and dependency-constrained live work", () => {
  it("uses project defaults, routes internally and emits a separate summary", async () => {
    const tasks: string[] = []
    const r = runtime(async (task) => {
      tasks.push(task.agentId)
      expect(task.model).toBe("project-model")
      return "done"
    })
    runtimeRegistry.register(r)
    const result = await new Orchestrator(config()).run()
    expect(tasks).toEqual(["dev", "tester"])
    expect(result.summary).toContain("verified")
    expect(result.reply).toBeUndefined()
    expect(result.agentResults).toHaveLength(2)
    expect(result.coordinatorSession?.agentId).toBe(COORDINATOR_ID)
  })
  it.each(["supported", "unsupported"] as const)(
    "processes %s supplements before releasing downstream",
    async (capability) => {
      const started = deferred(),
        finish = deferred()
      const calls: string[] = []
      runtimeRegistry.register(
        runtime(async (task) => {
          calls.push(task.agentId)
          if (calls.length === 1) {
            started.resolve()
            await finish.promise
          }
          if (calls.length > 1) expect(task.prompt).toContain("pagination")
          return "done"
        }, capability)
      )
      const orchestrator = new Orchestrator(config())
      const execution = orchestrator.run()
      await started.promise
      const delivery = await orchestrator.supplement("Support pagination", ["dev"], "message-1")
      expect(delivery.deliveries[0].status).toBe(
        capability === "supported" ? "delivered" : "pending"
      )
      finish.resolve()
      const result = await execution
      expect(calls).toEqual(["dev", "dev", "tester"])
      expect(orchestrator.snapshot.supplements[0].deliveries[0].status).toBe("applied")
      expect(result.work?.revision).toBe(2)
      expect(result.success).toBe(true)
    }
  )
  it("does not replay unknown delivery or let downstream run with unresolved requirements", async () => {
    const started = deferred(),
      finish = deferred()
    const calls: string[] = []
    runtimeRegistry.register(
      runtime(async (task) => {
        calls.push(task.agentId)
        started.resolve()
        await finish.promise
        return "done"
      }, "unknown")
    )
    const orchestrator = new Orchestrator(config())
    const execution = orchestrator.run()
    await started.promise
    expect((await orchestrator.supplement("pagination", ["dev"])).deliveries[0].status).toBe(
      "unknown"
    )
    finish.resolve()
    expect((await execution).success).toBe(false)
    expect(calls).toEqual(["dev"])
  })
  it("invalidates an older review when requirements change while the reviewer is running", async () => {
    const reviewStarted = deferred(),
      finishReview = deferred()
    const calls: string[] = []
    runtimeRegistry.register(
      runtime(async (task) => {
        calls.push(task.agentId)
        if (calls.length === 2) {
          reviewStarted.resolve()
          await finishReview.promise
        }
        return task.agentId === "tester"
          ? JSON.stringify({ verdict: "approved", summary: "tests pass", issues: [] })
          : "done"
      })
    )
    const orchestrator = new Orchestrator(config(true))
    const execution = orchestrator.run()
    await reviewStarted.promise
    await orchestrator.supplement("pagination", ["dev"])
    finishReview.resolve()
    const result = await execution
    expect(calls).toEqual(["dev", "tester", "dev", "tester"])
    expect(result.gateResults?.[0].revision).toBe(2)
    expect(result.success).toBe(true)
  })
  it("handles chat while workers are running, without reusing their runtime binding", async () => {
    const started = deferred(),
      finish = deferred()
    runtimeRegistry.register(
      runtime(async () => {
        started.resolve()
        await finish.promise
        return "done"
      })
    )
    const c = config()
    const coordinator = new Coordinator(c)
    const workers = new AgentSessionManager()
    const orchestrator = new Orchestrator(c, workers, { coordinator })
    const execution = orchestrator.run()
    await started.promise
    const facts = orchestrator.snapshot
    const decision = await coordinator.chat("progress?", {
      work: facts.work!,
      results: [],
      history: [],
      supplements: [],
    })
    expect(decision).toEqual({ mode: "reply", message: "Developer is working." })
    finish.resolve()
    await execution
    await coordinator.close()
    await workers.close()
  })
  it("rejects removed leader configuration rather than silently ignoring it", () => {
    expect(
      () => new Orchestrator({ ...config(), leader: makeAgent({ id: "leader" }) } as never)
    ).toThrow("no longer supported")
  })
  it("does not invalidate agents omitted from the selected pipeline", async () => {
    const started = deferred(),
      finish = deferred()
    const calls: string[] = []
    runtimeRegistry.register(
      runtime(
        async (task) => {
          calls.push(task.agentId)
          if (calls.length === 1) {
            started.resolve()
            await finish.promise
          }
          return "done"
        },
        "unsupported",
        ["dev"]
      )
    )
    const orchestrator = new Orchestrator(config())
    const running = orchestrator.run()
    await started.promise
    await orchestrator.supplement("pagination", ["dev"])
    finish.resolve()
    expect((await running).success).toBe(true)
    expect(calls).toEqual(["dev", "dev"])
  })
  it("can add an unselected recipient while respecting its dependencies", async () => {
    const started = deferred(),
      finish = deferred()
    const calls: string[] = []
    runtimeRegistry.register(
      runtime(
        async (task) => {
          calls.push(task.agentId)
          if (calls.length === 1) {
            started.resolve()
            await finish.promise
          }
          return "done"
        },
        "unsupported",
        ["dev"]
      )
    )
    const orchestrator = new Orchestrator(config())
    const running = orchestrator.run()
    await started.promise
    await orchestrator.supplement("Verify pagination", ["tester"])
    finish.resolve()
    const result = await running
    expect(calls).toEqual(["dev", "tester"])
    expect(result.work?.agents.map((a) => a.agentId)).toEqual(["dev", "tester"])
    expect(result.success).toBe(true)
  })
  it("does not dispatch downstream when revised work fails its review gate", async () => {
    const started = deferred(),
      finish = deferred()
    const calls: string[] = []
    let reviews = 0
    runtimeRegistry.register(
      runtime(
        async (task) => {
          calls.push(task.agentId)
          if (task.agentId !== "tester") return "done"
          if (++reviews === 1) {
            started.resolve()
            await finish.promise
          }
          return JSON.stringify({
            verdict: reviews === 1 ? "approved" : "changes_required",
            summary: "review",
            issues: reviews === 1 ? [] : ["pagination fails"],
          })
        },
        "unsupported",
        ["dev", "tester", "release"]
      )
    )
    const c = config(true)
    c.reviewGates![0].maxRepairRounds = 0
    c.agents.push(makeAgent({ id: "release", dependsOn: ["tester"] }))
    const orchestrator = new Orchestrator(c)
    const running = orchestrator.run()
    await started.promise
    await orchestrator.supplement("pagination", ["dev"])
    finish.resolve()
    expect((await running).success).toBe(false)
    expect(calls).not.toContain("release")
    expect(reviews).toBe(2)
  })
  it("reopens a previously approved checkpoint after affected artifacts are reworked", async () => {
    const started = deferred(),
      finish = deferred()
    let calls = 0,
      approvals = 0
    runtimeRegistry.register(
      runtime(async (task) => {
        if (++calls === 2) {
          started.resolve()
          await finish.promise
        }
        if (calls === 4) expect(approvals).toBe(2)
        return task.agentId + calls
      })
    )
    const c = {
      ...config(),
      checkpoints: [{ afterAgents: ["dev"] }],
      onCheckpoint: async () => {
        approvals++
        return { action: "continue" as const }
      },
    }
    const orchestrator = new Orchestrator(c)
    const running = orchestrator.run()
    await started.promise
    expect(approvals).toBe(1)
    await orchestrator.supplement("pagination", ["dev"])
    finish.resolve()
    expect((await running).success).toBe(true)
    expect(approvals).toBe(2)
  })
  it("deduplicates a delivery ID and rejects a conflicting reuse", async () => {
    const started = deferred(),
      finish = deferred()
    runtimeRegistry.register(
      runtime(async () => {
        started.resolve()
        await finish.promise
        return "done"
      }, "supported")
    )
    const orchestrator = new Orchestrator(config())
    const running = orchestrator.run()
    await started.promise
    await orchestrator.supplement("pagination", ["dev"], "same")
    await orchestrator.supplement("pagination", ["dev"], "same")
    expect(orchestrator.snapshot.work?.revision).toBe(2)
    await expect(orchestrator.supplement("different", ["dev"], "same")).rejects.toThrow(
      "Conflicting"
    )
    finish.resolve()
    await running
  })
  it("settles consecutive changes during rework before releasing downstream", async () => {
    const started = deferred(),
      finish = deferred(),
      reworking = deferred(),
      finishRework = deferred()
    const calls: string[] = []
    runtimeRegistry.register(
      runtime(async (task) => {
        calls.push(task.agentId)
        if (calls.length === 1) {
          started.resolve()
          await finish.promise
        }
        if (calls.length === 2) {
          reworking.resolve()
          await finishRework.promise
        }
        return "done"
      })
    )
    const orchestrator = new Orchestrator(config())
    const running = orchestrator.run()
    await started.promise
    await orchestrator.supplement("pagination", ["dev"])
    finish.resolve()
    await reworking.promise
    await orchestrator.supplement("sorting", ["dev"])
    finishRework.resolve()
    const result = await running
    expect(calls).toEqual(["dev", "dev", "dev", "tester"])
    expect(result.work?.revision).toBe(3)
    expect(result.success).toBe(true)
  })
  it("reports summary failure separately from successful execution", async () => {
    const r = runtime(async () => "done")
    const open = r.openSession!
    r.openSession = async (options) => {
      const session = await open(options)
      if (options.agentId === COORDINATOR_ID) {
        const prompt = session.prompt.bind(session)
        session.prompt = async (text, opts) => {
          if (text.includes("Phase: summary")) throw new Error("Summary unavailable")
          return prompt(text, opts)
        }
      }
      return session
    }
    runtimeRegistry.register(r)
    const result = await new Orchestrator(config()).run()
    expect(result.success).toBe(true)
    expect(result.summary).toBeUndefined()
    expect(result.summaryError).toContain("Summary unavailable")
  })
})
