import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { EventBus } from "../event/EventBus"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import type { MultiClawConfig } from "../types/config"
import type { MultiClawEvent } from "../types/event"
import type { AgentOutput, AgentTask } from "../types/runtime"
import { AgentRunner } from "./AgentRunner"
import { ContextManager } from "./ContextManager"

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

const makeRunner = (overrides: Partial<MultiClawConfig> = {}) =>
  new AgentRunner(bus, context, workDir, { name: "test", workDir, agents: [], ...overrides })

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

    const promise = makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME, retries: 1 }))
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

    const promise = makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME, timeout: 100 }))
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

  it("forwards agent text untagged and tool activity tagged by kind", async () => {
    handler = async (task) => {
      task.onEvent?.({
        runId: "r1",
        agentId: "a",
        seq: 0,
        type: "message_delta",
        role: "agent",
        text: "chunk-1",
      })
      task.onEvent?.({
        runId: "r1",
        agentId: "a",
        seq: 1,
        type: "tool_call",
        id: "t",
        name: "Bash",
        input: { command: "pnpm test" },
      })
      // A successful tool result is detail — verbose-only.
      task.onEvent?.({
        runId: "r1",
        agentId: "a",
        seq: 2,
        type: "tool_result",
        id: "t",
        output: "all green",
        isError: false,
      })
      // A failed tool result is a summary line the user needs by default.
      task.onEvent?.({
        runId: "r1",
        agentId: "a",
        seq: 3,
        type: "tool_result",
        id: "t",
        output: "boom",
        isError: true,
      })
      task.onEvent?.({
        runId: "r1",
        agentId: "a",
        seq: 4,
        type: "message_delta",
        role: "agent",
        text: "chunk-2",
      })
      return { output: "done", exitCode: 0 }
    }

    await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    const outputs = events.filter((e) => e.type === "agent:output")
    // Exactly the five chunks the runtime sent — no more (nothing invented) and
    // no fewer (nothing swallowed) — so the indices below are the whole story.
    expect(outputs).toHaveLength(5)
    // Text is untagged, so the payload shape is what it was before `kind`
    // existed and no existing consumer changes.
    expect(outputs[0].payload).toEqual({ agentId: "a", chunk: "chunk-1" })
    expect(outputs[4].payload).toEqual({ agentId: "a", chunk: "chunk-2" })
    // The tool call is a summary line, shown by default.
    expect(outputs[1].payload).toMatchObject({ agentId: "a", kind: "tool" })
    expect(outputs[1].payload.chunk).toContain("Bash")
    expect(outputs[1].payload.chunk).toContain("pnpm test")
    // A successful result is detail, a failed one is a default-visible summary.
    expect(outputs[2].payload).toMatchObject({ agentId: "a", kind: "tool-detail" })
    expect(outputs[2].payload.chunk).toContain("✓")
    expect(outputs[3].payload).toMatchObject({ agentId: "a", kind: "tool" })
    expect(outputs[3].payload.chunk).toContain("✗")
  })

  it("carries the runtime's usage, cost and model into the result", async () => {
    handler = async () => ({
      output: "ok",
      exitCode: 0,
      usage: { contextTokens: 45200, contextSize: 200000 },
      costUsd: 0.42,
    })

    const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME, model: "opus" }))

    expect(result.model).toBe("opus")
    expect(result.usage).toEqual({ contextTokens: 45200, contextSize: 200000 })
    expect(result.costUsd).toBe(0.42)
  })

  it("omits usage and cost entirely when the runtime reported neither", async () => {
    handler = async () => ({ output: "ok", exitCode: 0 })
    const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    // Absent, not zero: a run nobody priced did not cost nothing.
    expect(result.usage).toBeUndefined()
    expect(result.costUsd).toBeUndefined()
    expect("costUsd" in result).toBe(false)
  })

  it("records the model on a failure but no usage or cost", async () => {
    handler = async () => {
      throw new Error("kaboom")
    }
    const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME, model: "opus" }))

    expect(result.status).toBe("failed")
    expect(result.model).toBe("opus")
    expect(result.usage).toBeUndefined()
    expect(result.costUsd).toBeUndefined()
  })

  it("marks an aborted run as cancelled rather than failed", async () => {
    // The runtime never returns; the caller aborts. `withTimeout` rejects with
    // an AbortError, which the runner must translate into `cancelled` — a Ctrl-C
    // is not a crash.
    handler = () => new Promise<AgentOutput>(() => {})
    const controller = new AbortController()
    const promise = makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }), controller.signal)
    controller.abort()
    const result = await promise

    expect(result.status).toBe("cancelled")
    expect(events.some((e) => e.type === "agent:failed")).toBe(true)
  })

  it("surfaces a runtime warning as an orchestration:warning, prefixed with the agent", async () => {
    handler = async (task) => {
      task.onWarning?.("model not offered")
      return { output: "ok", exitCode: 0 }
    }

    await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    const warning = events.find((e) => e.type === "orchestration:warning")
    expect(warning?.payload.message).toContain("[a]")
    expect(warning?.payload.message).toContain("model not offered")
  })

  it("resolves a relative agent workDir under the global work dir", async () => {
    let seen: AgentTask | undefined
    handler = async (task) => {
      seen = task
      return { output: "ok", exitCode: 0 }
    }

    await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME, workDir: "sub/dir" }))

    const expected = path.join(workDir, "sub", "dir")
    expect(fs.existsSync(expected)).toBe(true)
    expect(seen?.workDir).toBe(expected)
  })

  it("resolves to a failed result when the agent names an unknown runtime", async () => {
    // `run` promises never to reject — `runStage` batches agents with
    // Promise.all, so a rejection here would also discard the results of every
    // sibling that did finish.
    const result = await makeRunner().run(makeAgent({ id: "a", runtime: "no-such-runtime" }))

    expect(result.status).toBe("failed")
    expect(result.error).toContain('Runtime not found: "no-such-runtime"')
    expect(events.some((e) => e.type === "agent:failed")).toBe(true)
  })

  it("continues the agent's known session when resume names one", async () => {
    let seen: AgentTask | undefined
    handler = async (task) => {
      seen = task
      return { output: "ok", exitCode: 0 }
    }

    await makeRunner({ resume: { agents: ["a"], sessions: { a: "sess-9" } } }).run(
      makeAgent({ id: "a", runtime: RUNTIME })
    )

    expect(seen?.sessionId).toBe("sess-9")
  })

  it("passes no session id when resume names none", async () => {
    let seen: AgentTask | undefined
    handler = async (task) => {
      seen = task
      return { output: "ok", exitCode: 0 }
    }

    await makeRunner({ resume: { agents: ["a"] } }).run(makeAgent({ id: "a", runtime: RUNTIME }))

    // Absent, not `""`: the ACP runtime tests `if (task.sessionId)`, so an empty
    // string would read as "load this session" for a session that does not
    // exist — the wrong semantics even though the truthiness happens to match.
    expect(seen?.sessionId).toBeUndefined()
  })

  it("carries the runtime's session id into the result on success", async () => {
    handler = async () => ({ output: "ok", exitCode: 0, sessionId: "sess-1" })
    const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    expect(result.sessionId).toBe("sess-1")
  })

  it("omits sessionId entirely when the runtime reported none", async () => {
    handler = async () => ({ output: "ok", exitCode: 0 })
    const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    expect("sessionId" in result).toBe(false)
  })

  it("records no session id on the failure path", async () => {
    // The failure path has no `AgentOutput`, so there is no session to record —
    // a dead turn is re-run cold rather than continued.
    handler = async () => {
      throw new Error("kaboom")
    }
    const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    expect(result.status).toBe("failed")
    expect("sessionId" in result).toBe(false)
  })
})
