import { describe, expect, it, vi } from "vitest"
import { fakeRuntime } from "../testing/helpers"
import type { AgentTask, RuntimeSession, RuntimeSessionOptions } from "../types/runtime"
import { abortError } from "../utils/abort"
import { AgentSessionManager } from "./AgentSessionManager"

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  agentId: "a",
  systemPrompt: "system",
  prompt: "first",
  tools: ["Read"],
  workDir: "/tmp",
  timeout: 1000,
  ...overrides,
})

function session() {
  let state: RuntimeSession["state"] = "idle"
  return {
    sessionId: "session-1",
    get state() {
      return state
    },
    capabilities: { continuation: true, supplement: false },
    prompt: vi.fn(async (text: string) => ({ output: text, exitCode: 0, sessionId: "session-1" })),
    cancelTurn: vi.fn(async () => {}),
    close: vi.fn(async () => {
      state = "closed"
    }),
  }
}

function setup() {
  const live = session()
  const runtime = {
    ...fakeRuntime("sessions", async () => ({ output: "cold", exitCode: 0 })),
    openSession: vi.fn(async (_options: RuntimeSessionOptions): Promise<RuntimeSession> => live),
  }
  return { live, runtime, manager: new AgentSessionManager() }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("AgentSessionManager", () => {
  it("forwards approval policy per turn without retaining callbacks in session configuration", async () => {
    const { manager, runtime, live } = setup()
    const first = vi.fn(async () => "allow-once")
    const second = vi.fn(async () => undefined)
    await manager.execute(runtime, task({ permissionMode: "ask", onPermission: first }))
    expect(runtime.openSession.mock.calls[0][0]).not.toHaveProperty("onPermission")
    expect(live.prompt).toHaveBeenLastCalledWith(
      "first",
      expect.objectContaining({ permissionMode: "ask", onPermission: first })
    )
    await manager.execute(
      runtime,
      task({ prompt: "second", permissionMode: "deny", onPermission: second })
    )
    expect(runtime.openSession).toHaveBeenCalledTimes(1)
    expect(live.prompt).toHaveBeenLastCalledWith(
      "second",
      expect.objectContaining({ permissionMode: "deny", onPermission: second })
    )
    await manager.close()
  })

  it("forwards questions per turn and reopens only when handler availability changes", async () => {
    const { manager, runtime, live } = setup()
    const first = vi.fn(async () => ({ action: "decline" as const }))
    const second = vi.fn(async () => ({ action: "cancel" as const }))
    await manager.execute(runtime, task({ onQuestion: first }))
    expect(runtime.openSession.mock.calls[0][0]).not.toHaveProperty("onQuestion")
    expect(live.prompt).toHaveBeenLastCalledWith(
      "first",
      expect.objectContaining({ onQuestion: first })
    )
    await manager.execute(runtime, task({ onQuestion: second }))
    expect(live.prompt).toHaveBeenLastCalledWith(
      "first",
      expect.objectContaining({ onQuestion: second })
    )
    expect(runtime.openSession).toHaveBeenCalledTimes(1)
    expect(runtime.openSession.mock.calls[0][0].questionForms).toBe(true)
    const next = session()
    runtime.openSession.mockResolvedValueOnce(next)
    await manager.execute(runtime, task())
    expect(next.prompt).toHaveBeenLastCalledWith(
      "first",
      expect.objectContaining({ onQuestion: undefined })
    )
    expect(runtime.openSession).toHaveBeenCalledTimes(2)
    expect(runtime.openSession.mock.calls[1][0].questionForms).toBe(false)
    await manager.close()
  })

  it("keeps a single live session across fresh turn prompts and callbacks", async () => {
    const { manager, runtime, live } = setup()
    const first = new AbortController()
    await manager.execute(runtime, task({ signal: first.signal }))
    const openingSignal = runtime.openSession.mock.calls[0][0].signal
    first.abort()
    expect(openingSignal?.aborted).toBe(false)
    const second = new AbortController()
    const onEvent = vi.fn()
    const result = await manager.execute(
      runtime,
      task({ prompt: "second", timeout: 2000, signal: second.signal, onEvent })
    )
    expect(runtime.openSession).toHaveBeenCalledTimes(1)
    expect(live.prompt).toHaveBeenLastCalledWith("second", {
      timeout: 2000,
      signal: second.signal,
      onEvent,
      permissionMode: undefined,
      onPermission: undefined,
      onQuestion: undefined,
    })
    expect(result.sessionId).toBe("session-1")
    await manager.close()
    expect(live.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    { command: "other" },
    { args: ["--other"] },
    { model: "other" },
    { workDir: "/other" },
    { systemPrompt: "other" },
    { tools: ["Write"] },
    { sessionId: "other" },
    { resume: "fork" as const },
  ])("reopens after immutable configuration changes: %j", async (change) => {
    const { manager, runtime, live } = setup()
    await manager.execute(runtime, task())
    const next = session()
    runtime.openSession.mockResolvedValueOnce(next)
    await manager.execute(runtime, task(change))
    expect(live.close).toHaveBeenCalledTimes(1)
    expect(runtime.openSession).toHaveBeenCalledTimes(2)
    await manager.close()
  })

  it("reopens when the runtime instance changes or the cached session closes", async () => {
    const { manager, runtime, live } = setup()
    await manager.execute(runtime, task())
    const other = setup()
    await manager.execute(other.runtime, task())
    expect(live.close).toHaveBeenCalledTimes(1)
    await other.live.close()
    other.runtime.openSession.mockResolvedValueOnce(session())
    await manager.execute(other.runtime, task())
    expect(other.runtime.openSession).toHaveBeenCalledTimes(2)
    await manager.close()
  })

  it("falls back directly to execute-only runtimes", async () => {
    const execute = vi.fn(async () => ({ output: "cold", exitCode: 0 }))
    const runtime = fakeRuntime("cold", execute)
    const manager = new AgentSessionManager()
    const input = task()
    expect(await manager.execute(runtime, input)).toEqual({ output: "cold", exitCode: 0 })
    expect(execute).toHaveBeenCalledWith(input)
    await manager.close()
  })

  it("routes warnings to the current caller rather than a previous turn", async () => {
    const { manager, runtime, live } = setup()
    const first = vi.fn()
    const second = vi.fn()
    let warn!: (message: string) => void
    runtime.openSession.mockImplementation(async (options) => {
      warn = options.onWarning!
      warn("startup")
      return live
    })
    live.prompt.mockImplementation(async (text) => {
      warn(text)
      return { output: text, exitCode: 0, sessionId: live.sessionId }
    })
    await manager.execute(runtime, task({ onWarning: first }))
    warn("idle")
    await manager.execute(runtime, task({ prompt: "second", onWarning: second }))
    expect(first.mock.calls).toEqual([["startup"], ["first"]])
    expect(second.mock.calls).toEqual([["second"]])
    await manager.close()
  })

  it("forwards startup abort and waits for opening cleanup", async () => {
    const { manager, runtime } = setup()
    const opening = deferred<RuntimeSession>()
    const started = deferred<void>()
    runtime.openSession.mockImplementation(async (options) => {
      options.signal!.addEventListener("abort", () => started.resolve())
      return opening.promise
    })
    const controller = new AbortController()
    const execute = manager.execute(runtime, task({ signal: controller.signal }))
    const rejected = expect(execute).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(runtime.openSession).toHaveBeenCalled())
    controller.abort()
    await started.promise
    let done = false
    execute.catch(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    opening.reject(abortError())
    await rejected
    await manager.close()
  })

  it("rejects overlapping turns while opening and prompting", async () => {
    const { manager, runtime, live } = setup()
    const opening = deferred<RuntimeSession>()
    runtime.openSession.mockReturnValueOnce(opening.promise)
    const first = manager.execute(runtime, task())
    await expect(manager.execute(runtime, task())).rejects.toThrow(/busy/i)
    const prompt = deferred<{ output: string; exitCode: number; sessionId: string }>()
    live.prompt.mockReturnValueOnce(prompt.promise)
    opening.resolve(live)
    await vi.waitFor(() => expect(live.prompt).toHaveBeenCalled())
    await expect(manager.execute(runtime, task())).rejects.toThrow(/busy/i)
    prompt.resolve({ output: "ok", exitCode: 0, sessionId: live.sessionId })
    await first
    await manager.close()
  })

  it("reset aborts startup, waits for a late session and closes it before reopening", async () => {
    const { manager, runtime, live } = setup()
    const opening = deferred<RuntimeSession>()
    runtime.openSession.mockReturnValueOnce(opening.promise)
    const execute = manager.execute(runtime, task())
    const rejected = expect(execute).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(runtime.openSession).toHaveBeenCalled())
    const reset = manager.reset()
    expect(manager.reset()).toBe(reset)
    expect(runtime.openSession.mock.calls[0][0].signal?.aborted).toBe(true)
    await expect(manager.execute(runtime, task())).rejects.toThrow(/reset|closing/i)
    opening.resolve(live)
    await reset
    await rejected
    expect(live.close).toHaveBeenCalledTimes(1)
    runtime.openSession.mockResolvedValueOnce(session())
    await manager.execute(runtime, task())
    await manager.close()
  })

  it("close is terminal, idempotent and waits for every session cleanup barrier", async () => {
    const { manager, runtime, live } = setup()
    await manager.execute(runtime, task())
    const other = session()
    runtime.openSession.mockResolvedValueOnce(other)
    await manager.execute(runtime, task({ agentId: "b" }))
    const barrier = deferred<void>()
    live.close.mockImplementationOnce(() => barrier.promise)
    const close = manager.close()
    expect(manager.close()).toBe(close)
    let done = false
    close.then(() => {
      done = true
    })
    await vi.waitFor(() => expect(other.close).toHaveBeenCalledTimes(1))
    expect(done).toBe(false)
    await expect(manager.execute(runtime, task())).rejects.toThrow(/closed/i)
    barrier.resolve()
    await close
  })

  it("retains idle sessions after cooperative turn cancellation", async () => {
    const { manager, runtime, live } = setup()
    const controller = new AbortController()
    const started = deferred<void>()
    live.prompt.mockImplementationOnce(async () => {
      started.resolve()
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve())
      )
      throw abortError()
    })
    const execution = manager.execute(runtime, task({ signal: controller.signal }))
    const rejected = expect(execution).rejects.toMatchObject({ name: "AbortError" })
    await started.promise
    controller.abort()
    await rejected
    await manager.execute(runtime, task({ prompt: "continued" }))
    expect(runtime.openSession).toHaveBeenCalledTimes(1)
    expect(runtime.openSession.mock.calls[0][0].signal?.aborted).toBe(false)
    await manager.close()
  })

  it("reset waits for active prompt cleanup and close during reset stays terminal", async () => {
    const { manager, runtime, live } = setup()
    const started = deferred<void>()
    const turn = deferred<{ output: string; exitCode: number; sessionId: string }>()
    live.prompt.mockImplementationOnce(() => {
      started.resolve()
      return turn.promise
    })
    const execute = manager.execute(runtime, task())
    await started.promise
    live.close.mockImplementationOnce(async () => {
      await turn.promise
    })
    const reset = manager.reset()
    expect(manager.close()).toBe(reset)
    let finished = false
    reset.then(() => {
      finished = true
    })
    await vi.waitFor(() => expect(live.close).toHaveBeenCalledTimes(1))
    expect(finished).toBe(false)
    turn.resolve({ output: "cancelled", exitCode: 0, sessionId: live.sessionId })
    await execute
    await reset
    await expect(manager.execute(runtime, task())).rejects.toThrow(/closed/i)
  })

  it("rejects pre-aborted tasks without opening and recovers after startup failures", async () => {
    const { manager, runtime } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(
      manager.execute(runtime, task({ signal: controller.signal }))
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(runtime.openSession).not.toHaveBeenCalled()
    runtime.openSession.mockRejectedValueOnce(new Error("startup failed"))
    await expect(manager.execute(runtime, task())).rejects.toThrow("startup failed")
    await manager.execute(runtime, task())
    expect(runtime.openSession).toHaveBeenCalledTimes(2)
    await manager.close()
  })

  it("propagates cleanup failures from cancelled startup", async () => {
    const { manager, runtime } = setup()
    const opening = deferred<RuntimeSession>()
    runtime.openSession.mockReturnValueOnce(opening.promise)
    const execution = manager.execute(runtime, task())
    const executionRejected = expect(execution).rejects.toThrow("startup cleanup failed")
    const close = manager.close()
    const closeRejected = expect(close).rejects.toThrow("startup cleanup failed")
    opening.reject(new Error("startup cleanup failed"))
    await executionRejected
    await closeRejected
  })

  it("retains failed cleanup barriers even when the runtime already marks the session closed", async () => {
    const { manager, runtime, live } = setup()
    live.prompt.mockImplementationOnce(async () => {
      await live.close()
      live.close.mockRejectedValueOnce(new Error("cleanup acknowledgement failed"))
      throw new Error("turn failed")
    })
    await expect(manager.execute(runtime, task())).rejects.toThrow("cleanup acknowledgement failed")
    await expect(manager.execute(runtime, task())).rejects.toThrow("cleanup acknowledgement failed")
    await expect(manager.reset()).rejects.toThrow("cleanup acknowledgement failed")
    await expect(manager.close()).rejects.toThrow("cleanup acknowledgement failed")
    expect(runtime.openSession).toHaveBeenCalledTimes(1)
  })

  it("preserves the prompt error after a closed session acknowledges cleanup", async () => {
    const { manager, runtime, live } = setup()
    live.prompt.mockImplementationOnce(async () => {
      await live.close()
      throw new Error("original prompt error")
    })
    await expect(manager.execute(runtime, task())).rejects.toThrow("original prompt error")
    await manager.close()
  })

  it("propagates replacement cleanup failures instead of opening another session", async () => {
    const { manager, runtime, live } = setup()
    await manager.execute(runtime, task())
    live.close.mockRejectedValueOnce(new Error("replacement cleanup failed"))
    await expect(manager.execute(runtime, task({ model: "changed" }))).rejects.toThrow(
      "replacement cleanup failed"
    )
    expect(runtime.openSession).toHaveBeenCalledTimes(1)
    await expect(manager.close()).rejects.toThrow("replacement cleanup failed")
  })

  it("propagates cleanup failures while still waiting for every sibling", async () => {
    const { manager, runtime, live } = setup()
    await manager.execute(runtime, task())
    const other = session()
    runtime.openSession.mockResolvedValueOnce(other)
    await manager.execute(runtime, task({ agentId: "b" }))
    live.close.mockRejectedValueOnce(new Error("cleanup failed"))
    const barrier = deferred<void>()
    other.close.mockImplementationOnce(() => barrier.promise)
    const closing = manager.close()
    const rejected = expect(closing).rejects.toThrow("cleanup failed")
    let done = false
    closing.catch(() => {
      done = true
    })
    await vi.waitFor(() => expect(other.close).toHaveBeenCalled())
    expect(done).toBe(false)
    barrier.resolve()
    await rejected
  })
})
