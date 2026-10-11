import { EventEmitter } from "node:events"
import { StringDecoder } from "node:string_decoder"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RuntimeEvent } from "../types/runtime"

/**
 * Edge-case suite for `ClaudeRuntime.execute()`'s stream handling, complementing
 * `ClaudeRuntime.verify.test.ts` (which holds one case per behaviour).
 *
 * These cases go deeper on the paths where the defects actually lived:
 *   A. stateful `StringDecoder` across split codepoints + the close-time flush
 *   C. timeout/abort escalation side effects (no double-kill, no leaked timer)
 *   D. reachability of the assistant-before-delta ordering
 */

const spawnMock = vi.fn()
const execSyncMock = vi.fn()
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}))

const { ClaudeRuntime } = await import("./ClaudeRuntime")

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { on: vi.fn(), end: vi.fn() }
  kill = vi.fn()
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

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
})

/** One newline-terminated NDJSON line. */
const lineFor = (obj: unknown) => `${JSON.stringify(obj)}\n`

const deltaTexts = (events: RuntimeEvent[]) =>
  events.filter((e) => e.type === "message_delta").map((e) => (e as { text: string }).text)

/** Assert no event payload carries a UTF-8 replacement character. */
function expectNoReplacementChar(events: RuntimeEvent[]) {
  expect(JSON.stringify(events).includes("\uFFFD")).toBe(false)
}

afterEach(() => {
  vi.useRealTimers()
  spawnMock.mockReset()
  execSyncMock.mockReset()
})

describe("verify2 · A · stateful UTF-8 decode", () => {
  // A1 — 4-byte codepoint (🚀 U+1F680 = F0 9F 9A 80) split across two chunks.
  it("A1: 4-byte emoji split across two chunks survives intact", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    const buf = Buffer.from(lineFor(textDelta("🚀")), "utf8")
    const idx = buf.indexOf(Buffer.from("🚀", "utf8"))
    expect(idx).toBeGreaterThan(0)

    const splitAt = idx + 2 // middle of the 4-byte sequence
    child.stdout.emit("data", buf.subarray(0, splitAt))
    child.stdout.emit("data", buf.subarray(splitAt))
    child.emit("close", 0)

    const output = await p
    expect(deltaTexts(events)).toEqual(["🚀"])
    expect(output.output).toBe("🚀")
    expectNoReplacementChar(events)
  })

  // A2 — 3-byte codepoint ("中" = E4 B8 AD) split across THREE chunks, one byte each.
  it("A2: 3-byte char split one byte per chunk across three chunks", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    const buf = Buffer.from(lineFor(textDelta("中")), "utf8")
    const idx = buf.indexOf(Buffer.from("中", "utf8"))
    expect(idx).toBeGreaterThan(0)

    child.stdout.emit("data", buf.subarray(0, idx + 1)) // …first byte of 中
    child.stdout.emit("data", buf.subarray(idx + 1, idx + 2)) // …second byte only
    child.stdout.emit("data", buf.subarray(idx + 2)) // third byte + rest + newline
    child.emit("close", 0)

    const output = await p
    expect(deltaTexts(events)).toEqual(["中"])
    expect(output.output).toBe("中")
    expectNoReplacementChar(events)
  })

  // A3 — one chunk carries several complete lines AND starts a codepoint that
  // straddles its own end boundary.
  it("A3: multiple complete lines + a codepoint straddling the chunk end", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    const full = lineFor(textDelta("one")) + lineFor(textDelta("two")) + lineFor(textDelta("中"))
    const buf = Buffer.from(full, "utf8")
    const idx = buf.indexOf(Buffer.from("中", "utf8"))
    expect(idx).toBeGreaterThan(0)

    // First chunk ends after 2 of the 3 bytes of 中, so the earlier two lines
    // are complete but the CJK codepoint is not.
    child.stdout.emit("data", buf.subarray(0, idx + 2))
    child.stdout.emit("data", buf.subarray(idx + 2))
    child.emit("close", 0)

    const output = await p
    expect(deltaTexts(events)).toEqual(["one", "two", "中"])
    expect(output.output).toBe("onetwo中")
    expectNoReplacementChar(events)
  })

  // A4 — a complete JSON line with NO trailing newline is flushed on close.
  // The buffered line ends on a multi-byte codepoint, so this also proves
  // decoder.end() neither drops nor mangles the tail at the flush boundary.
  it("A4: complete multi-byte line with no newline flushed by decoder.end(), no U+FFFD", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    // Full object ending in "中", no newline → stays buffered, emits nothing yet.
    child.stdout.emit("data", Buffer.from(JSON.stringify(textDelta("中"))))
    expect(events).toEqual([])

    child.emit("close", 0)
    const output = await p
    expect(deltaTexts(events)).toEqual(["中"]) // emitted exactly once
    expect(output.output).toBe("中")
    expect(events.filter((e) => e.type === "raw")).toEqual([])
    expectNoReplacementChar(events)
  })

  // A5 — decoder plumbing: write() once per chunk, end() exactly once.
  it("A5: decoder.write per chunk, decoder.end exactly once (no double-emit)", async () => {
    const writeSpy = vi.spyOn(StringDecoder.prototype, "write")
    const endSpy = vi.spyOn(StringDecoder.prototype, "end")

    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    child.stdout.emit("data", Buffer.from(lineFor(textDelta("x"))))
    child.stdout.emit("data", Buffer.from(lineFor(textDelta("y"))))
    child.emit("close", 0)

    const output = await p
    // Scope to the runtime's own decoder instance: vitest's own machinery also
    // constructs StringDecoder instances, so a bare prototype count over-counts.
    const runtimeInstances = new Set(writeSpy.mock.instances)
    expect(writeSpy).toHaveBeenCalledTimes(2)
    const endCallsOnRuntimeDecoder = endSpy.mock.instances.filter((i) => runtimeInstances.has(i))
    expect(endCallsOnRuntimeDecoder).toHaveLength(1)
    expect(deltaTexts(events)).toEqual(["x", "y"])
    expect(output.output).toBe("xy")
  })
})

describe("verify2 · C · timeout/abort escalation side effects", () => {
  it("C1: timeout then abort → exactly one SIGTERM, one SIGKILL (no double-kill)", async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()

    const p = new ClaudeRuntime().execute(makeTask({ timeout: 20, signal: controller.signal }))
    const rejection = p.then(
      () => undefined,
      (err: Error) => err
    )

    vi.advanceTimersByTime(20)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")

    // A second cancellation must be a no-op thanks to the `stopped` guard.
    controller.abort()
    expect(child.kill).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(3000)
    expect(child.kill).toHaveBeenCalledTimes(2)
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL")

    child.emit("close", 0)
    const err = await rejection
    // The `stopped` guard is what we are proving (kill counts above). Note the
    // close handler checks `signal.aborted` before `timedOut`, so when a caller
    // aborts a run that already timed out, AbortError wins the rejection. That
    // ordering predates the fix and is unchanged by it.
    expect(err?.name).toBe("AbortError")
    expect(vi.getTimerCount()).toBe(0) // no leaked timer
  })

  it("C2: abort path unchanged — SIGTERM, then SIGKILL after grace, rejects AbortError", async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()

    const p = new ClaudeRuntime().execute(makeTask({ signal: controller.signal }))
    const rejection = p.then(
      () => undefined,
      (err: Error) => err
    )

    controller.abort()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")

    vi.advanceTimersByTime(3000)
    expect(child.kill).toHaveBeenCalledTimes(2)
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL")

    child.emit("close", 0)
    const err = await rejection
    expect(err?.name).toBe("AbortError")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("C3: clearTimers() cancels a pending escalation on normal close (no late SIGKILL)", async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask({ timeout: 20 }))
    const rejection = p.then(
      () => undefined,
      (err: Error) => err
    )

    vi.advanceTimersByTime(20) // timeout → SIGTERM + armed escalation
    expect(child.kill).toHaveBeenCalledTimes(1)

    child.emit("close", 0) // clears the escalation before it fires
    vi.advanceTimersByTime(10_000)
    expect(child.kill).toHaveBeenCalledTimes(1) // escalation was cleared
    expect(vi.getTimerCount()).toBe(0)

    const err = await rejection
    expect(err?.message).toBe("claude timed out (20ms)")
  })

  it("C4: a normal successful run leaves no timer and never kills", async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask())
    child.emit("close", 0)
    await p

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(100_000)
    expect(child.kill).not.toHaveBeenCalled()
  })
})

describe("verify2 · D · assistant-before-delta ordering reachability", () => {
  // D1 — the guarded duplicate is REAL when the synthetic ordering is forced.
  it("D1: assistant-before-delta duplicates text (documents the guarded behaviour)", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    child.stdout.emit(
      "data",
      Buffer.from(
        lineFor({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } })
      )
    )
    child.stdout.emit("data", Buffer.from(lineFor(textDelta("Hello"))))
    child.emit("close", 0)

    const output = await p
    const textEvents = events.filter((e) => e.type === "message" || e.type === "message_delta")
    expect(textEvents.map((e) => (e as { text: string }).text)).toEqual(["Hello", "Hello"])
    expect(output.output).toBe("HelloHello")
  })

  // D2 — the ordering the real CLI is documented to produce is handled correctly.
  it("D2: delta-before-assistant (documented ordering) does not duplicate", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    child.stdout.emit("data", Buffer.from(lineFor(textDelta("Hello"))))
    child.stdout.emit(
      "data",
      Buffer.from(
        lineFor({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } })
      )
    )
    child.emit("close", 0)

    const output = await p
    const textEvents = events.filter((e) => e.type === "message" || e.type === "message_delta")
    expect(textEvents.map((e) => (e as { text: string }).text)).toEqual(["Hello"])
    expect(output.output).toBe("Hello")
  })
})
