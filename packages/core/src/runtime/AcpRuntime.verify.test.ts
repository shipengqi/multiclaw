/**
 * Independent verification suite (acp-verifier) for commit 4b3e432.
 *
 * Kept in its own file so the author's `AcpRuntime.test.ts` stays untouched.
 * These tests deliberately attack the claims the author made rather than
 * re-running their suite:
 *   - item 2: mapping fidelity against the *real* SDK schema (edge fields the
 *     author's tests never exercise: `content` fallback, `name: null`, every
 *     tool status);
 *   - item 3: the `raw` escape hatch is narrower than the mapping comment
 *     suggests — a schema-invalid variant is dropped before the adapter sees
 *     it, so it is silently lost;
 *   - item 4: the process-group kill fallback (`process.kill(-pid)`), which the
 *     author reported as uncovered.
 */
import { EventEmitter } from "node:events"
import { PassThrough, Readable, Writable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RuntimeEvent } from "../types/runtime"

const spawnMock = vi.fn()
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

const acp = await import("@agentclientprotocol/sdk")
const { AcpRuntime } = await import("./AcpRuntime")

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new EventEmitter()
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit("close", 0))
    return true
  })
}

interface AgentPromptContext {
  params: { sessionId: string }
  client: { notify: (method: string, params: unknown) => Promise<void> }
}

function attachAgent(
  child: FakeChild,
  handlers: {
    initialize?: () => unknown
    newSession?: () => unknown
    prompt?: (ctx: AgentPromptContext) => unknown
    cancel?: (params: unknown) => void
  }
): void {
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdout),
    Readable.toWeb(child.stdin) as unknown as ReadableStream<Uint8Array>
  )
  const app = acp.agent({ name: "fake-agent" })
  app.onRequest(
    "initialize",
    (() => handlers.initialize?.() ?? { protocolVersion: acp.PROTOCOL_VERSION }) as never
  )
  app.onRequest("session/new", (() => handlers.newSession?.() ?? { sessionId: "sess-1" }) as never)
  app.onRequest(
    "session/prompt",
    ((ctx: unknown) =>
      handlers.prompt?.(ctx as AgentPromptContext) ?? { stopReason: "end_turn" }) as never
  )
  app.onNotification("session/cancel", ((ctx: { params: unknown }) => {
    handlers.cancel?.(ctx.params)
  }) as never)
  app.connect(stream)
}

function notifyUpdate(ctx: AgentPromptContext, update: unknown): Promise<void> {
  return ctx.client.notify(acp.methods.client.session.update, {
    sessionId: ctx.params.sessionId,
    update,
  })
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return { agentId: "a1", prompt: "do it", tools: [], workDir: "/tmp/work", ...overrides } as never
}

function collect() {
  const events: RuntimeEvent[] = []
  return { events, onEvent: (e: RuntimeEvent) => void events.push(e) }
}

function runWith(child: FakeChild, task: Record<string, unknown> = {}) {
  spawnMock.mockReturnValue(child)
  return new AcpRuntime().execute(makeTask(task))
}

afterEach(() => {
  spawnMock.mockReset()
})

// ── item 2 + item 3: schema fidelity and the raw escape hatch ───────────────

describe("AcpRuntime · schema fidelity (verification)", () => {
  it("maps tool_call_update.content (no rawOutput) to a tool_result", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          // `rawOutput` absent: the adapter's `?? update.content` fallback must fire.
          content: [{ type: "content", content: { type: "text", text: "from-content" } }],
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })
    const result = events.find((e) => e.type === "tool_result")
    expect(result).toMatchObject({ id: "c1", isError: false })
    // content is an array -> JSON stringified; just prove it is non-empty.
    expect((result as { output: string }).output.length).toBeGreaterThan(0)
  })

  it("treats name:null on a tool_call as absent and falls back to title", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call",
          toolCallId: "c2",
          title: "Fallback title",
          name: null,
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      id: "c2",
      name: "Fallback title",
    })
  })

  it("replays arguments that arrive after the tool_call as a refinement", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        // The bridge announces the call with `{}` and sends the input later.
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call",
          toolCallId: "c5",
          name: "Read",
          title: "Read src/App.tsx",
          rawInput: {},
        })
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call_update",
          toolCallId: "c5",
          rawInput: { file_path: "src/App.tsx" },
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })

    const calls = events.filter((e) => e.type === "tool_call")
    expect(calls).toHaveLength(2)
    // Same id: a consumer prints one row, not two.
    expect(calls[1]).toMatchObject({
      id: "c5",
      name: "Read",
      input: { file_path: "src/App.tsx" },
    })
  })

  it("replays the arguments once, not on every later progress update", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call",
          toolCallId: "c6",
          name: "Bash",
          title: "Bash pnpm test",
          rawInput: {},
        })
        for (const status of ["in_progress", "completed"]) {
          await notifyUpdate(ctx, {
            sessionUpdate: "tool_call_update",
            toolCallId: "c6",
            status,
            rawInput: { command: "pnpm test" },
          })
        }
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })

    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(2)
  })

  it("adds no refinement when the tool_call already carried its arguments", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call",
          toolCallId: "c7",
          name: "Bash",
          title: "Bash ls",
          rawInput: { command: "ls" },
        })
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call_update",
          toolCallId: "c7",
          status: "completed",
          rawInput: { command: "ls" },
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })

    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(1)
  })

  it.each(["pending", "in_progress", "completed"])(
    "does not flag a %s tool_call_update as an error",
    async (status) => {
      const child = new FakeChild()
      const { events, onEvent } = collect()
      attachAgent(child, {
        prompt: async (ctx) => {
          await notifyUpdate(ctx, {
            sessionUpdate: "tool_call_update",
            toolCallId: "c3",
            status,
          })
          return { stopReason: "end_turn" }
        },
      })

      await runWith(child, { onEvent })
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: false })
    }
  )

  it("emits a tool_result for an in-progress update with no output at all", async () => {
    // Characterises a real semantic consequence of the mapping: EVERY
    // tool_call_update becomes a tool_result, including progress pings that
    // carry no result yet. This is the observed behaviour, recorded so a future
    // change is a deliberate one.
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "tool_call_update",
          toolCallId: "c4",
          status: "in_progress",
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      id: "c4",
      output: "",
      isError: false,
    })
  })

  it("maps usage_update to usage and cost events", async () => {
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, {
          sessionUpdate: "usage_update",
          used: 10,
          size: 100,
          cost: { amount: 0.005, currency: "USD" },
        })
        return { stopReason: "end_turn" }
      },
    })

    await runWith(child, { onEvent })
    expect(events.filter((e) => e.type === "usage")).toEqual([
      expect.objectContaining({ contextTokens: 10, contextSize: 100 }),
    ])
    expect(events.filter((e) => e.type === "cost")).toEqual([
      expect.objectContaining({ amount: 0.005, currency: "USD", costUsd: 0.005 }),
    ])
    // usage_update must NOT surface as raw now that it is mapped.
    expect(
      events.find(
        (e) =>
          e.type === "raw" &&
          (e.payload as Record<string, unknown>)?.sessionUpdate === "usage_update"
      )
    ).toBeUndefined()
  })

  it("DROPS a schema-INVALID variant before the adapter: no raw, run still succeeds", async () => {
    // The escape hatch is narrower than the mapping comment implies. The SDK's
    // `zSessionUpdate` is a CLOSED union (19 variants, no catch-all), so an
    // unknown discriminator fails validation and is discarded upstream. The
    // adapter's `default -> raw` branch is therefore unreachable for unknown
    // *variants*; it only ever sees schema-valid ones. Net effect: a future
    // agent update type is silently lost.
    const child = new FakeChild()
    const { events, onEvent } = collect()
    attachAgent(child, {
      prompt: async (ctx) => {
        await notifyUpdate(ctx, { sessionUpdate: "brand_new_thing", value: 1 })
        return { stopReason: "end_turn" }
      },
    })

    const output = await runWith(child, { onEvent })
    expect(events.some((e) => e.type === "raw")).toBe(false)
    expect(output.stopReason).toBe("success")
  })
})

// ── item 4: cancellation and the process-group kill fallback ────────────────

describe("AcpRuntime · cancellation (verification)", () => {
  it("SIGTERMs the process GROUP (process.kill(-pid)) on timeout when a pid exists", async () => {
    const child = new FakeChild()
    ;(child as { pid?: number }).pid = 424242
    attachAgent(child, { prompt: () => new Promise(() => {}) })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)

    const p = runWith(child, { timeout: 20 })
    const rejection = expect(p).rejects.toThrow("acp timed out (20ms)")
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalledWith(-424242, "SIGTERM"), {
      timeout: 5_000,
    })
    child.emit("close", null)
    await rejection
    killSpy.mockRestore()
  })

  it("falls back to child.kill when the process-group kill throws (ESRCH)", async () => {
    const child = new FakeChild()
    ;(child as { pid?: number }).pid = 424243
    attachAgent(child, { prompt: () => new Promise(() => {}) })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH")
    })

    const p = runWith(child, { timeout: 20 })
    const rejection = expect(p).rejects.toThrow("acp timed out (20ms)")
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"), { timeout: 5_000 })
    child.emit("close", null)
    await rejection
    killSpy.mockRestore()
  })

  it("abort sends session/cancel, then SIGTERMs the group if the agent ignores it", async () => {
    const child = new FakeChild()
    ;(child as { pid?: number }).pid = 424244
    let cancelled: unknown
    let started: () => void = () => {}
    const promptStarted = new Promise<void>((r) => {
      started = r
    })
    attachAgent(child, {
      // Never resolves: the agent ignores cancellation, forcing the grace timer.
      prompt: () => {
        started()
        return new Promise(() => {})
      },
      cancel: (params) => {
        cancelled = params
      },
    })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)

    const controller = new AbortController()
    const p = runWith(child, { signal: controller.signal })
    await promptStarted
    controller.abort()

    await vi.waitFor(() => expect(cancelled).toMatchObject({ sessionId: "sess-1" }), {
      timeout: 5_000,
    })
    // CANCEL_GRACE_MS is 2000ms; the group must be SIGTERM'd after it.
    await vi.waitFor(() => expect(killSpy).toHaveBeenCalledWith(-424244, "SIGTERM"), {
      timeout: 5_000,
    })

    child.emit("close", null)
    const err = await p.then(
      () => undefined,
      (e: Error) => e
    )
    expect(err?.name).toBe("AbortError")
    killSpy.mockRestore()
  })
})
