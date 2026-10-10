import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { AgentRunner } from "./AgentRunner"
import { ContextManager } from "./ContextManager"
import { EventBus } from "../event/EventBus"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import type { AgentTask, AgentOutput } from "../types/runtime"
import type { MultiClawEvent } from "../types/event"

const RUNTIME = "test-agent-runner"

let handler: (task: AgentTask) => Promise<AgentOutput> = async () => ({
  output: "",
  exitCode: 0,
})

beforeAll(() => {
  runtimeRegistry.register(fakeRuntime(RUNTIME, (task) => handler(task)))
})

let workDir: string
let bus: EventBus
let events: MultiClawEvent[]
let context: ContextManager

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-"))
  bus = new EventBus()
  events = []
  bus.subscribe((e) => events.push(e))
  context = new ContextManager()
  handler = async () => ({ output: "", exitCode: 0 })
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
  vi.useRealTimers()
})

const makeRunner = () => new AgentRunner(bus, context, workDir)

describe("AgentRunner.run", () => {
  it("reports a successful run with the runtime output", async () => {
    handler = async () => ({ output: "hello world", exitCode: 0 })
    const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    expect(result).toMatchObject({
      agentId: "a",
      agentName: "a",
      status: "success",
      output: "hello world",
      attempts: 1,
    })
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["agent:start", "agent:complete"])
    )
  })

  it("reports a failed run with the error message", async () => {
    handler = async () => {
      throw new Error("kaboom")
    }
    const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    expect(result.status).toBe("failed")
    expect(result.error).toBe("kaboom")
    expect(result.attempts).toBe(1)
    expect(events.some((e) => e.type === "agent:failed")).toBe(true)
  })

  it("retries a flaky agent and emits agent:retrying", async () => {
    vi.useFakeTimers()
    let calls = 0
    handler = async () => {
      calls += 1
      if (calls === 1) throw new Error("flaky")
      return { output: "ok", exitCode: 0 }
    }

    const promise = makeRunner().run(
      makeAgent({ id: "a", runtime: RUNTIME, retries: 1 })
    )
    await vi.advanceTimersByTimeAsync(2000) // default backoff
    const result = await promise

    expect(result.status).toBe("success")
    expect(result.attempts).toBe(2)
    const retrying = events.filter((e) => e.type === "agent:retrying")
    expect(retrying).toHaveLength(1)
    expect(retrying[0].payload).toMatchObject({ attempt: 1, maxAttempts: 2 })
  })

  it("fails the agent when the runtime exceeds the timeout", async () => {
    vi.useFakeTimers()
    handler = () => new Promise<AgentOutput>(() => {})

    const promise = makeRunner().run(
      makeAgent({ id: "a", runtime: RUNTIME, timeout: 100 })
    )
    await vi.advanceTimersByTimeAsync(100)
    const result = await promise

    expect(result.status).toBe("failed")
    expect(result.error).toContain("timed out")
  })

  it("renders the task prompt with context and per-agent scope", async () => {
    let seen: AgentTask | undefined
    handler = async (task) => {
      seen = task
      return { output: "ok", exitCode: 0 }
    }
    context = new ContextManager({ project: "MultiClaw" })

    await makeRunner().run(
      makeAgent({
        id: "a",
        runtime: RUNTIME,
        taskPrompt: "Build {{project}} [{{agentScope}}]",
        agentScope: "scope-x",
      })
    )

    expect(seen?.prompt).toBe("Build MultiClaw [scope-x]")
  })

  it("forwards runtime output chunks as agent:output events", async () => {
    handler = async (task) => {
      task.onOutput?.("chunk-1")
      task.onOutput?.("chunk-2")
      return { output: "done", exitCode: 0 }
    }

    await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    const outputs = events.filter((e) => e.type === "agent:output")
    expect(outputs.map((e) => e.payload)).toEqual([
      { agentId: "a", chunk: "chunk-1" },
      { agentId: "a", chunk: "chunk-2" },
    ])
  })

  it("resolves a relative agent workDir under the global work dir", async () => {
    let seen: AgentTask | undefined
    handler = async (task) => {
      seen = task
      return { output: "ok", exitCode: 0 }
    }

    await makeRunner().run(
      makeAgent({ id: "a", runtime: RUNTIME, workDir: "sub/dir" })
    )

    const expected = path.join(workDir, "sub", "dir")
    expect(fs.existsSync(expected)).toBe(true)
    expect(seen?.workDir).toBe(expected)
  })
})
