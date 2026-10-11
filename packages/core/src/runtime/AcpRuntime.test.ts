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
const { AcpRuntime } = await import("./AcpRuntime")

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
  kill = vi.fn()
}

interface AgentHandlers {
  initialize?: () => unknown
  newSession?: () => unknown
  loadSession?: (params: unknown) => unknown
  prompt?: (ctx: AgentPromptContext) => unknown
  cancel?: (params: unknown) => void
}

interface AgentPromptContext {
  params: { sessionId: string }
  client: {
    notify: (method: string, params: unknown) => Promise<void>
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
    (() =>
      handlers.initialize?.() ?? {
        protocolVersion: acp.PROTOCOL_VERSION,
        // A fully-capable fake by default, so resume works out of the box;
        // the loadSession-gate test overrides this to advertise `false`.
        agentCapabilities: { loadSession: true },
      }) as never
  )
  app.onRequest("session/new", (() => handlers.newSession?.() ?? { sessionId: "sess-1" }) as never)
  app.onRequest(
    "session/load",
    ((ctx: { params: unknown }) => handlers.loadSession?.(ctx.params) ?? {}) as never
  )
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
})

describe("AcpRuntime.describe", () => {
  it("reports exactly the capabilities this adapter implements", async () => {
    const info = await new AcpRuntime().describe()
    expect(info).toMatchObject({
      name: "acp",
      capabilities: {
        streaming: true,
        sessions: true,
        resume: true,
        permissions: false,
        tools: true,
        models: false,
        images: false,
        usage: false,
        cost: false,
        sandbox: false,
      },
    })
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
    await promptStarted
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"))
    child.emit("close", null)

    await expect(p).rejects.toThrow("acp timed out (20ms)")
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
})
