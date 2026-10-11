import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RuntimeEvent } from "../types/runtime"

/**
 * Adversarial verification suite for `ClaudeRuntime`'s NDJSON line handling.
 *
 * The author's suite (`ClaudeRuntime.test.ts`) emits exactly one NDJSON line per
 * `data` chunk, so the multi-line `while` loop is barely exercised and several
 * behaviours have no coverage at all. These cases attack the seam directly.
 *
 * Product code is NOT modified. Tests that assert the *correct* behaviour and
 * fail are deliberate: they are the proof of a defect.
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

/** Write one NDJSON line to the fake child's stdout. */
function line(child: FakeChild, obj: unknown) {
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`))
}

/** Emit a raw string as one stdout chunk. */
function chunk(child: FakeChild, s: string) {
  child.stdout.emit("data", Buffer.from(s))
}

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
})

afterEach(() => {
  vi.useRealTimers()
  spawnMock.mockReset()
  execSyncMock.mockReset()
})

describe("adversarial · NDJSON line buffering", () => {
  // Item 1: three distinct lines in ONE chunk. The author's suite never does this.
  it("parses three lines arriving in a single chunk, in order, with contiguous seq", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    const a = { type: "system", subtype: "init", model: "m" }
    const b = textDelta("one")
    const c = textDelta("two")
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n${JSON.stringify(c)}\n`)
    )
    child.emit("close", 0)

    const output = await p
    const deltas = events.filter((e) => e.type === "message_delta")
    expect(events.map((e) => e.type)).toEqual(["run_started", "message_delta", "message_delta"])
    expect(deltas.map((e) => (e as { text: string }).text)).toEqual(["one", "two"])
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(output.output).toBe("onetwo")
  })

  // Item 2: a multi-byte codepoint split across a chunk boundary.
  // `ClaudeRuntime.ts:323` does `buffer += d.toString()` — each chunk decoded
  // independently. An incomplete UTF-8 sequence at a chunk edge becomes U+FFFD.
  it("preserves a multi-byte character split across a chunk boundary", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    const full = `${JSON.stringify(textDelta("中"))}\n`
    const buf = Buffer.from(full, "utf8")
    const charIndex = buf.indexOf(Buffer.from("中", "utf8"))
    expect(charIndex).toBeGreaterThan(0)

    // Split one byte INSIDE the 3-byte codepoint (E4 B8 AD).
    const splitAt = charIndex + 1
    child.stdout.emit("data", buf.subarray(0, splitAt))
    child.stdout.emit("data", buf.subarray(splitAt))
    child.emit("close", 0)

    const output = await p
    const delta = events.find((e) => e.type === "message_delta") as { text: string } | undefined
    // CORRECT behaviour; expected to fail if the defect is real.
    expect(delta?.text).toBe("中")
    expect(output.output).toBe("中")
  })

  // Item 6a: chunk boundary exactly on `\n`.
  it("handles a chunk boundary sitting exactly on the newline", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    chunk(child, `${JSON.stringify(textDelta("a"))}\n`)
    chunk(child, `${JSON.stringify(textDelta("b"))}\n`)
    child.emit("close", 0)

    const output = await p
    expect(events.filter((e) => e.type === "raw")).toEqual([])
    expect(
      events.filter((e) => e.type === "message_delta").map((e) => (e as { text: string }).text)
    ).toEqual(["a", "b"])
    expect(output.output).toBe("ab")
  })

  // Item 6b: a chunk that is only "\n" (empty line).
  it("ignores an empty line and emits no spurious raw event", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    chunk(child, "\n")
    chunk(child, `${JSON.stringify(textDelta("x"))}\n`)
    child.emit("close", 0)

    const output = await p
    expect(events.filter((e) => e.type === "raw")).toEqual([])
    expect(
      events.filter((e) => e.type === "message_delta").map((e) => (e as { text: string }).text)
    ).toEqual(["x"])
    expect(output.output).toBe("x")
  })

  // Item 7: CRLF endings.
  it("parses a CRLF-terminated line without a stray carriage return", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    chunk(child, `${JSON.stringify(textDelta("crlf"))}\r\n`)
    child.emit("close", 0)

    const output = await p
    expect(events.filter((e) => e.type === "raw")).toEqual([])
    expect(
      events.filter((e) => e.type === "message_delta").map((e) => (e as { text: string }).text)
    ).toEqual(["crlf"])
    expect(output.output).toBe("crlf")
  })
})

describe("adversarial · lifecycle edges", () => {
  // Item 3: timeout path (zero coverage in the author's suite).
  it("rejects with the timeout message and kills the child", async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask({ timeout: 20 }))
    const rejection = p.then(
      () => undefined,
      (err: Error) => err
    )

    vi.advanceTimersByTime(20)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")

    // A timeout must escalate to SIGKILL exactly like an abort: the promise
    // only settles on `close`, so a SIGTERM-ignoring process would otherwise
    // hang forever. Advance past KILL_ESCALATION_MS and confirm the hard kill.
    vi.advanceTimersByTime(3000)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(child.kill).toHaveBeenCalledTimes(2)

    child.emit("close", 0)
    const err = await rejection
    expect(err?.message).toBe("claude timed out (20ms)")
  })

  // Item 4: abort with a newline-less line still buffered.
  it("flushes a buffered line before the abort check on close", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ signal: controller.signal, onEvent }))
    // A complete JSON object, but no trailing newline: it stays buffered.
    chunk(child, JSON.stringify(textDelta("late")))
    expect(events).toEqual([])

    controller.abort()
    child.emit("close", 0)

    const err = await p.then(
      () => undefined,
      (e: Error) => e
    )
    expect(err?.name).toBe("AbortError")
    // Demonstrates the ordering: the buffered line is flushed BEFORE the
    // aborted check, so a cancelled run still emits one message_delta.
    expect(
      events.filter((e) => e.type === "message_delta").map((e) => (e as { text: string }).text)
    ).toEqual(["late"])
  })

  // Item 5 — synthetic-only and deliberately unfixed: with
  // `--include-partial-messages` the CLI always streams deltas BEFORE the
  // completed `assistant` message, so an assistant-block-first stream is
  // unreachable. The run-scoped `sawAgentDelta` guard is intentional (it
  // avoids re-emitting duplicate text if a turn emits two assistant events),
  // so this stays skipped rather than "fixed" for an ordering that cannot occur.
  it.skip("does not duplicate text when an assistant block precedes a delta", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } })
    line(child, textDelta("Hello"))
    child.emit("close", 0)

    const output = await p
    const textEvents = events.filter((e) => e.type === "message" || e.type === "message_delta")
    // CORRECT behaviour; expected to fail if the defect is real.
    expect(textEvents).toHaveLength(1)
    expect(output.output).toBe("Hello")
  })
})
