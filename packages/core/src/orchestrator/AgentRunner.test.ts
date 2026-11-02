import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { EventBus } from "../event/EventBus"
import { KILL_ESCALATION_MS, runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import type { MultiClawConfig } from "../types/config"
import type { MultiClawEvent } from "../types/event"
import type { AgentOutput, AgentTask, RuntimeSessionOptions } from "../types/runtime"
import { PermanentError } from "../utils/errors"
import { AgentRunner } from "./AgentRunner"
import { AgentSessionManager } from "./AgentSessionManager"
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
  it("passes caller-owned human permission policy to the runtime", async () => {
    const onRequest = vi.fn(async () => "allow-once")
    handler = async (task) => {
      expect(task.permissionMode).toBe("ask")
      expect(task.onPermission).toBe(onRequest)
      return { output: "done", exitCode: 0 }
    }
    const result = await makeRunner({ permissions: { mode: "ask", onRequest } }).run(
      makeAgent({ id: "a", runtime: RUNTIME })
    )
    expect(result.status).toBe("success")
  })

  it("passes caller-owned structured question handlers to the runtime", async () => {
    const onRequest = vi.fn(async () => ({ action: "decline" as const }))
    handler = async (task) => {
      expect(task.onQuestion).toBe(onRequest)
      return { output: "done", exitCode: 0 }
    }
    const result = await makeRunner({ questions: { onRequest } }).run(
      makeAgent({ id: "a", runtime: RUNTIME })
    )
    expect(result.status).toBe("success")
  })

  it("reuses caller-owned sessions across runners without retaining the old event bus", async () => {
    const manager = new AgentSessionManager()
    const name = "test-runner-live-session"
    let options!: RuntimeSessionOptions
    const prompt = vi.fn(async (text: string) => {
      options.onWarning?.(text)
      return { output: text, exitCode: 0, sessionId: "live-1" }
    })
    const close = vi.fn(async () => {})
    const openSession = vi.fn(async (input: RuntimeSessionOptions) => {
      options = input
      return {
        sessionId: "live-1",
        state: "idle" as const,
        capabilities: { continuation: true, supplement: false },
        prompt,
        close,
        cancelTurn: async () => {},
      }
    })
    const execute = vi.fn(async () => ({ output: "cold", exitCode: 0 }))
    runtimeRegistry.register({ ...fakeRuntime(name, execute), openSession })
    const config = { name: "test", workDir, agents: [] }
    const first = new AgentRunner(bus, context, workDir, config, manager)
    expect(
      (await first.run(makeAgent({ id: "a", runtime: name, taskPrompt: "first" }))).sessionId
    ).toBe("live-1")
    const nextBus = new EventBus()
    const nextEvents: MultiClawEvent[] = []
    nextBus.subscribe((event) => nextEvents.push(event))
    const second = new AgentRunner(nextBus, context, workDir, config, manager)
    expect(
      (await second.run(makeAgent({ id: "a", runtime: name, taskPrompt: "second" }))).output
    ).toBe("second")
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    expect(
      events
        .filter((event) => event.type === "orchestration:warning")
        .map((event) => event.payload.message)
    ).toEqual(["[a] first"])
    expect(
      nextEvents
        .filter((event) => event.type === "orchestration:warning")
        .map((event) => event.payload.message)
    ).toEqual(["[a] second"])
    await manager.close()
    expect(close).toHaveBeenCalledTimes(1)
  })

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

  it.each(["max_turns", "error", "timeout", "cancelled"])(
    "does not report an incomplete runtime turn (%s) as success",
    async (stopReason) => {
      handler = async () => ({ output: "partial evidence", exitCode: 0, stopReason })
      const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))
      expect(result.status).toBe(stopReason === "cancelled" ? "cancelled" : "failed")
      expect(result.output).toBe("partial evidence")
      expect(result.error).toContain(stopReason)
      expect(events.some((e) => e.type === "agent:complete")).toBe(false)
    }
  )

  it("does not report a nonzero runtime exit as success", async () => {
    handler = async () => ({ output: "partial evidence", exitCode: 7 })
    const result = await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))
    expect(result.status).toBe("failed")
    expect(result.error).toContain("7")
    expect(result.output).toBe("partial evidence")
  })

  it("waits for a session runtime's cleanup acknowledgement after cancellation", async () => {
    const controller = new AbortController()
    let release!: () => void
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const name = "test-session-cleanup-barrier"
    runtimeRegistry.register({
      ...fakeRuntime(name, async (task) => {
        started()
        await new Promise<void>((resolve) => {
          release = resolve
          expect(task.signal).toBeDefined()
        })
        throw Object.assign(new Error("cancelled after cleanup"), { name: "AbortError" })
      }),
      openSession: async () => {
        throw new Error("execute is the compatibility entry")
      },
    })
    let finished = false
    const promise = makeRunner()
      .run(makeAgent({ id: "a", runtime: name }), controller.signal)
      .then((result) => {
        finished = true
        return result
      })
    await running
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(events.some((event) => event.type === "agent:failed")).toBe(false)
    release()
    expect((await promise).status).toBe("cancelled")
  })

  it.each(["abort", "cleanup failure"])(
    "waits for session cleanup after the outer timeout before reporting %s",
    async (outcome) => {
      vi.useFakeTimers()
      let release!: () => void
      let started!: () => void
      let runtimeSignal: AbortSignal | undefined
      const running = new Promise<void>((resolve) => {
        started = resolve
      })
      const name = `test-session-timeout-cleanup-${outcome}`
      runtimeRegistry.register({
        ...fakeRuntime(name, async (task) => {
          runtimeSignal = task.signal
          started()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          if (outcome === "cleanup failure") throw new Error("process cleanup failed")
          throw Object.assign(new Error("aborted after cleanup"), { name: "AbortError" })
        }),
        openSession: async () => {
          throw new Error("execute is the compatibility entry")
        },
      })
      let finished = false
      const promise = makeRunner()
        .run(makeAgent({ id: "a", runtime: name, timeout: 100, retries: 1 }))
        .then((result) => {
          finished = true
          return result
        })
      await running
      const outerBudget = 2 * (100 + KILL_ESCALATION_MS) + 2000
      await vi.advanceTimersByTimeAsync(outerBudget)
      expect(runtimeSignal?.aborted).toBe(true)
      expect(finished).toBe(false)
      expect(
        events.some((event) => event.type === "agent:failed" || event.type === "agent:complete")
      ).toBe(false)
      release()
      const result = await promise
      expect(result.status).toBe("failed")
      expect(result.error).toBe(
        outcome === "cleanup failure"
          ? "process cleanup failed"
          : `[a] timed out (${outerBudget / 1000}s)`
      )
      expect(result.attempts).toBe(1)
      expect(events.filter((event) => event.type === "agent:failed")).toHaveLength(1)
      expect(events.some((event) => event.type === "agent:retrying")).toBe(false)
    }
  )

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
    // The outer budget is `timeout + KILL_ESCALATION_MS`: even with no retries, a
    // single attempt may still be reaping a child that ignored SIGTERM during the
    // SIGKILL grace.
    await vi.advanceTimersByTimeAsync(100 + KILL_ESCALATION_MS)
    const result = await promise

    expect(result.status).toBe("failed")
    expect(result.error).toContain("timed out")
  })

  it("gives each attempt the full timeout when retries are configured", async () => {
    // Regression: the outer budget used to be the same `timeout` as the inner
    // per-attempt budget, so the first attempt consumed the whole allowance and a
    // retry never got to start. The outer budget must cover every attempt plus
    // the backoff between them.
    vi.useFakeTimers()
    let calls = 0
    handler = async (task) => {
      calls += 1
      if (calls === 1) {
        // Model the runtime enforcing its own per-attempt budget: reject once
        // `task.timeout` elapses, exactly as the ACP runtime's inner timer does.
        return await new Promise<AgentOutput>((_, reject) => {
          setTimeout(() => reject(new Error("acp timed out")), task.timeout)
        })
      }
      return { output: "second attempt", exitCode: 0 }
    }

    const promise = makeRunner().run(
      makeAgent({ id: "a", runtime: RUNTIME, retries: 1, timeout: 100 })
    )
    // Attempt 1 times out at 100ms, the 2000ms backoff runs, attempt 2 succeeds.
    await vi.advanceTimersByTimeAsync(3000)
    const result = await promise

    expect(result.status).toBe("success")
    expect(result.output).toBe("second attempt")
    expect(result.attempts).toBe(2)
  })

  it("does not let the outer timer beat the last attempt when attempts overrun their timeout", async () => {
    // The outer budget must cover the *worst case* per attempt, not the nominal
    // timeout. An attempt that ignores SIGTERM is not reaped until the SIGKILL
    // grace elapses, so it can consume `timeout + KILL_ESCALATION_MS`. Budgeting
    // only `timeout` per attempt makes the outer timer fire while the final
    // attempt is still running — killing the very attempt that would have saved
    // the run.
    vi.useFakeTimers()
    let calls = 0
    handler = async (task) => {
      calls += 1
      if (calls <= 2) {
        // Worst case: the child ignores SIGTERM, so the reject only lands after
        // the SIGKILL grace has elapsed.
        return await new Promise<AgentOutput>((_, reject) => {
          setTimeout(() => reject(new Error("acp timed out")), task.timeout + KILL_ESCALATION_MS)
        })
      }
      // The last attempt succeeds inside its own timeout.
      return await new Promise<AgentOutput>((resolve) => {
        setTimeout(() => resolve({ output: "third attempt", exitCode: 0 }), task.timeout)
      })
    }

    const promise = makeRunner().run(
      makeAgent({ id: "a", runtime: RUNTIME, retries: 2, timeout: 100 })
    )
    // Attempts 1+2 each burn 100+3000ms; backoffs are 2000+4000ms; attempt 3
    // finishes at 100ms. Advance well past all of it.
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await promise

    expect(result.status).toBe("success")
    expect(result.output).toBe("third attempt")
    expect(result.attempts).toBe(3)
  })

  it("does not retry a permanent runtime failure", async () => {
    // A missing binary or an unsupported capability fails identically on every
    // attempt, so the runner must not spend the backoff budget on it.
    vi.useFakeTimers()
    let calls = 0
    handler = async () => {
      calls += 1
      throw new PermanentError("Failed to start opencode: ENOENT")
    }

    const promise = makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME, retries: 3 }))
    // Under the fix this settles with no retries; under a revert it would need
    // 2s+4s+6s of backoff. A wide window makes the difference a call count
    // rather than a hang.
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await promise

    expect(calls).toBe(1)
    expect(result.status).toBe("failed")
    expect(result.error).toContain("ENOENT")
    expect(result.attempts).toBe(1)
    expect(events.some((e) => e.type === "agent:retrying")).toBe(false)
  })

  it("still retries a transient runtime failure", async () => {
    // The complement of the previous test: an ordinary error is retried, so the
    // permanent classification did not turn every failure into a one-shot.
    vi.useFakeTimers()
    let calls = 0
    handler = async () => {
      calls += 1
      if (calls === 1) throw new Error("transient")
      return { output: "ok", exitCode: 0 }
    }

    const promise = makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME, retries: 1 }))
    await vi.advanceTimersByTimeAsync(2000)
    const result = await promise

    expect(calls).toBe(2)
    expect(result.status).toBe("success")
    expect(result.attempts).toBe(2)
  })

  it.each(["context", "config"])(
    "prefixes the complete requirement for custom workers from %s",
    async (source) => {
      let seen: AgentTask | undefined
      handler = async (task) => {
        seen = task
        return { output: "ok", exitCode: 0 }
      }
      if (source === "context") context.set("requirement", "Build the whole application")
      await makeRunner({
        context: {
          requirement: source === "config" ? "Build the whole application" : "stale requirement",
        },
      }).run(
        makeAgent({
          id: "a",
          runtime: RUNTIME,
          taskPrompt: "Implement {{agentScope}}",
          agentScope: "checkout",
        })
      )
      expect(seen?.prompt).toBe(
        "## Current task\nBuild the whole application\n\nImplement checkout"
      )
    }
  )

  it("preserves leader prompts identified by configured id", async () => {
    let seen: AgentTask | undefined
    handler = async (task) => {
      seen = task
      return { output: "ok", exitCode: 0 }
    }
    context.set("requirement", "Build the application")
    const agent = makeAgent({
      id: "a",
      runtime: RUNTIME,
      taskPrompt: "Exact leader JSON prompt",
    })
    await makeRunner({ leader: agent }).run(agent)
    expect(seen?.prompt).toBe("Exact leader JSON prompt")
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

  it("holds a tool row until its arguments arrive, then prints exactly one", async () => {
    handler = async (task) => {
      // ACP announces a call before its input has streamed, so the first
      // sighting carries nothing and the arguments follow on a refinement.
      task.onEvent?.({
        runId: "r1",
        agentId: "a",
        seq: 0,
        type: "tool_call",
        id: "t",
        name: "Read",
        input: {},
      })
      task.onEvent?.({
        runId: "r1",
        agentId: "a",
        seq: 1,
        type: "tool_call",
        id: "t",
        name: "Read",
        input: { file_path: "src/App.tsx" },
      })
      return { output: "done", exitCode: 0 }
    }

    await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    const rows = events.filter(
      (e): e is Extract<MultiClawEvent, { type: "agent:output" }> =>
        e.type === "agent:output" && e.payload.kind === "tool"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.chunk).toContain("Read")
    expect(rows[0].payload.chunk).toContain("src/App.tsx")
    // A row the user cannot act on — `› Read {}` — must never reach the pane.
    expect(rows[0].payload.chunk).not.toContain("{}")
  })

  it("still prints a row for a tool that never reports arguments", async () => {
    handler = async (task) => {
      task.onEvent?.({
        runId: "r1",
        agentId: "a",
        seq: 0,
        type: "tool_call",
        id: "t",
        name: "Bash",
        input: {},
      })
      task.onEvent?.({
        runId: "r1",
        agentId: "a",
        seq: 1,
        type: "tool_result",
        id: "t",
        output: "ok",
        isError: false,
      })
      return { output: "done", exitCode: 0 }
    }

    await makeRunner().run(makeAgent({ id: "a", runtime: RUNTIME }))

    const rows = events.filter(
      (e): e is Extract<MultiClawEvent, { type: "agent:output" }> =>
        e.type === "agent:output" && e.payload.kind === "tool"
    )
    // The call happened, so it gets a row; it simply has no arguments to show.
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.chunk).toContain("Bash")
    expect(rows[0].payload.chunk).not.toContain("{}")
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
