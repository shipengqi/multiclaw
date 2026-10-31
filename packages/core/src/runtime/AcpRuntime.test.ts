import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough, Readable, Writable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RuntimeEvent } from "../types/runtime"

const spawnMock = vi.fn()
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

const acp = await import("@agentclientprotocol/sdk")
const { AcpRuntime, validateRuntimeQuestionContent } = await import("./AcpRuntime")

/**
 * A stand-in for the spawned agent process.
 *
 * `stdin`/`stdout` are real duplex `PassThrough` streams, so the adapter's
 * `ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout))` is wired to a
 * real in-process ACP agent (see {@link attachAgent}) — no binary, no child
 * process, and no hand-written JSON-RPC frames.
 */
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new EventEmitter()
  autoClose = true
  kill = vi.fn(() => {
    if (this.autoClose) queueMicrotask(() => this.emit("close", 0))
    return true
  })
}

interface AgentHandlers {
  initialize?: (params: unknown) => unknown
  newSession?: (params: unknown) => unknown
  loadSession?: (params: unknown) => unknown
  setConfigOption?: (params: unknown) => unknown
  prompt?: (ctx: AgentPromptContext) => unknown
  cancel?: (params: unknown) => void
  /** `_session/steering`: the bridge's mid-turn input extension. */
  steering?: (params: unknown) => unknown
}

interface AgentPromptContext {
  params: { sessionId: string; prompt?: Array<{ type: string; text: string }> }
  client: {
    notify: (method: string, params: unknown) => Promise<void>
    request: (
      method: string,
      params: unknown,
      options?: { cancellationSignal?: AbortSignal }
    ) => Promise<unknown>
  }
}

/**
 * Wire an in-process ACP agent onto the fake child's streams.
 *
 * The SDK types its handlers against the generated schema; this harness is
 * deliberately loose (the payloads are hand-written), so the handler functions
 * are cast at the boundary.
 */
function attachAgent(child: FakeChild, handlers: AgentHandlers): void {
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdout),
    Readable.toWeb(child.stdin) as unknown as ReadableStream<Uint8Array>
  )
  const app = acp.agent({ name: "fake-agent" })
  app.onRequest(
    "initialize",
    ((ctx: { params: unknown }) =>
      handlers.initialize?.(ctx.params) ?? {
        protocolVersion: acp.PROTOCOL_VERSION,
        // A fully-capable fake by default, so resume works out of the box;
        // the loadSession-gate test overrides this to advertise `false`.
        agentCapabilities: { loadSession: true },
      }) as never
  )
  app.onRequest(
    "session/new",
    ((ctx: { params: unknown }) =>
      handlers.newSession?.(ctx.params) ?? { sessionId: "sess-1" }) as never
  )
  app.onRequest("session/load", (async (ctx: AgentPromptContext) => {
    await notifyUpdate(ctx, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "historical replay" },
    })
    return handlers.loadSession?.(ctx.params) ?? {}
  }) as never)
  app.onRequest(
    "session/set_config_option",
    ((ctx: { params: unknown }) => handlers.setConfigOption?.(ctx.params) ?? {}) as never
  )
  app.onRequest(
    "session/prompt",
    ((ctx: unknown) =>
      handlers.prompt?.(ctx as AgentPromptContext) ?? { stopReason: "end_turn" }) as never
  )
  app.onNotification("session/cancel", ((ctx: { params: unknown }) => {
    handlers.cancel?.(ctx.params)
  }) as never)
  // A custom method needs an explicit params parser: the SDK only knows the
  // methods the spec generates a schema for.
  app.onRequest(
    "_session/steering" as never,
    ((value: unknown) => value) as never,
    ((ctx: { params: unknown }) =>
      handlers.steering?.(ctx.params) ?? { outcome: "injected" }) as never
  )
  app.connect(stream)
}

/** Send one `session/update` notification from the agent side. */
function notifyUpdate(ctx: AgentPromptContext, update: unknown): Promise<void> {
  return ctx.client.notify(acp.methods.client.session.update, {
    sessionId: ctx.params.sessionId,
    update,
  })
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "a1",
    prompt: "do it",
    tools: ["Read", "Bash"],
    workDir: "/tmp/work",
    ...overrides,
  } as never
}

function collect() {
  const events: RuntimeEvent[] = []
  const onEvent = (e: RuntimeEvent) => {
    events.push(e)
  }
  return { events, onEvent }
}

/** Run the adapter with the fake child already installed as `spawn`'s result. */
function runWith(child: FakeChild, task: Record<string, unknown> = {}) {
  spawnMock.mockReturnValue(child)
  return new AcpRuntime().execute(makeTask(task))
}

/**
 * Wait until `execute()` has spawned the child.
 *
 * `execute()` awaits a dynamic `import()` of the SDK before spawning, so the
 * child does not exist synchronously after `runWith(...)` returns. Once this
 * resolves, `close`/`error` listeners are attached and safe to emit.
 */
async function untilSpawned(): Promise<void> {
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled(), { timeout: 10_000 })
}

afterEach(() => {
  spawnMock.mockReset()
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function openWith(child: FakeChild, options: Record<string, unknown> = {}) {
  spawnMock.mockReturnValue(child)
  return new AcpRuntime().openSession(makeTask({ questionForms: true, ...options }))
}

describe("AcpRuntime structured questions", () => {
  const requestedSchema = {
    type: "object",
    properties: {
      question_0: { type: "string", enum: ["Postgres", "SQLite"] },
      question_1: { type: "array", items: { type: "string", enum: ["api", "ui"] } },
    },
    required: ["question_0", "question_1"],
  }
  const question = {
    mode: "form",
    sessionId: "sess-1",
    toolCallId: "ask-1",
    message: "Choose a database",
    requestedSchema,
  }

  it("advertises only form support and roundtrips structured answers", async () => {
    const child = new FakeChild()
    let initialized: unknown
    let answer: unknown
    attachAgent(child, {
      initialize: (params) => {
        initialized = params
        return { protocolVersion: acp.PROTOCOL_VERSION }
      },
      prompt: async (ctx) => {
        answer = await ctx.client.request("elicitation/create", question)
        return { stopReason: "end_turn" }
      },
    })
    const onQuestion = vi.fn(async () => ({
      action: "accept",
      content: { question_0: "Postgres", question_1: ["api"] },
    }))
    await runWith(child, { onQuestion })
    expect(initialized).toMatchObject({ clientCapabilities: { elicitation: { form: {} } } })
    expect(
      (initialized as { clientCapabilities: { elicitation: unknown } }).clientCapabilities
        .elicitation
    ).toEqual({ form: {} })
    expect(answer).toEqual({
      action: "accept",
      content: { question_0: "Postgres", question_1: ["api"] },
    })
    expect(onQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        sessionId: "sess-1",
        toolCallId: "ask-1",
        message: question.message,
        requestedSchema,
      }),
      expect.any(AbortSignal)
    )
  })

  it("does not negotiate forms for headless execute callers", async () => {
    const child = new FakeChild()
    let initialized: unknown
    attachAgent(child, {
      initialize: (params) => {
        initialized = params
        return { protocolVersion: acp.PROTOCOL_VERSION }
      },
    })
    await runWith(child)
    expect(initialized).not.toHaveProperty("clientCapabilities.elicitation.form")
  })

  it.each([
    { content: { question_0: "Other", question_1: [] } },
    { content: { question_0: 1, question_1: [] } },
    { content: { question_0: "Postgres" } },
    { content: { question_0: "Postgres", question_1: ["other"] } },
    { content: { question_0: "Postgres", question_1: [], extra: true } },
  ])("cancels invalid accepted content $content", async ({ content }) => {
    const child = new FakeChild()
    let answer: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        answer = await ctx.client.request("elicitation/create", question)
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, { onQuestion: async () => ({ action: "accept", content }) })
    expect(answer).toEqual({ action: "cancel" })
  })

  it.each([
    { request: question, handler: false },
    { request: { ...question, sessionId: "other" }, handler: true },
    { request: { mode: "_custom", sessionId: "sess-1", message: "Custom" }, handler: true },
    {
      request: {
        mode: "url",
        sessionId: "sess-1",
        message: "Open",
        elicitationId: "url-1",
        url: "https://example.com",
      },
      handler: true,
    },
    {
      request: { ...question, requestedSchema: { properties: { custom: { type: "_custom" } } } },
      handler: true,
    },
  ])("cancels headless and unsupported requests %#", async ({ request, handler }) => {
    const child = new FakeChild()
    let answer: unknown
    const onQuestion = vi.fn(async () => ({ action: "decline" }))
    attachAgent(child, {
      prompt: async (ctx) => {
        answer = await ctx.client.request("elicitation/create", request)
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, handler ? { onQuestion } : {})
    expect(answer).toEqual({ action: "cancel" })
    expect(onQuestion).not.toHaveBeenCalled()
  })

  it.each([
    {
      action: "accept",
      content: { count: 2, enabled: true, label: "OK", ratio: 0.5 },
      expected: "accept",
    },
    {
      action: "accept",
      content: { count: 2.5, enabled: true, label: "OK", ratio: 0.5 },
      expected: "cancel",
    },
    {
      action: "accept",
      content: { count: 4, enabled: true, label: "OK", ratio: 0.5 },
      expected: "cancel",
    },
    {
      action: "accept",
      content: { count: 2, enabled: "true", label: "OK", ratio: 0.5 },
      expected: "cancel",
    },
    {
      action: "accept",
      content: { count: 2, enabled: true, label: "NO", ratio: 0.5 },
      expected: "cancel",
    },
    {
      action: "accept",
      content: { count: 2, enabled: true, label: "OK", ratio: 1.5 },
      expected: "cancel",
    },
    { action: "decline", content: undefined, expected: "decline" },
    { action: "cancel", content: undefined, expected: "cancel" },
  ])(
    "validates standard field values and preserves actions %#",
    async ({ action, content, expected }) => {
      const child = new FakeChild()
      let answer: unknown
      attachAgent(child, {
        prompt: async (ctx) => {
          answer = await ctx.client.request("elicitation/create", {
            ...question,
            requestedSchema: {
              properties: {
                count: { type: "integer", minimum: 1, maximum: 3 },
                enabled: { type: "boolean" },
                label: {
                  type: "string",
                  minLength: 2,
                  maxLength: 2,
                  oneOf: [{ const: "OK", title: "Okay" }],
                },
                ratio: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["count", "enabled", "label", "ratio"],
            },
          })
          return { stopReason: "end_turn" }
        },
      })
      await runWith(child, { onQuestion: async () => ({ action, content }) })
      expect(answer).toEqual(expected === "accept" ? { action, content } : { action: expected })
    }
  )

  it.each([
    { selected: ["api", "ui"], expected: "accept" },
    { selected: ["API"], expected: "cancel" },
    { selected: ["api", "api"], expected: "cancel" },
    { selected: [], expected: "cancel" },
  ])("handles Claude titled multiselect schema %#", async ({ selected, expected }) => {
    const child = new FakeChild()
    let answer: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        answer = await ctx.client.request("elicitation/create", {
          ...question,
          requestedSchema: {
            type: "object",
            properties: {
              question_0: {
                type: "array",
                minItems: 1,
                maxItems: 2,
                items: {
                  anyOf: [
                    { const: "api", title: "API" },
                    { const: "ui", title: "UI" },
                  ],
                },
              },
            },
            required: ["question_0"],
          },
        })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, {
      onQuestion: async () => ({ action: "accept", content: { question_0: selected } }),
    })
    expect(answer).toEqual(
      expected === "accept"
        ? { action: "accept", content: { question_0: selected } }
        : { action: "cancel" }
    )
  })

  it("cancels callback errors and validates against an unmodified schema", async () => {
    const child = new FakeChild()
    const answers: unknown[] = []
    attachAgent(child, {
      prompt: async (ctx) => {
        answers.push(await ctx.client.request("elicitation/create", question))
        return { stopReason: "end_turn" }
      },
    })
    const session = await openWith(child)
    await session.prompt("error", {
      onQuestion: async () => {
        throw new Error("failed")
      },
    })
    await session.prompt("mutation", {
      onQuestion: async (request) => {
        request.requestedSchema.properties = {}
        request.requestedSchema.required = []
        return { action: "accept", content: {} }
      },
    })
    expect(answers).toEqual([{ action: "cancel" }, { action: "cancel" }])
    await session.close()
  })

  it("cancels pending callbacks on turn abort and ignores late answers", async () => {
    const child = new FakeChild()
    const started = deferred<AbortSignal>()
    const late = deferred<unknown>()
    let answer: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        answer = await ctx.client.request("elicitation/create", question)
        return { stopReason: "cancelled" }
      },
    })
    const session = await openWith(child)
    const result = session.prompt("ask", {
      onQuestion: (async (_request: unknown, signal: AbortSignal) => {
        started.resolve(signal)
        return late.promise
      }) as never,
    })
    const signal = await started.promise
    await session.cancelTurn()
    expect(signal.aborted).toBe(true)
    expect(answer).toEqual({ action: "cancel" })
    expect((await result).stopReason).toBe("cancelled")
    late.resolve({ action: "accept", content: { question_0: "Postgres", question_1: [] } })
    await session.close()
  })

  it.each(["timeout", "close"])("aborts a hanging question on %s", async (reason) => {
    const child = new FakeChild()
    const started = deferred<AbortSignal>()
    attachAgent(child, {
      prompt: async (ctx) => {
        await ctx.client.request("elicitation/create", question)
        return new Promise(() => {})
      },
    })
    const session = await openWith(child)
    const result = session.prompt("ask", {
      timeout: reason === "timeout" ? 50 : 1000,
      onQuestion: async (_request, signal) => {
        started.resolve(signal)
        return new Promise(() => {})
      },
    })
    const rejected = expect(result).rejects.toThrow(reason === "timeout" ? "timed out" : "aborted")
    const signal = await started.promise
    if (reason === "close") await session.close()
    await rejected
    expect(signal.aborted).toBe(true)
    await session.close()
  })

  it.each(["question", "permission"])(
    "settles provider-cancelled %s requests without ending the turn",
    async (kind) => {
      const child = new FakeChild()
      const started = deferred<AbortSignal>()
      const providerAbort = new AbortController()
      let answer: unknown
      attachAgent(child, {
        prompt: async (ctx) => {
          const pending =
            kind === "question"
              ? ctx.client.request("elicitation/create", question, {
                  cancellationSignal: providerAbort.signal,
                })
              : ctx.client.request(
                  "session/request_permission",
                  {
                    sessionId: "sess-1",
                    toolCall: { toolCallId: "tool-1", title: "Write", name: "Write" },
                    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
                  },
                  { cancellationSignal: providerAbort.signal }
                )
          await started.promise
          providerAbort.abort()
          answer = await pending
          return { stopReason: "end_turn" }
        },
      })
      const pendingHandler = async (_request: unknown, signal: AbortSignal) => {
        started.resolve(signal)
        return new Promise(() => {})
      }
      await runWith(
        child,
        kind === "question"
          ? { onQuestion: pendingHandler }
          : { permissionMode: "ask", onPermission: pendingHandler }
      )
      expect((await started.promise).aborted).toBe(true)
      expect(answer).toEqual(
        kind === "question" ? { action: "cancel" } : { outcome: { outcome: "cancelled" } }
      )
    }
  )

  it("keeps concurrent requests distinct and callbacks turn-local", async () => {
    const child = new FakeChild()
    const requests: Array<{ requestId: string; runId: string; seq: number }> = []
    const answers: unknown[] = []
    attachAgent(child, {
      prompt: async (ctx) => {
        answers.push(
          ...(await Promise.all([
            ctx.client.request("elicitation/create", question),
            ctx.client.request("elicitation/create", question),
          ]))
        )
        return { stopReason: "end_turn" }
      },
    })
    const session = await openWith(child)
    await session.prompt("first", {
      onQuestion: async (request) => {
        requests.push(request)
        return { action: "decline" }
      },
    })
    await session.prompt("headless")
    expect(requests).toHaveLength(2)
    expect(requests[0].requestId).not.toBe(requests[1].requestId)
    expect(requests[0].runId).toBe(requests[1].runId)
    expect(requests[0].seq).not.toBe(requests[1].seq)
    expect(answers).toEqual([
      { action: "decline" },
      { action: "decline" },
      { action: "cancel" },
      { action: "cancel" },
    ])
    await session.close()
  })
})

describe("structured question schema boundary", () => {
  it.each([
    { type: "string", anyOf: [{ const: "x" }] },
    { type: "string", const: "x" },
    { type: "string", pattern: "^x$" },
    { type: "number", exclusiveMaximum: 2 },
    { type: "number", multipleOf: 2 },
    { type: "boolean", enum: [true] },
    { type: "string", minLength: "3" },
    { type: "array", items: { type: "string", enum: ["x"], pattern: "x" } },
  ])("rejects unsupported or malformed constraints: %j", (field) => {
    expect(
      validateRuntimeQuestionContent({ type: "object", properties: { answer: field } }, {})
    ).toBe(false)
  })
  it("rejects required values that will disappear or change during transport", () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    }
    const hidden = Object.defineProperty({}, "answer", { value: "x", enumerable: false })
    const accessor = Object.defineProperty({}, "answer", { get: () => "x", enumerable: true })
    expect(validateRuntimeQuestionContent(schema, hidden)).toBe(false)
    expect(validateRuntimeQuestionContent(schema, accessor)).toBe(false)
  })
  it("rejects malformed required and root constraints without throwing", () => {
    expect(
      validateRuntimeQuestionContent({ type: "object", properties: {}, required: "answer" }, {})
    ).toBe(false)
    expect(validateRuntimeQuestionContent({ type: "object", properties: {}, anyOf: [] }, {})).toBe(
      false
    )
    expect(validateRuntimeQuestionContent(null, {})).toBe(false)
  })
  it("accepts the actual Claude multi-select shape and enforces constraints", () => {
    const schema = {
      type: "object",
      properties: {
        picks: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: {
            anyOf: [
              { const: "A", title: "Alpha" },
              { const: "B", description: "Beta" },
            ],
          },
        },
      },
      required: ["picks"],
    }
    expect(validateRuntimeQuestionContent(schema, { picks: ["A", "B"] })).toBe(true)
    expect(validateRuntimeQuestionContent(schema, { picks: [] })).toBe(false)
    expect(validateRuntimeQuestionContent(schema, { picks: ["A", "A"] })).toBe(false)
    expect(validateRuntimeQuestionContent(schema, { picks: ["C"] })).toBe(false)
    expect(validateRuntimeQuestionContent(schema, {})).toBe(false)
  })
})

// Lifecycle assertions exercise a real in-process ACP peer, not a mocked RPC client.
describe("AcpRuntime.openSession", () => {
  it("keeps one process/session across sequential prompts and isolates turn output/events", async () => {
    const child = new FakeChild()
    const created = vi.fn(() => ({ sessionId: "continuous" }))
    const seen: string[] = []
    attachAgent(child, {
      newSession: created,
      prompt: async (ctx) => {
        const text = ctx.params.prompt?.[0].text ?? ""
        seen.push(text)
        await notifyUpdate(ctx, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `answer:${text}` },
        })
        if (seen.length === 1) {
          await notifyUpdate(ctx, {
            sessionUpdate: "usage_update",
            used: 10,
            size: 100,
            cost: { amount: 0.1, currency: "USD" },
          })
        }
        return { stopReason: "end_turn" }
      },
    })
    const session = await openWith(child)
    const first = collect()
    const second = collect()
    try {
      expect(session.state).toBe("idle")
      expect(session.capabilities).toMatchObject({ continuation: true, supplement: false })
      const a = await session.prompt("implement", { onEvent: first.onEvent })
      const b = await session.prompt("fix review", { onEvent: second.onEvent })
      expect(a).toMatchObject({ output: "answer:implement", sessionId: "continuous", costUsd: 0.1 })
      expect(b.output).toBe("answer:fix review")
      expect(b.usage).toBeUndefined()
      expect(b.costUsd).toBeUndefined()
      expect(created).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(child.kill).not.toHaveBeenCalled()
      expect(first.events[0].runId).not.toBe(second.events[0].runId)
      expect(first.events.map((e) => e.seq)).toEqual(first.events.map((_, i) => i))
      expect(second.events.map((e) => e.seq)).toEqual(second.events.map((_, i) => i))
    } finally {
      await session.close()
    }
    expect(session.state).toBe("closed")
    await expect(session.prompt("after close")).rejects.toThrow()
  })

  it("rejects overlapping prompts instead of silently queuing user input", async () => {
    const child = new FakeChild()
    const started = deferred<void>()
    const finish = deferred<void>()
    attachAgent(child, {
      prompt: async () => {
        started.resolve()
        await finish.promise
        return { stopReason: "end_turn" }
      },
    })
    const session = await openWith(child)
    const first = session.prompt("first")
    await started.promise
    expect(session.state).toBe("running")
    await expect(session.prompt("not silently queued")).rejects.toThrow()
    finish.resolve()
    await first
    await session.close()
  })

  it("cancels the active turn and allows continuation in the same session", async () => {
    const child = new FakeChild()
    const started = deferred<void>()
    const finish = deferred<void>()
    let calls = 0
    attachAgent(child, {
      prompt: async () => {
        calls += 1
        if (calls === 1) {
          started.resolve()
          await finish.promise
          return { stopReason: "cancelled" }
        }
        return { stopReason: "end_turn" }
      },
      cancel: () => finish.resolve(),
    })
    const session = await openWith(child)
    const first = session.prompt("stop this")
    await started.promise
    await session.cancelTurn()
    expect(await first).toMatchObject({ stopReason: "cancelled" })
    expect(session.state).toBe("idle")
    expect(child.kill).not.toHaveBeenCalled()
    expect(await session.prompt("continue safely")).toMatchObject({ stopReason: "success" })
    await session.cancelTurn()
    await session.close()
  })

  it("waits for child cleanup before resolving close or the execute compatibility wrapper", async () => {
    const child = new FakeChild()
    child.autoClose = false
    attachAgent(child, {})
    let completed = false
    const promise = runWith(child).then(() => {
      completed = true
    })
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"))
    expect(completed).toBe(false)
    child.emit("close", 0)
    await promise
    expect(completed).toBe(true)
  })

  it("ignores session/load replay when collecting the next turn", async () => {
    const child = new FakeChild()
    attachAgent(child, {
      loadSession: () => ({}),
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "new turn" },
        })
        return { stopReason: "end_turn" }
      },
    })
    const session = await openWith(child, { sessionId: "saved" })
    const output = await session.prompt("continue")
    expect(output).toMatchObject({ sessionId: "saved", output: "new turn" })
    await session.close()
  })

  it("does not spawn for an already aborted session or prompt", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      new AcpRuntime().openSession(makeTask({ signal: controller.signal }))
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(spawnMock).not.toHaveBeenCalled()
    const child = new FakeChild()
    const prompt = vi.fn(() => ({ stopReason: "end_turn" }))
    attachAgent(child, { prompt })
    const session = await openWith(child)
    await expect(session.prompt("aborted", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(prompt).not.toHaveBeenCalled()
    expect(session.state).toBe("idle")
    await session.close()
  })

  it("does not launch after an abort during the lazy import boundary", async () => {
    const controller = new AbortController()
    const promise = new AcpRuntime().openSession(makeTask({ signal: controller.signal }))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("closes an idle session when its lifetime signal is aborted", async () => {
    const child = new FakeChild()
    attachAgent(child, {})
    const controller = new AbortController()
    const session = await openWith(child, { signal: controller.signal })
    controller.abort()
    await vi.waitFor(() => expect(session.state).toBe("closed"))
    await session.close()
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
  })

  it("settles an active turn when close is called and rejects further prompts", async () => {
    const child = new FakeChild()
    const started = deferred<void>()
    attachAgent(child, {
      prompt: () => {
        started.resolve()
        return new Promise(() => {})
      },
    })
    const session = await openWith(child)
    const result = session.prompt("working").catch((error: Error) => error)
    await started.promise
    await Promise.all([session.close(), session.close()])
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(child.kill).toHaveBeenCalledTimes(1)
    await expect(session.prompt("late")).rejects.toThrow()
  })

  it("escalates cleanup for a stubborn child without resolving close early", async () => {
    const child = new FakeChild()
    child.autoClose = false
    attachAgent(child, {})
    const session = await openWith(child)
    vi.useFakeTimers()
    let closed = false
    const closing = session.close().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(closed).toBe(false)
    child.emit("close", 0)
    await closing
    expect(closed).toBe(true)
  })

  it("rejects close and the active prompt when cleanup is never acknowledged", async () => {
    const child = new FakeChild()
    child.autoClose = false
    const started = deferred<void>()
    attachAgent(child, {
      prompt: () => {
        started.resolve()
        return new Promise(() => {})
      },
    })
    const session = await openWith(child)
    const result = session.prompt("working").catch((error: Error) => error)
    await started.promise
    vi.useFakeTimers()
    const closing = session.close()
    const rejection = expect(closing).rejects.toThrow(/cleanup failed/)
    await vi.advanceTimersByTimeAsync(6000)
    await rejection
    expect(await result).toMatchObject({ message: expect.stringContaining("cleanup failed") })
    expect(session.close()).toBe(closing)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
  })

  it("keeps cancellation pending until forced process cleanup is acknowledged", async () => {
    const child = new FakeChild()
    child.autoClose = false
    const started = deferred<void>()
    attachAgent(child, {
      prompt: () => {
        started.resolve()
        return new Promise(() => {})
      },
    })
    const session = await openWith(child)
    const result = session.prompt("stalled").catch((error: Error) => error)
    await started.promise
    vi.useFakeTimers()
    let acknowledged = false
    const cancelling = session.cancelTurn().then(() => {
      acknowledged = true
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(session.state).toBe("closing")
    expect(acknowledged).toBe(false)
    child.emit("close", 0)
    await cancelling
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(acknowledged).toBe(true)
  })

  it("fails cancellation safely when a provider never completes the turn", async () => {
    const child = new FakeChild()
    const started = deferred<void>()
    attachAgent(child, {
      prompt: () => {
        started.resolve()
        return new Promise(() => {})
      },
    })
    const session = await openWith(child)
    const result = session.prompt("stalled").catch((error: Error) => error)
    await started.promise
    vi.useFakeTimers()
    const cancelling = session.cancelTurn()
    await vi.advanceTimersByTimeAsync(2000)
    await cancelling
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(session.state).toBe("closed")
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    await session.close()
  })

  it("aborts a stalled initialization without ever sending a task prompt", async () => {
    const child = new FakeChild()
    const entered = deferred<void>()
    const prompt = vi.fn(() => ({ stopReason: "end_turn" }))
    attachAgent(child, {
      initialize: () => {
        entered.resolve()
        return new Promise(() => {})
      },
      prompt,
    })
    const controller = new AbortController()
    const opening = openWith(child, { signal: controller.signal })
    await entered.promise
    controller.abort()
    await expect(opening).rejects.toMatchObject({ name: "AbortError" })
    expect(prompt).not.toHaveBeenCalled()
  })

  it("treats a provider-side cancellation as an incomplete output", async () => {
    const child = new FakeChild()
    attachAgent(child, { prompt: () => ({ stopReason: "cancelled" }) })
    const session = await openWith(child)
    const result = await session.prompt("cancelled upstream")
    expect(result.stopReason).toBe("cancelled")
    expect(result.exitCode).not.toBe(0)
    expect(session.state).toBe("idle")
    await session.close()
  })

  it("times out a stalled handshake and waits for cleanup", async () => {
    const child = new FakeChild()
    attachAgent(child, { initialize: () => new Promise(() => {}) })
    await expect(openWith(child, { timeout: 20 })).rejects.toThrow(/timed out/)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
  })

  it("validates startup and per-turn timeout durations without closing a usable session", async () => {
    for (const timeout of [-1, Number.NaN, Infinity, 2_147_483_648]) {
      await expect(new AcpRuntime().openSession(makeTask({ timeout }))).rejects.toThrow(/timeout/)
    }
    const child = new FakeChild()
    attachAgent(child, {})
    const session = await openWith(child)
    await expect(session.prompt("bad timeout", { timeout: -1 })).rejects.toThrow(/timeout/)
    expect(session.state).toBe("idle")
    await session.prompt("valid")
    await session.cancelTurn()
    expect(session.state).toBe("idle")
    await session.close()
  })

  it("rejects unsupported fork rather than continuing the original session", async () => {
    await expect(
      new AcpRuntime().openSession(makeTask({ sessionId: "saved", resume: "fork" }))
    ).rejects.toThrow(/fork/i)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe("AcpRuntime · mid-turn input", () => {
  /**
   * An agent that can advertise steering and holds one prompt open.
   *
   * The prompt is deliberately long-lived: a steer is only meaningful while a
   * turn is running, so the test has to own that window rather than race it.
   */
  function steeringAgent(options: { advertised?: boolean; outcome?: string } = {}) {
    const child = new FakeChild()
    const started = deferred<void>()
    const finish = deferred<void>()
    const steers: Array<Record<string, unknown>> = []
    const cancels: unknown[] = []
    attachAgent(child, {
      initialize: () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        ...(options.advertised === false ? {} : { _meta: { steering: { supported: true } } }),
      }),
      steering: (params) => {
        steers.push(params as Record<string, unknown>)
        return { outcome: options.outcome ?? "injected" }
      },
      cancel: (params) => {
        cancels.push(params)
      },
      prompt: async () => {
        started.resolve()
        await finish.promise
        return { stopReason: "end_turn" }
      },
    })
    return { child, started, finish, steers, cancels }
  }

  it("advertises the capability only when the agent did, and injects into the live turn", async () => {
    const agent = steeringAgent()
    const session = await openWith(agent.child)
    try {
      expect(session.capabilities).toEqual({ continuation: true, supplement: true })
      const turn = session.prompt("long task")
      await agent.started.promise

      const result = await session.supplement?.("use postgres, not sqlite")

      expect(result).toEqual({ status: "injected" })
      expect(agent.steers).toHaveLength(1)
      // The exact wire contract the two bridges agreed on: the text as a content
      // block, scoped to this session, and an explicit "do not start a turn".
      expect(agent.steers[0]).toEqual({
        sessionId: "sess-1",
        prompt: [{ type: "text", text: "use postgres, not sqlite" }],
        _meta: { steering: { idleBehavior: "promptRequired" } },
      })
      agent.finish.resolve()
      await turn
    } finally {
      await session.close()
    }
  })

  it("never asks the agent to steer an idle session", async () => {
    // Both bridges start a turn from a steer when nothing is running, and a turn
    // this adapter never started has no owner: nothing settles it, its output
    // belongs to no turn, and the caller cannot cancel it. So the answer is
    // "idle" and the caller keeps its text.
    const agent = steeringAgent()
    const session = await openWith(agent.child)
    try {
      expect(await session.supplement?.("too late")).toEqual({ status: "idle" })
      expect(agent.steers).toEqual([])
    } finally {
      await session.close()
    }
  })

  it("cancels a turn the agent started on its own when the steer raced the end", async () => {
    const agent = steeringAgent({ outcome: "startedNewTurn" })
    const session = await openWith(agent.child)
    try {
      const turn = session.prompt("long task")
      await agent.started.promise

      expect(await session.supplement?.("raced")).toEqual({ status: "idle" })
      // Nothing owns that turn, so it must not be left running.
      await vi.waitFor(() => expect(agent.cancels).toHaveLength(1))
      expect(agent.cancels[0]).toEqual({ sessionId: "sess-1" })
      agent.finish.resolve()
      await turn
    } finally {
      await session.close()
    }
  })

  it("treats a refused idle steer as idle rather than a failure", async () => {
    // Claude answers `promptRequired` when asked not to start a turn; Codex has
    // no such refusal and is covered by the `startedNewTurn` case above.
    const agent = steeringAgent({ outcome: "promptRequired" })
    const session = await openWith(agent.child)
    try {
      const turn = session.prompt("long task")
      await agent.started.promise
      expect(await session.supplement?.("nope")).toEqual({ status: "idle" })
      expect(agent.cancels).toEqual([])
      agent.finish.resolve()
      await turn
    } finally {
      await session.close()
    }
  })

  it("reports an agent that cannot take mid-turn input instead of sending the method", async () => {
    const agent = steeringAgent({ advertised: false })
    const session = await openWith(agent.child)
    try {
      expect(session.capabilities).toEqual({ continuation: true, supplement: false })
      await expect(session.supplement?.("hello")).rejects.toThrow(/mid-turn input/i)
      expect(agent.steers).toEqual([])
    } finally {
      await session.close()
    }
  })

  it("rejects when the agent says it could not apply the message", async () => {
    const agent = steeringAgent({ outcome: "failed" })
    const session = await openWith(agent.child)
    try {
      const turn = session.prompt("long task")
      await agent.started.promise
      await expect(session.supplement?.("hello")).rejects.toThrow(/could not apply/i)
      agent.finish.resolve()
      await turn
    } finally {
      await session.close()
    }
  })
})

describe("AcpRuntime.describe", () => {
  it("reports exactly the capabilities this adapter implements", async () => {
    // Asked about the one bridge that enforces an allowlist, so this is the
    // adapter's full capability set. `tools` and `models` are provider-dependent
    // and have their own tests below.
    const info = await new AcpRuntime().describe({ command: "claude-agent-acp" })
    expect(info).toMatchObject({
      name: "acp",
      capabilities: {
        streaming: true,
        sessions: true,
        resume: true,
        permissions: true,
        tools: true,
        models: true,
        images: false,
        usage: true,
        cost: true,
        sandbox: false,
      },
    })
  })

  it("reports tools only for a bridge that can enforce an allowlist", async () => {
    // Only some bridges read an allowlist out of `_meta`, and none negotiates
    // it. Claiming it for one that ignores `task.tools` would tell the caller a
    // restriction landed while the agent runs with its binary's defaults.
    const tools = async (command?: string) =>
      (await new AcpRuntime().describe(command === undefined ? undefined : { command }))
        .capabilities.tools

    expect(await tools("claude-agent-acp")).toBe(true)
    expect(await tools("codex-acp")).toBe(false)
    expect(await tools("opencode")).toBe(false)
    // The default command is `opencode`, which has no known `_meta` contract.
    expect(await tools()).toBe(false)
  })

  it("is available when the default command resolves on PATH", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-path-"))
    const bin = path.join(dir, "opencode")
    fs.writeFileSync(bin, "#!/bin/sh\n")
    fs.chmodSync(bin, 0o755)
    const original = process.env.PATH
    // A leading empty entry exercises the PATH-splitting filter.
    process.env.PATH = `${path.delimiter}${dir}`
    try {
      expect((await new AcpRuntime().describe()).available).toBe(true)
    } finally {
      process.env.PATH = original
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resolves a command through PATHEXT-style suffixes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-path-ext-"))
    const bin = path.join(dir, "opencode.sh")
    fs.writeFileSync(bin, "#!/bin/sh\n")
    fs.chmodSync(bin, 0o755)
    const originalPath = process.env.PATH
    const originalExt = process.env.PATHEXT
    process.env.PATH = dir
    process.env.PATHEXT = ".sh"
    try {
      expect((await new AcpRuntime().describe()).available).toBe(true)
    } finally {
      process.env.PATH = originalPath
      if (originalExt === undefined) delete process.env.PATHEXT
      else process.env.PATHEXT = originalExt
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("is unavailable when the command is not on PATH", async () => {
    const original = process.env.PATH
    process.env.PATH = "/nonexistent-dir-for-acp-test"
    try {
      expect((await new AcpRuntime().describe()).available).toBe(false)
    } finally {
      process.env.PATH = original
    }
  })

  it("probes the caller-supplied command, falling back to the default", async () => {
    // An ACP agent is whatever binary the config pinned. Probing only the
    // default would report an installed `codex-acp` as missing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cmd-"))
    const bin = path.join(dir, "codex-acp")
    fs.writeFileSync(bin, "#!/bin/sh\n")
    fs.chmodSync(bin, 0o755)
    const original = process.env.PATH
    // Only `codex-acp` exists here, so the default `opencode` is absent.
    process.env.PATH = dir
    try {
      expect((await new AcpRuntime().describe({ command: "codex-acp" })).available).toBe(true)
      expect((await new AcpRuntime().describe({ command: "not-installed-xyz" })).available).toBe(
        false
      )
      expect((await new AcpRuntime().describe()).available).toBe(false)
    } finally {
      process.env.PATH = original
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("AcpRuntime.execute", () => {
  it("spawns the configured command in its own process group", async () => {
    const child = new FakeChild()
    attachAgent(child, {})
    const p = runWith(child, { command: "codex-acp", args: ["--acp"] })
    await untilSpawned()

    expect(spawnMock).toHaveBeenCalledWith(
      "codex-acp",
      ["--acp"],
      expect.objectContaining({ cwd: "/tmp/work", detached: true })
    )

    child.emit("close", 0)
    await p.catch(() => undefined)
  })

  it("maps ACP updates onto runtime events and returns the session id", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        })
        await notifyUpdate(ctx, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello " },
        })
        await notifyUpdate(ctx, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world" },
        })
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read a file",
          name: "Read",
          rawInput: { path: "a.txt" },
        })
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          rawOutput: "file contents",
        })
        await notifyUpdate(ctx, {
          sessionUpdate: "plan",
          entries: [{ content: "step 1", priority: "high", status: "pending" }],
        })
        // Schema-valid but not mapped: must surface as `raw`, not throw.
        await notifyUpdate(ctx, {
          sessionUpdate: "available_commands_update",
          availableCommands: [],
        })
        return { stopReason: "end_turn" }
      },
    })

    const output = await runWith(child, { onEvent })

    expect(output).toMatchObject({
      output: "hello world",
      exitCode: 0,
      sessionId: "sess-1",
      stopReason: "success",
    })

    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "message_delta",
      "message_delta",
      "message_delta",
      "tool_call",
      "tool_result",
      "plan",
      "raw",
      "run_finished",
    ])
    expect(events.filter((e) => e.type === "message_delta")).toEqual([
      expect.objectContaining({ role: "thought", text: "thinking" }),
      expect.objectContaining({ role: "agent", text: "hello " }),
      expect.objectContaining({ role: "agent", text: "world" }),
    ])
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      id: "t1",
      name: "Read",
      input: { path: "a.txt" },
    })
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      id: "t1",
      output: "file contents",
      isError: false,
    })
    expect(events.find((e) => e.type === "plan")).toMatchObject({ entries: ["step 1"] })
    expect(events.find((e) => e.type === "raw")).toMatchObject({
      vendor: "acp",
      payload: expect.objectContaining({ sessionUpdate: "available_commands_update" }),
    })
    expect(events.find((e) => e.type === "run_finished")).toMatchObject({ stopReason: "success" })
  })

  it("marks a failed tool call update as an error result", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t2",
          status: "failed",
          rawOutput: { message: "boom" },
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      id: "t2",
      output: JSON.stringify({ message: "boom" }),
      isError: true,
    })
  })

  it("maps a user_message_chunk to a message_delta with role user, kept out of the output", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "the question" },
        })
        await notifyUpdate(ctx, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "the answer" },
        })
        return { stopReason: "end_turn" }
      },
    })

    const output = await runWith(child, { onEvent })

    expect(events.filter((e) => e.type === "message_delta")).toEqual([
      expect.objectContaining({ role: "user", text: "the question" }),
      expect.objectContaining({ role: "agent", text: "the answer" }),
    ])
    // The user's own words are not the agent's output.
    expect(output.output).toBe("the answer")
  })

  it("surfaces a non-text user message chunk as raw", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "user_message_chunk",
          content: { type: "image", data: "aGk=", mimeType: "image/png" },
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })
    expect(events.find((e) => e.type === "raw")).toMatchObject({ vendor: "acp" })
    expect(events.some((e) => e.type === "message_delta")).toBe(false)
  })

  it("loads an existing session when a sessionId is supplied", async () => {
    const child = new FakeChild()
    let loaded: unknown
    attachAgent(child, {
      loadSession: (params) => {
        loaded = params
        return {}
      },
    })

    const output = await runWith(child, { sessionId: "11111111-2222-3333-4444-555555555555" })
    expect(loaded).toMatchObject({
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: "/tmp/work",
    })
    expect(output.sessionId).toBe("11111111-2222-3333-4444-555555555555")
  })

  it("rejects instead of sending session/load when the agent cannot load sessions", async () => {
    const child = new FakeChild()
    attachAgent(child, {
      initialize: () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      }),
    })

    // Must NOT silently create a fresh session: the caller asked to resume and
    // would wrongly believe it did.
    await expect(
      runWith(child, { sessionId: "11111111-2222-3333-4444-555555555555" })
    ).rejects.toThrow(/does not support session\/load/)
  })

  it.each([
    ["end_turn", "success"],
    ["cancelled", "cancelled"],
    ["max_tokens", "max_turns"],
    ["max_turn_requests", "max_turns"],
    ["refusal", "error"],
  ])("maps the ACP stop reason %s to %s", async (acpReason, expected) => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, { prompt: () => ({ stopReason: acpReason }) })

    const output = await runWith(child, { onEvent })
    expect(output.stopReason).toBe(expected)
    expect(events.find((e) => e.type === "run_finished")).toMatchObject({ stopReason: expected })
  })

  it("surfaces a non-text message chunk as raw", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: "aGk=", mimeType: "image/png" },
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })
    expect(events.find((e) => e.type === "raw")).toMatchObject({
      vendor: "acp",
      payload: expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
    })
    expect(events.some((e) => e.type === "message_delta")).toBe(false)
  })

  it("surfaces a non-text thought chunk as raw", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "image", data: "aGk=", mimeType: "image/png" },
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })
    expect(events.find((e) => e.type === "raw")).toMatchObject({ vendor: "acp" })
  })

  it("drops an unrecognised session update variant without failing the run", async () => {
    // The SDK validates every `session/update` against the ACP schema before it
    // is delivered, so a variant this SDK version does not know is discarded at
    // the boundary — the adapter never sees it. The contract that matters is
    // that the drop is silent and non-fatal: no `raw` event, no throw, and the
    // turn still finishes.
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, { sessionUpdate: "brand_new_thing", value: 1 })
        return { stopReason: "end_turn" }
      },
    })

    const output = await runWith(child, { onEvent })
    expect(output.stopReason).toBe("success")
    expect(events.some((e) => e.type === "raw")).toBe(false)
    expect(events.find((e) => e.type === "run_finished")).toMatchObject({ stopReason: "success" })
  })

  it("falls back to the tool title when a tool call has no name", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call",
          toolCallId: "t3",
          title: "Do a thing",
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      id: "t3",
      name: "Do a thing",
    })
  })

  it("tolerates an unknown _meta extension on a known update", async () => {
    const child = new FakeChild()
    const { onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
          _meta: { steering: { note: "codex-acp sends this" } },
        })
        return { stopReason: "end_turn" }
      },
    })

    const output = await runWith(child, { onEvent })
    expect(output.output).toBe("hi")
  })

  it("rejects when the agent answers a request with a protocol error", async () => {
    const child = new FakeChild()
    attachAgent(child, {
      initialize: () => {
        throw new Error("agent refused to initialize")
      },
    })

    // A throwing agent handler becomes a JSON-RPC `-32603` error, which the SDK
    // surfaces to the caller as the generic "Internal error" — the request fails
    // and the run rejects instead of hanging.
    await expect(runWith(child)).rejects.toThrow("Internal error")
  })

  it("rejects when the turn exceeds the timeout", async () => {
    const child = new FakeChild()
    let started: () => void = () => {}
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    attachAgent(child, {
      prompt: () => {
        started()
        return new Promise(() => {})
      },
    })

    const p = runWith(child, { timeout: 20 })
    const rejection = expect(p).rejects.toThrow("acp timed out (20ms)")
    await promptStarted
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"))
    child.emit("close", null)

    await rejection
  })

  it("sends session/cancel on abort and rejects with an AbortError", async () => {
    const child = new FakeChild()
    let cancelled: unknown
    let releasePrompt: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    let started: () => void = () => {}
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve
    })

    attachAgent(child, {
      prompt: async () => {
        started()
        await gate
        return { stopReason: "cancelled" }
      },
      cancel: (params) => {
        cancelled = params
        releasePrompt()
      },
    })

    const controller = new AbortController()
    const p = runWith(child, { signal: controller.signal })
    await promptStarted
    controller.abort()

    const error = await p.then(
      () => undefined,
      (err: Error) => err
    )
    expect(error?.name).toBe("AbortError")
    expect(cancelled).toMatchObject({ sessionId: "sess-1" })
  })

  it("rejects on abort even before a session exists", async () => {
    const child = new FakeChild()
    // Initialize never answers, so no session is ever created.
    attachAgent(child, { initialize: () => new Promise(() => {}) })

    const controller = new AbortController()
    const p = runWith(child, { signal: controller.signal })
    await untilSpawned()
    controller.abort()
    child.emit("close", 0)

    const error = await p.then(
      () => undefined,
      (err: Error) => err
    )
    expect(error?.name).toBe("AbortError")
  })

  it("rejects when the agent process exits non-zero", async () => {
    const child = new FakeChild()
    const p = runWith(child)
    await untilSpawned()
    child.stderr.emit("data", Buffer.from("boom"))
    child.emit("close", 1)

    await expect(p).rejects.toThrow("opencode exited with code 1: boom")
  })

  it("preserves a multi-byte codepoint split across a stderr chunk boundary", async () => {
    const child = new FakeChild()
    const p = runWith(child)
    await untilSpawned()

    // Same stateless-decode trap as ClaudeRuntime's stderr: a per-chunk
    // `Buffer.toString()` would turn each half of 中 (E4 B8 AD) into U+FFFD.
    const full = Buffer.from("boom 中", "utf8")
    const charIndex = full.indexOf(Buffer.from("中", "utf8"))
    expect(charIndex).toBeGreaterThan(0)
    const splitAt = charIndex + 1
    child.stderr.emit("data", full.subarray(0, splitAt))
    child.stderr.emit("data", full.subarray(splitAt))
    child.emit("close", 1)

    await expect(p).rejects.toThrow("opencode exited with code 1: boom 中")
  })

  it("rejects when the process fails to start", async () => {
    const child = new FakeChild()
    const p = runWith(child)
    await untilSpawned()
    child.emit("error", new Error("ENOENT"))

    await expect(p).rejects.toThrow("Failed to start opencode: ENOENT")
  })

  it("sends session/set_config_option when task.model is configured", async () => {
    const child = new FakeChild()
    let configReq: unknown
    attachAgent(child, {
      newSession: () => ({
        sessionId: "sess-1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "default",
            options: [{ value: "default" }, { value: "sonnet" }],
          },
        ],
      }),
      setConfigOption: (params) => {
        configReq = params
        return {}
      },
    })

    await runWith(child, { command: "claude-agent-acp", model: "sonnet" })
    expect(configReq).toMatchObject({ sessionId: "sess-1", configId: "model", value: "sonnet" })
  })

  it("does not send session/set_config_option when task.model is absent", async () => {
    const child = new FakeChild()
    let configReq: unknown = "not-called"
    attachAgent(child, {
      newSession: () => ({
        sessionId: "sess-1",
        configOptions: [
          { id: "model", category: "model", type: "select", currentValue: "default", options: [] },
        ],
      }),
      setConfigOption: (params) => {
        configReq = params
        return {}
      },
    })

    await runWith(child, { command: "claude-agent-acp" })
    expect(configReq).toBe("not-called")
  })

  it("does not fail the run when the configured model is not in the provider's list", async () => {
    const child = new FakeChild()
    attachAgent(child, {
      newSession: () => ({
        sessionId: "sess-1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "default",
            options: [{ value: "default" }],
          },
        ],
      }),
    })

    const output = await runWith(child, { command: "claude-agent-acp", model: "unknown-model" })
    expect(output.exitCode).toBe(0)
  })

  it("reports an unknown model through onWarning rather than stderr", async () => {
    const child = new FakeChild()
    attachAgent(child, {
      newSession: () => ({
        sessionId: "sess-1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "default",
            options: [{ value: "default" }],
          },
        ],
      }),
    })

    const warnings: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      await runWith(child, {
        command: "claude-agent-acp",
        model: "unknown-model",
        onWarning: (message: string) => warnings.push(message),
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("unknown-model")
      // The caller's channel is used, so nothing lands where a TUI would hide it.
      expect(stderrSpy).not.toHaveBeenCalled()
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("falls back to stderr for a warning when the caller supplies no channel", async () => {
    const child = new FakeChild()
    attachAgent(child, {
      newSession: () => ({
        sessionId: "sess-1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "default",
            options: [{ value: "default" }],
          },
        ],
      }),
    })

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      await runWith(child, { command: "claude-agent-acp", model: "unknown-model" })
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("unknown-model"))
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("warns, including the error, when the model cannot be set", async () => {
    const child = new FakeChild()
    attachAgent(child, {
      newSession: () => ({
        sessionId: "sess-1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "default",
            options: [{ value: "sonnet" }],
          },
        ],
      }),
      setConfigOption: () => {
        throw new Error("nope")
      },
    })

    const warnings: string[] = []
    await runWith(child, {
      command: "claude-agent-acp",
      model: "sonnet",
      onWarning: (message: string) => warnings.push(message),
    })

    // Fail-closed on the model, but not silent: the user must learn which model
    // actually ran and why the requested one did not take. The SDK surfaces a
    // throwing agent handler as the generic "Internal error", so the message is
    // asserted to *carry* an error, not a specific one.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("Could not set model")
    expect(warnings[0]).toContain("sonnet")
    expect(warnings[0]).toContain("claude-agent-acp")
    expect(warnings[0]).toMatch(/provider's default \(.+\)/)
  })
})

/** Params of a session-defining request, as captured from the fake agent. */
type SessionParams = Record<string, unknown> & {
  _meta?: Record<string, unknown>
  prompt?: Array<{ type: string; text: string }>
}

describe("AcpRuntime · agent context delivery", () => {
  it("sends the system prompt via _meta on a meta bridge, without prefixing the prompt", async () => {
    const child = new FakeChild()
    let newParams: SessionParams | undefined
    let promptParams: SessionParams | undefined
    attachAgent(child, {
      newSession: (params) => {
        newParams = params as SessionParams
        return { sessionId: "sess-1" }
      },
      prompt: (ctx) => {
        promptParams = ctx.params as SessionParams
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { command: "claude-agent-acp", systemPrompt: "You are a pirate." })

    expect(newParams?._meta).toMatchObject({ systemPrompt: "You are a pirate." })
    // Mutually exclusive modes: meta mode must NOT also prefix.
    expect(promptParams?.prompt?.[0].text).toBe("do it")
  })

  it("prefixes the prompt on a bridge with no known _meta contract", async () => {
    // `opencode` is the default command and speaks ACP natively, but we have no
    // evidence it reads any `_meta` key — so the role prompt goes in the text.
    const child = new FakeChild()
    let newParams: SessionParams | undefined
    let promptParams: SessionParams | undefined
    attachAgent(child, {
      newSession: (params) => {
        newParams = params as SessionParams
        return { sessionId: "sess-1" }
      },
      prompt: (ctx) => {
        promptParams = ctx.params as SessionParams
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { command: "opencode", systemPrompt: "You are a pirate." })

    expect(newParams?._meta).toBeUndefined()
    expect(promptParams?.prompt?.[0].text).toBe("You are a pirate.\n\n---\n\ndo it")
  })

  it("sends the role prompt to codex-acp through the AIR namespace", async () => {
    const child = new FakeChild()
    let newParams: SessionParams | undefined
    let promptParams: SessionParams | undefined
    attachAgent(child, {
      newSession: (params) => {
        newParams = params as SessionParams
        return { sessionId: "sess-1" }
      },
      prompt: (ctx) => {
        promptParams = ctx.params as SessionParams
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { command: "codex-acp", systemPrompt: "You are a pirate." })

    // The adapter reads `_meta.jetbrains.air.customInstructions` and forwards it
    // to Codex as `developerInstructions` — a real system-level instruction.
    expect(newParams?._meta).toEqual({
      jetbrains: { air: { customInstructions: "You are a pirate." } },
    })
    // Not prefixed as well: that would send the role twice.
    expect(promptParams?.prompt?.[0].text).toBe("do it")
  })

  it("sends no tool allowlist to a bridge that cannot enforce one", async () => {
    const child = new FakeChild()
    let newParams: SessionParams | undefined
    attachAgent(child, {
      newSession: (params) => {
        newParams = params as SessionParams
        return { sessionId: "sess-1" }
      },
    })

    await runWith(child, { command: "codex-acp", systemPrompt: "sys", tools: ["Read"] })

    // codex-acp has no tool-restriction key at any granularity, so an allowlist
    // is dropped rather than sent to a namespace that would ignore it.
    expect(newParams?._meta).toEqual({
      jetbrains: { air: { customInstructions: "sys" } },
    })
  })

  it("leaves the prompt untouched when the system prompt is empty, on every bridge", async () => {
    for (const command of ["claude-agent-acp", "codex-acp", "opencode"]) {
      const child = new FakeChild()
      let newParams: SessionParams | undefined
      let promptParams: SessionParams | undefined
      attachAgent(child, {
        newSession: (params) => {
          newParams = params as SessionParams
          return { sessionId: "sess-1" }
        },
        prompt: (ctx) => {
          promptParams = ctx.params as SessionParams
          return { stopReason: "end_turn" }
        },
      })

      await runWith(child, { command, systemPrompt: "" })

      expect(newParams?._meta?.systemPrompt).toBeUndefined()
      expect(promptParams?.prompt?.[0].text).toBe("do it")
    }
  })

  it("resolves a path-qualified command to the meta bridge", async () => {
    const child = new FakeChild()
    let newParams: SessionParams | undefined
    attachAgent(child, {
      newSession: (params) => {
        newParams = params as SessionParams
        return { sessionId: "sess-1" }
      },
    })

    await runWith(child, { command: "/usr/local/bin/claude-agent-acp", systemPrompt: "sys" })

    expect(newParams?._meta).toMatchObject({ systemPrompt: "sys" })
  })

  it("carries _meta on session/load too, when resuming", async () => {
    const child = new FakeChild()
    let loadParams: SessionParams | undefined
    attachAgent(child, {
      loadSession: (params) => {
        loadParams = params as SessionParams
        return {}
      },
    })

    await runWith(child, {
      command: "claude-agent-acp",
      systemPrompt: "sys",
      sessionId: "11111111-2222-3333-4444-555555555555",
    })

    expect(loadParams?._meta).toMatchObject({ systemPrompt: "sys" })
  })

  it("maps task.tools into the claude-agent-acp namespace only", async () => {
    const metaChild = new FakeChild()
    let metaParams: SessionParams | undefined
    attachAgent(metaChild, {
      newSession: (params) => {
        metaParams = params as SessionParams
        return { sessionId: "sess-1" }
      },
    })
    await runWith(metaChild, { command: "claude-agent-acp", tools: ["Read"] })
    expect(metaParams?._meta).toMatchObject({ claudeCode: { options: { tools: ["Read"] } } })

    const promptChild = new FakeChild()
    let promptParams: SessionParams | undefined
    attachAgent(promptChild, {
      newSession: (params) => {
        promptParams = params as SessionParams
        return { sessionId: "sess-1" }
      },
    })
    await runWith(promptChild, { command: "codex-acp", tools: ["Read"] })
    expect(promptParams?._meta).toBeUndefined()
  })

  it("sends an explicit empty tool list, not the bridge preset (fail-closed)", async () => {
    const child = new FakeChild()
    let newParams: SessionParams | undefined
    attachAgent(child, {
      newSession: (params) => {
        newParams = params as SessionParams
        return { sessionId: "sess-1" }
      },
    })

    // AgentRunner defaults an unset `tools` to ["Read","Write","Bash"], so an
    // empty array can only be an explicit `tools: []`. It must mean "no tools",
    // not "fall back to every built-in tool".
    await runWith(child, { command: "claude-agent-acp", tools: [] })

    expect(newParams?._meta).toMatchObject({ claudeCode: { options: { tools: [] } } })
  })

  it("appends a login hint to an authentication-required error", async () => {
    const child = new FakeChild()
    attachAgent(child, {
      prompt: () => {
        throw acp.RequestError.authRequired()
      },
    })

    await expect(runWith(child)).rejects.toThrow(/run `claude` to log in/)
  })
})

/** A permission request as the agent sends it: `sessionId` filled in by the helper. */
interface PermissionRequest {
  sessionId?: string
  toolCallId?: string
  name?: string
  kind?: string
  title?: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

/**
 * Ask the client for permission from the agent side, as the live bridge does
 * mid-turn, and return the decision the adapter sent back.
 */
function askPermission(ctx: AgentPromptContext, request: PermissionRequest): Promise<unknown> {
  return ctx.client.request(acp.methods.client.session.requestPermission, {
    sessionId: request.sessionId ?? ctx.params.sessionId,
    toolCall: {
      toolCallId: request.toolCallId ?? "tc-1",
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.kind !== undefined ? { kind: request.kind } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
    },
    options: request.options,
  })
}

const PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "allow-always", name: "Always", kind: "allow_always" },
  { optionId: "reject-once", name: "No", kind: "reject_once" },
]

const REJECT_ONLY = [{ optionId: "reject-once", name: "No", kind: "reject_once" }]

describe("AcpRuntime · session/request_permission", () => {
  it("never automatically selects durable-only permissions", async () => {
    const child = new FakeChild()
    const decisions: unknown[] = []
    attachAgent(child, {
      prompt: async (ctx) => {
        decisions.push(
          await askPermission(ctx, {
            name: "Read",
            options: [{ optionId: "always", name: "Always", kind: "allow_always" }],
          })
        )
        decisions.push(
          await askPermission(ctx, {
            name: "Write",
            options: [{ optionId: "never", name: "Never", kind: "reject_always" }],
          })
        )
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, { tools: ["Read"] })
    expect(decisions).toEqual([
      { outcome: { outcome: "cancelled" } },
      { outcome: { outcome: "cancelled" } },
    ])
  })

  it("allows a durable choice only when explicitly selected by the human handler", async () => {
    const child = new FakeChild()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        // `Write` is outside the default allowlist, so `ask` escalates it.
        decision = await askPermission(ctx, { name: "Write", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, { permissionMode: "ask", onPermission: async () => "allow-always" })
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } })
  })

  it("waits for a turn-local human decision and returns only the selected offered option", async () => {
    const child = new FakeChild()
    const choice = deferred<string>()
    const received = deferred<void>()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, {
          name: "Write",
          title: "Write fixture",
          options: PERMISSION_OPTIONS,
        })
        return { stopReason: "end_turn" }
      },
    })
    const handler = vi.fn((request) => {
      expect(request).toMatchObject({
        agentId: "a1",
        sessionId: "sess-1",
        toolCallId: "tc-1",
        title: "Write fixture",
      })
      expect(request.requestId).toBeTruthy()
      received.resolve()
      return choice.promise
    })
    const session = await openWith(child)
    try {
      const pending = session.prompt("first", { permissionMode: "ask", onPermission: handler })
      await received.promise
      expect(decision).toBeUndefined()
      choice.resolve("allow-once")
      await pending
      expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } })
      await session.prompt("second", { permissionMode: "ask" })
      // No handler this time, so the escalation fails closed on the reject
      // option the provider offered.
      expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } })
      expect(handler).toHaveBeenCalledTimes(1)
    } finally {
      await session.close()
    }
  })

  it("denies an allowlisted tool in deny mode even though the list covers it", async () => {
    const child = new FakeChild()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, { name: "Read", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, { permissionMode: "deny" })
    expect(decision).toEqual({ outcome: { outcome: "cancelled" } })
  })

  it("fails closed in ask mode when there is no handler to ask", async () => {
    const child = new FakeChild()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        // Outside the allowlist and nobody to ask: the tool must not run.
        decision = await askPermission(ctx, { name: "Write", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, { permissionMode: "ask" })
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } })
  })

  it("does not ask about a tool the allowlist already covers", async () => {
    const child = new FakeChild()
    const onPermission = vi.fn(async () => "reject-once")
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, { name: "Read", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, { tools: ["Read"], permissionMode: "ask", onPermission })
    // The list is the policy; `ask` only escalates what it does not cover.
    expect(onPermission).not.toHaveBeenCalled()
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } })
  })

  it("escalates a tool the allowlist does not cover to the person", async () => {
    const child = new FakeChild()
    const onPermission = vi.fn(async () => "allow-once")
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, { name: "Write", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, { tools: ["Read"], permissionMode: "ask", onPermission })
    expect(onPermission).toHaveBeenCalledTimes(1)
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } })
  })

  it("still denies a tool outside the allowlist without asking in auto mode", async () => {
    const child = new FakeChild()
    const onPermission = vi.fn(async () => "allow-once")
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, { name: "Write", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, { tools: ["Read"], onPermission })
    // Escalation is opt-in: `auto` keeps the fail-closed default.
    expect(onPermission).not.toHaveBeenCalled()
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } })
  })

  it("records a refusal chosen by the person, marked as theirs", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await askPermission(ctx, {
          toolCallId: "tc-declined",
          name: "Write",
          options: PERMISSION_OPTIONS,
        })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, {
      tools: ["Read"],
      permissionMode: "ask",
      onPermission: async () => "reject-once",
      onEvent,
    })
    expect(events.find((e) => e.type === "raw")).toMatchObject({
      payload: { type: "permission_rejected", toolCallId: "tc-declined", source: "user" },
    })
  })

  it.each([
    ["mcp__graft__*", "mcp__graft__graft_repo_map", true],
    ["mcp__graft__*", "mcp__graft__graft_find_code", true],
    ["mcp__graft__*", "mcp__codegraph__codegraph_explore", false],
    ["MCP__GRAFT__*", "mcp__graft__graft_repo_map", true],
    ["mcp__*", "mcp__anything__at_all", true],
    ["a.b", "axb", false],
    ["a.b", "a.b", true],
  ])("matches allowlist entry %s against %s as %s", async (pattern, name, expected) => {
    const child = new FakeChild()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, { name, options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, { tools: [pattern] })
    // An allowlisted tool is allowed without a handler in the default mode; a
    // miss falls back to the reject option.
    expect(decision).toEqual({
      outcome: {
        outcome: "selected",
        optionId: expected ? "allow-once" : "reject-once",
      },
    })
  })

  it.each(["invalid", "throws", "mutated"])("rejects a %s handler answer", async (answer) => {
    const child = new FakeChild()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, { name: "Write", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    await runWith(child, {
      permissionMode: "ask",
      onPermission: async (request: { options: unknown[] }) => {
        if (answer === "throws") throw new Error("UI failed")
        if (answer === "mutated") request.options.push({ optionId: "invented", kind: "allow_once" })
        return "invented"
      },
    })
    expect(decision).toEqual({ outcome: { outcome: "cancelled" } })
  })

  it("cancels a hanging decision even when its handler ignores abort, then allows another turn", async () => {
    const child = new FakeChild()
    const requested = deferred<void>()
    const late = deferred<string>()
    let signal: AbortSignal | undefined
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, { name: "Write", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    const session = await openWith(child)
    try {
      const pending = session.prompt("first", {
        permissionMode: "ask",
        onPermission: (_request, abort) => {
          signal = abort
          requested.resolve()
          return late.promise
        },
      })
      await requested.promise
      await session.cancelTurn()
      await pending
      expect(signal?.aborted).toBe(true)
      expect(decision).toEqual({ outcome: { outcome: "cancelled" } })
      late.resolve("allow-always")
      await session.prompt("next", { permissionMode: "deny" })
      expect(decision).toEqual({ outcome: { outcome: "cancelled" } })
    } finally {
      await session.close()
    }
  })

  it("keeps the turn deadline while waiting and aborts the decision on timeout", async () => {
    const child = new FakeChild()
    const requested = deferred<void>()
    let signal: AbortSignal | undefined
    attachAgent(child, {
      prompt: async (ctx) => {
        await askPermission(ctx, { name: "Write", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })
    const session = await openWith(child)
    const pending = session.prompt("wait", {
      timeout: 80,
      permissionMode: "ask",
      onPermission: (_request, abort) => {
        signal = abort
        requested.resolve()
        return new Promise(() => {})
      },
    })
    const assertion = expect(pending).rejects.toThrow("timed out")
    await requested.promise
    await assertion
    expect(signal?.aborted).toBe(true)
    expect(session.state).toBe("closed")
    await session.close()
  })

  it("approves a tool named in task.tools using only a one-time option", async () => {
    const child = new FakeChild()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, {
          name: "Write",
          kind: "edit",
          options: PERMISSION_OPTIONS,
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { tools: ["Read", "Write"] })
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } })
  })

  it("rejects a tool that is not in task.tools and emits a visible raw event", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, {
          toolCallId: "tc-write",
          name: "Write",
          kind: "edit",
          title: "Write /tmp/work/hello.txt",
          options: PERMISSION_OPTIONS,
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { tools: ["Read"], onEvent })
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } })
    // A rejection is otherwise invisible: the tool simply never runs.
    expect(events.find((e) => e.type === "raw")).toMatchObject({
      vendor: "acp",
      payload: {
        type: "permission_rejected",
        toolCallId: "tc-write",
        name: "Write",
        kind: "edit",
        title: "Write /tmp/work/hello.txt",
      },
    })
  })

  it("names the denied tool in the warning, not just the policy", async () => {
    const child = new FakeChild()
    const warnings: string[] = []
    attachAgent(child, {
      prompt: async (ctx) => {
        await askPermission(ctx, {
          toolCallId: "tc-graft",
          name: "mcp__graft__graft_repo_map",
          kind: "other",
          options: PERMISSION_OPTIONS,
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, {
      tools: ["Read"],
      onWarning: (message: string) => warnings.push(message),
    })

    // "denied by policy" alone leaves the user unable to tell which call died:
    // the only other trace is the bridge's anonymous "User refused" line.
    expect(warnings.join("\n")).toContain("mcp__graft__graft_repo_map")
  })

  it("matches the tool name case-insensitively", async () => {
    const child = new FakeChild()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, { name: "write", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { tools: ["Write"] })
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } })
  })

  it.each([
    ["read", "Read"],
    ["edit", "Write"],
    ["execute", "Bash"],
    ["search", "Glob"],
    ["fetch", "WebFetch"],
  ])("falls back to the kind %s when the request carries no name", async (kind, tool) => {
    const child = new FakeChild()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, { kind, options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { tools: [tool] })
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } })
  })

  it("rejects when neither the name nor the kind maps to an allowed tool", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        // No `name`, and `kind: "other"` has no Claude tool to fall back to.
        decision = await askPermission(ctx, { kind: "other", options: PERMISSION_OPTIONS })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { tools: ["Read", "Bash"], onEvent })
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } })
    expect(events.some((e) => e.type === "raw")).toBe(true)
  })

  it("prefers reject_once over durable rejection when both are offered", async () => {
    const child = new FakeChild()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, {
          name: "Write",
          options: [
            { optionId: "reject-once", name: "No", kind: "reject_once" },
            { optionId: "reject-always", name: "Never", kind: "reject_always" },
          ],
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { tools: ["Read"] })
    expect(decision).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } })
  })

  it("cancels when the options offer no matching direction, and tolerates an empty list", async () => {
    const child = new FakeChild()
    const decisions: unknown[] = []
    attachAgent(child, {
      prompt: async (ctx) => {
        // Approved tool, but the agent offered only a reject option.
        decisions.push(await askPermission(ctx, { name: "Read", options: REJECT_ONLY }))
        // Rejected tool with no options at all — must not throw.
        decisions.push(await askPermission(ctx, { name: "Write", options: [] }))
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { tools: ["Read"] })
    expect(decisions).toEqual([
      { outcome: { outcome: "cancelled" } },
      { outcome: { outcome: "cancelled" } },
    ])
  })

  it("cancels a permission request that belongs to another session", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    let decision: unknown
    attachAgent(child, {
      prompt: async (ctx) => {
        decision = await askPermission(ctx, {
          sessionId: "some-other-session",
          name: "Read",
          options: PERMISSION_OPTIONS,
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { tools: ["Read"], onEvent })
    expect(decision).toEqual({ outcome: { outcome: "cancelled" } })
    // A foreign request is not a rejection of this run's tool use.
    expect(events.some((e) => e.type === "raw")).toBe(false)
  })
})
