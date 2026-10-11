import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RuntimeEvent } from "../types/runtime"

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
  // The prompt is written here rather than passed as an argument.
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

/** Capture every runtime event a run emits. */
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

const BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--allowedTools",
  "Read,Bash",
]

afterEach(() => {
  spawnMock.mockReset()
  execSyncMock.mockReset()
})

describe("ClaudeRuntime.describe", () => {
  it("reports the CLI version and exactly the capabilities the adapter implements", async () => {
    execSyncMock.mockReturnValue("1.0.0\n")

    expect(await new ClaudeRuntime().describe()).toEqual({
      name: "claude",
      version: "1.0.0",
      available: true,
      capabilities: {
        streaming: true,
        sessions: true,
        resume: true,
        permissions: false,
        tools: true,
        models: true,
        images: false,
        usage: true,
        cost: true,
        sandbox: false,
      },
    })
    expect(execSyncMock).toHaveBeenCalledWith("claude --version", { encoding: "utf8" })
  })

  it("reports unavailable — but keeps its capabilities — when the CLI is missing", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not found")
    })

    const info = await new ClaudeRuntime().describe()
    expect(info.available).toBe(false)
    expect(info.version).toBeUndefined()
    expect(info.capabilities.streaming).toBe(true)
  })
})

describe("ClaudeRuntime.execute", () => {
  it("spawns claude with the streaming args and writes the prompt to stdin", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask())
    // `detached` is what gives the child its own process group, so cancellation
    // can reach the subprocesses claude spawns itself.
    expect(spawnMock).toHaveBeenCalledWith("claude", BASE_ARGS, {
      cwd: "/tmp/work",
      env: process.env,
      detached: true,
    })
    // The prompt rides on stdin: a large inlined document would overflow argv.
    expect(child.stdin.end).toHaveBeenCalledWith("do it")

    child.emit("close", 0)
    await expect(p).resolves.toEqual({ output: "", exitCode: 0 })
  })

  it("appends --system-prompt, --model and --session-id when provided", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(
      makeTask({
        systemPrompt: "sys",
        model: "sonnet",
        sessionId: "11111111-2222-3333-4444-555555555555",
      })
    )
    expect(spawnMock.mock.calls[0][1]).toEqual([
      ...BASE_ARGS,
      "--system-prompt",
      "sys",
      "--model",
      "sonnet",
      "--session-id",
      "11111111-2222-3333-4444-555555555555",
    ])

    child.emit("close", 0)
    await p
  })

  it("maps the init line to run_started and remembers the session id", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, { type: "system", subtype: "init", session_id: "sess-1", model: "sonnet-4" })
    line(child, { type: "result", subtype: "success", result: "ok" })
    child.emit("close", 0)

    const output = await p
    expect(events.map((e) => e.type)).toEqual(["run_started", "usage", "cost", "run_finished"])
    expect(events[0]).toMatchObject({ type: "run_started", model: "sonnet-4", agentId: "a1" })
    expect(output.sessionId).toBe("sess-1")
  })

  it("carries a monotonic seq and a stable runId across a run", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, { type: "system", subtype: "init", model: "m" })
    line(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    })
    child.emit("close", 0)
    await p

    expect(events.map((e) => e.seq)).toEqual([0, 1])
    expect(new Set(events.map((e) => e.runId)).size).toBe(1)
  })

  it("maps text deltas to message_delta and thinking deltas to thought", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
    })
    line(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
    })
    line(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
    })
    child.emit("close", 0)

    await expect(p).resolves.toMatchObject({ output: "Hello world" })
    expect(events.filter((e) => e.type === "message_delta")).toEqual([
      expect.objectContaining({ role: "agent", text: "Hello " }),
      expect.objectContaining({ role: "thought", text: "hmm" }),
      expect.objectContaining({ role: "agent", text: "world" }),
    ])
  })

  it("drops the duplicate assistant text block once a delta has been seen (text exactly once)", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
    })
    // The completed message repeats the text *and* carries a tool call.
    line(child, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    })
    child.emit("close", 0)

    const output = await p
    // Exactly once: the delta streamed it, so no `message` event repeats it.
    expect(events.filter((e) => e.type === "message")).toEqual([])
    expect(events.filter((e) => e.type === "message_delta")).toEqual([
      expect.objectContaining({ role: "agent", text: "Hello" }),
    ])
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      id: "t1",
      name: "Bash",
      input: { cmd: "ls" },
    })
    expect(output.output).toBe("Hello")
  })

  it("emits message from the assistant block when no delta ever arrives", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, { type: "assistant", message: { content: [{ type: "text", text: "Hi there" }] } })
    child.emit("close", 0)

    const output = await p
    expect(events.filter((e) => e.type === "message")).toEqual([
      expect.objectContaining({ role: "agent", text: "Hi there" }),
    ])
    expect(events.filter((e) => e.type === "message_delta")).toEqual([])
    expect(output.output).toBe("Hi there")
  })

  it("maps tool_result blocks, stringifying non-string content", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
      },
    })
    line(child, {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: [{ type: "text", text: "x" }],
            is_error: true,
          },
        ],
      },
    })
    child.emit("close", 0)
    await p

    expect(events.filter((e) => e.type === "tool_result")).toEqual([
      {
        runId: expect.any(String),
        agentId: "a1",
        seq: 0,
        type: "tool_result",
        id: "t1",
        output: "file contents",
        isError: false,
      },
      {
        runId: expect.any(String),
        agentId: "a1",
        seq: 1,
        type: "tool_result",
        id: "t2",
        output: JSON.stringify([{ type: "text", text: "x" }]),
        isError: true,
      },
    ])
  })

  it("maps the result line to usage, cost, session id and run_finished", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, {
      type: "result",
      subtype: "success",
      session_id: "sess-9",
      usage: { input_tokens: 10, output_tokens: 20 },
      total_cost_usd: 0.0123,
      result: "all done",
    })
    child.emit("close", 0)

    const output = await p
    expect(events.filter((e) => e.type === "usage")).toEqual([
      expect.objectContaining({ inputTokens: 10, outputTokens: 20 }),
    ])
    expect(events.filter((e) => e.type === "cost")).toEqual([
      expect.objectContaining({ costUsd: 0.0123 }),
    ])
    expect(events.find((e) => e.type === "run_finished")).toMatchObject({ stopReason: "success" })
    expect(output).toMatchObject({
      output: "all done",
      sessionId: "sess-9",
      usage: { inputTokens: 10, outputTokens: 20 },
      costUsd: 0.0123,
      stopReason: "success",
    })
  })

  it("maps a max-turns subtype to stopReason max_turns", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, { type: "result", subtype: "error_max_turns", result: "cut short" })
    child.emit("close", 0)

    const output = await p
    expect(events.find((e) => e.type === "run_finished")).toMatchObject({ stopReason: "max_turns" })
    expect(output.stopReason).toBe("max_turns")
  })

  it("falls back to the result string when the stream carried no text", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask())
    line(child, { type: "result", subtype: "success", result: "fallback text" })
    child.emit("close", 0)

    await expect(p).resolves.toMatchObject({ output: "fallback text" })
  })

  it("buffers a partial line across chunks and only parses complete lines", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    const full = `${JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
    })}\n`
    // Split mid-JSON: neither half is a complete line on its own.
    child.stdout.emit("data", Buffer.from(full.slice(0, 30)))
    expect(events).toEqual([])
    child.stdout.emit("data", Buffer.from(full.slice(30)))
    child.emit("close", 0)

    const output = await p
    expect(events.filter((e) => e.type === "message_delta")).toEqual([
      expect.objectContaining({ role: "agent", text: "partial" }),
    ])
    expect(events.filter((e) => e.type === "raw")).toEqual([])
    expect(output.output).toBe("partial")
  })

  it("preserves a multi-byte codepoint split across a chunk boundary", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    const full = Buffer.from(
      `${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "中" } },
      })}\n`,
      "utf8"
    )
    const charIndex = full.indexOf(Buffer.from("中", "utf8"))
    expect(charIndex).toBeGreaterThan(0)

    // Split one byte inside the 3-byte codepoint (E4 B8 AD). A stateless
    // per-chunk decode turns both halves into U+FFFD; a StringDecoder carries
    // the incomplete sequence over to the next chunk.
    const splitAt = charIndex + 1
    child.stdout.emit("data", full.subarray(0, splitAt))
    child.stdout.emit("data", full.subarray(splitAt))
    child.emit("close", 0)

    const output = await p
    const delta = events.find((e) => e.type === "message_delta") as { text: string } | undefined
    expect(delta?.text).toBe("中")
    expect(delta?.text).not.toContain("\ufffd")
    expect(output.output).toBe("中")
  })

  it("flushes a trailing newline-less line on close", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "tail" } },
        })
      )
    )
    child.emit("close", 0)

    await expect(p).resolves.toMatchObject({ output: "tail" })
    expect(events.filter((e) => e.type === "message_delta")).toHaveLength(1)
  })

  it("surfaces an unparseable line as raw instead of throwing", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    child.stdout.emit("data", Buffer.from("this is not json\n"))
    // A later valid line still parses.
    line(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "recovered" } },
    })
    child.emit("close", 0)

    const output = await p
    expect(events.find((e) => e.type === "raw")).toMatchObject({
      vendor: "claude",
      payload: "this is not json",
    })
    expect(output.output).toBe("recovered")
  })

  it("tolerates stdout that is not NDJSON at all", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    child.stdout.emit("data", Buffer.from("plain text output\nnot json either\n"))
    child.emit("close", 0)

    await expect(p).resolves.toMatchObject({ output: "" })
    expect(events.filter((e) => e.type === "raw")).toHaveLength(2)
  })

  it("surfaces an unrecognised JSON object as raw", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const { events, onEvent } = collect()

    const p = new ClaudeRuntime().execute(makeTask({ onEvent }))
    line(child, { type: "something_new", payload: 1 })
    child.emit("close", 0)
    await p

    expect(events.find((e) => e.type === "raw")).toMatchObject({
      vendor: "claude",
      payload: { type: "something_new", payload: 1 },
    })
  })

  it("rejects with the stderr output when the process exits non-zero", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask())
    child.stderr.emit("data", Buffer.from("boom"))
    child.emit("close", 1)

    await expect(p).rejects.toThrow("claude exited with code 1: boom")
  })

  it("kills the child on abort and rejects instead of leaving the promise pending", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()

    const p = new ClaudeRuntime().execute(makeTask({ signal: controller.signal }))
    controller.abort()
    expect(child.kill).toHaveBeenCalled()

    child.emit("close", 0)
    // Abort must settle the promise. Leaving it pending would hang the
    // orchestrator — and with it the TUI's cancel path — forever.
    const error = await p.then(
      () => undefined,
      (err: Error) => err
    )
    expect(error?.name).toBe("AbortError")
  })

  it("rejects when the process fails to start", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask())
    child.emit("error", new Error("ENOENT"))

    await expect(p).rejects.toThrow("Failed to start claude: ENOENT")
  })
})
