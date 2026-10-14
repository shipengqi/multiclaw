/**
 * C8: the ACP runtime classifies two setup failures as permanent, so the retry
 * loop in `AgentRunner` does not burn its backoff budget on a run that cannot
 * succeed. Everything else stays retryable.
 */
import { EventEmitter } from "node:events"
import { PassThrough, Readable, Writable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isPermanent } from "../utils/errors"

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
  kill = vi.fn()
}

function attachAgent(child: FakeChild, initialize?: () => unknown): void {
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdout),
    Readable.toWeb(child.stdin) as unknown as ReadableStream<Uint8Array>
  )
  const app = acp.agent({ name: "fake-agent" })
  app.onRequest(
    "initialize",
    (() => initialize?.() ?? { protocolVersion: acp.PROTOCOL_VERSION }) as never
  )
  app.onRequest("session/new", (() => ({ sessionId: "sess-1" })) as never)
  app.onRequest("session/prompt", (() => ({ stopReason: "end_turn" })) as never)
  app.connect(stream)
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return { agentId: "a1", prompt: "do it", tools: [], workDir: "/tmp/work", ...overrides } as never
}

/** Run and capture the rejection, if any. */
async function rejectionOf(child: FakeChild, task: Record<string, unknown> = {}) {
  spawnMock.mockReturnValue(child)
  return new AcpRuntime().execute(makeTask(task)).then(
    () => undefined,
    (e: Error) => e
  )
}

afterEach(() => {
  spawnMock.mockReset()
})

describe("AcpRuntime · permanent failures (C8)", () => {
  it("classifies a failed spawn as permanent", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const promise = new AcpRuntime().execute(makeTask())
    // `execute` imports the SDK before spawning, so wait until the runtime has
    // actually spawned and attached its listener before emitting.
    await vi.waitFor(() => expect(child.listenerCount("error")).toBeGreaterThan(0), {
      timeout: 20_000,
    })
    child.emit("error", new Error("spawn opencode ENOENT"))

    const err = await promise.then(
      () => undefined,
      (e: Error) => e
    )
    expect(err?.message).toBe("Failed to start opencode: spawn opencode ENOENT")
    expect(isPermanent(err)).toBe(true)
  })

  it("classifies an unsupported session/load as permanent", async () => {
    const child = new FakeChild()
    // No `loadSession` capability, so a resume cannot be honoured.
    attachAgent(child, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    }))

    const err = await rejectionOf(child, { sessionId: "sess-1" })
    expect(err?.message).toContain("does not support session/load")
    expect(isPermanent(err)).toBe(true)
  })

  it("leaves a plain non-zero exit retryable", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const promise = new AcpRuntime().execute(makeTask())
    await vi.waitFor(() => expect(child.listenerCount("close")).toBeGreaterThan(0), {
      timeout: 20_000,
    })
    child.emit("close", 1)

    const err = await promise.then(
      () => undefined,
      (e: Error) => e
    )
    expect(err?.message).toContain("exited with code 1")
    expect(isPermanent(err)).toBe(false)
  })
})
