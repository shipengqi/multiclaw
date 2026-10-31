import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import {
  type AgentOutput,
  type AgentTask,
  agents,
  type MultiClawConfig,
  type MultiClawEvent,
  type RuntimePromptOptions,
  type RuntimeSession,
  runtimeRegistry,
} from "@multiclawcli/core"
import { render } from "ink"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App, type AppProps } from "./App"
import { loadHistory } from "./history"
import { stripAnsi } from "./state"
import { driveFrame } from "./test-helpers"

const RUNTIME = "tui-live-session-regression"
const PLAN = '{"mode":"run","run":["architect"]}'
const ASK = '{"mode":"ask","message":"which database?"}'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface Handle {
  agentId: string
  session: RuntimeSession
  prompts: string[]
  close: ReturnType<typeof vi.fn<() => Promise<void>>>
}

let workDir: string
let config: MultiClawConfig
let handles: Handle[]
let execute: ReturnType<typeof vi.fn<(task: AgentTask) => Promise<AgentOutput>>>
let respond: (handle: Handle, text: string, options?: RuntimePromptOptions) => Promise<AgentOutput>
const mounted: Array<ReturnType<typeof render>> = []

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-app-sessions-"))
  config = {
    name: "session-team",
    workDir,
    leader: agents.leader({ runtime: RUNTIME }),
    agents: [agents.architect({ runtime: RUNTIME, taskPrompt: "{{requirement}}" })],
  }
  handles = []
  execute = vi.fn(async () => ({ output: "unexpected execute", exitCode: 0 }))
  respond = async (handle) => ({ output: handle.agentId === "leader" ? PLAN : "done", exitCode: 0 })
  runtimeRegistry.register({
    name: RUNTIME,
    describe: async () => ({
      name: RUNTIME,
      available: true,
      capabilities: {
        streaming: true,
        sessions: true,
        resume: true,
        permissions: false,
        tools: false,
        models: false,
        images: false,
        usage: false,
        cost: false,
        sandbox: false,
      },
    }),
    execute,
    async openSession(options) {
      let state: RuntimeSession["state"] = "idle"
      const handle: Handle = {
        agentId: options.agentId,
        prompts: [],
        close: vi.fn(async () => {
          state = "closed"
        }),
        session: {
          sessionId: `${options.agentId}-${handles.length}`,
          get state() {
            return state
          },
          capabilities: { continuation: true, supplement: false },
          async prompt(text, promptOptions) {
            if (state !== "idle") throw new Error("overlapping prompt")
            state = "running"
            handle.prompts.push(text)
            try {
              return {
                ...(await respond(handle, text, promptOptions)),
                sessionId: handle.session.sessionId,
              }
            } finally {
              if (state === "running") state = "idle"
            }
          },
          async cancelTurn() {},
          close: () => handle.close(),
        },
      }
      handles.push(handle)
      return handle.session
    },
  })
})

afterEach(async () => {
  for (const app of mounted.splice(0)) {
    app.unmount()
    await app.waitUntilExit()
  }
  await vi.waitFor(() =>
    expect(handles.every((handle) => handle.session.state === "closed")).toBe(true)
  )
  fs.rmSync(workDir, { recursive: true, force: true })
})

function completions(target = 1) {
  const ready = deferred()
  let count = 0
  const onTurnStart: AppProps["onTurnStart"] = (bus) => {
    bus.subscribe((event) => {
      if (event.type === "orchestration:complete" && ++count === target) ready.resolve()
    })
  }
  return { ready: ready.promise, onTurnStart, count: () => count }
}

async function mount(onTurnStart?: AppProps["onTurnStart"]) {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  let output = ""
  const stdout = {
    columns: 110,
    rows: 32,
    isTTY: true,
    write(chunk: unknown, callback?: () => void) {
      output += String(chunk)
      callback?.()
      return true
    },
    on() {
      return stdout
    },
    off() {
      return stdout
    },
    removeListener() {
      return stdout
    },
  }
  const app = render(<App config={config} onTurnStart={onTurnStart} />, {
    stdin,
    stdout: stdout as unknown as NodeJS.WritableStream,
    interactive: false,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  mounted.push(app)
  await app.waitUntilRenderFlush()
  let exited = false
  const exit = app.waitUntilExit().then(() => {
    exited = true
  })
  return {
    app,
    exit,
    exited: () => exited,
    output: () => stripAnsi(output),
    async send(...keys: string[]) {
      for (const key of keys) {
        stdin.write(key)
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    },
  }
}

describe("App · reusable live sessions", () => {
  it("reuses the leader handle after ask and preserves the raw answer in history", async () => {
    respond = async (handle) => ({
      output:
        handle.agentId === "leader"
          ? handle.prompts.length === 1
            ? ASK
            : '{"mode":"run","run":["architect"],"requirement":"Build a web app with Postgres"}'
          : "done",
      exitCode: 0,
    })
    const done = completions()
    await driveFrame(<App config={config} onTurnStart={done.onTurnStart} />, {
      keys: ["build a web app", "\r"],
      ready: done.ready,
      thenKeys: ["/answer Postgres", "\r"],
      settleMs: 300,
    })
    expect(handles.filter((handle) => handle.agentId === "leader")).toHaveLength(1)
    expect(handles[0].prompts).toHaveLength(2)
    expect(handles[0].prompts[1]).toContain("you asked: which database?")
    expect(handles[0].prompts[1]).toContain("Postgres")
    expect(handles.find((handle) => handle.agentId === "architect")?.prompts[0]).toContain(
      "Build a web app with Postgres"
    )
    // Completion precedes React's persistence effect and its atomic disk write,
    // so the answer turn being visible in memory is not the same as the history
    // having landed. Wait for the saved invariant rather than a fixed delay.
    await vi.waitFor(() => expect(loadHistory(workDir)[1]?.requirement).toBe("Postgres"))
    expect(execute).not.toHaveBeenCalled()
  })

  it("reuses leader and worker handles across two normal turns", async () => {
    const done = completions()
    await driveFrame(<App config={config} onTurnStart={done.onTurnStart} />, {
      keys: ["first task", "\r"],
      ready: done.ready,
      thenKeys: ["second task", "\r"],
      settleMs: 300,
    })
    expect(handles.map((handle) => handle.agentId)).toEqual(["leader", "architect"])
    expect(handles.map((handle) => handle.prompts.length)).toEqual([2, 2])
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(["success", "failed"] as const)(
    "carries the first worker execution %s into the next leader prompt",
    async (execution) => {
      config.agents[0].retries = 0
      respond = async (handle) => ({
        output: handle.agentId === "leader" ? PLAN : "worker result",
        exitCode: handle.agentId === "architect" && execution === "failed" ? 1 : 0,
      })
      const done = completions()
      await driveFrame(<App config={config} onTurnStart={done.onTurnStart} />, {
        keys: ["first task", "\r"],
        ready: done.ready,
        thenKeys: ["second task", "\r"],
        settleMs: 300,
      })
      const prompt = handles.find((handle) => handle.agentId === "leader")?.prompts[1]
      expect(prompt).toContain("1. user: first task")
      expect(prompt).toContain(`   execution: ${execution}\n`)
      expect(prompt).toContain(`   completed: ${execution === "success" ? "architect" : "none"}\n`)
      expect(prompt).toContain(`   failed: ${execution === "failed" ? "architect" : "none"}`)
      expect(prompt).toContain("   acceptance: not configured\n")
      expect(prompt).not.toContain("   completed: leader")
    }
  )

  it("carries successful fallback workers instead of the failed leader into the next prompt", async () => {
    if (!config.leader) throw new Error("test config requires a leader")
    config.leader.retries = 0
    respond = async (handle) => ({
      output: handle.agentId === "leader" ? PLAN : "done",
      exitCode: handle.agentId === "leader" && handle.prompts.length === 1 ? 1 : 0,
    })
    const done = completions()
    await driveFrame(<App config={config} onTurnStart={done.onTurnStart} />, {
      keys: ["first task", "\r"],
      ready: done.ready,
      thenKeys: ["second task", "\r"],
      settleMs: 300,
    })
    const prompt = handles.find((handle) => handle.agentId === "leader")?.prompts[1]
    expect(prompt).toContain("   execution: success\n")
    expect(prompt).toContain("   completed: architect\n")
    expect(prompt).toContain("   failed: none\n")
  })

  it.each(["changes_required", "failed"] as const)(
    "carries acceptance %s separately from successful workers into the next leader prompt",
    async (status) => {
      config.agents.push(agents.codeReviewer({ runtime: RUNTIME, retries: 0 }))
      config.review = { reviewer: "code-reviewer", repairAgents: ["architect"], maxRepairRounds: 0 }
      respond = async (handle) => ({
        output:
          handle.agentId === "leader"
            ? PLAN
            : handle.agentId === "code-reviewer"
              ? '{"verdict":"changes_required","summary":"Checked","issues":["Fix validation"]}'
              : "done",
        exitCode: handle.agentId === "code-reviewer" && status === "failed" ? 1 : 0,
      })
      const done = completions()
      await driveFrame(<App config={config} onTurnStart={done.onTurnStart} />, {
        keys: ["first task", "\r"],
        ready: done.ready,
        thenKeys: ["second task", "\r"],
        settleMs: 300,
      })
      const prompt = handles.find((handle) => handle.agentId === "leader")?.prompts[1]
      expect(prompt).toContain("   execution: success\n")
      expect(prompt).toContain("   completed: architect\n")
      expect(prompt).toContain("   failed: none\n")
      expect(prompt).toContain(`   acceptance: ${status}`)
      expect(prompt).not.toContain("   failed: code-reviewer")
    }
  )

  it("rejects unsupported explicit tools before sessions and retains failed input with the queue paused", async () => {
    config.agents[0].tools = []
    const runtime = runtimeRegistry.get(RUNTIME)
    const describe = runtime.describe
    if (!describe) throw new Error("test runtime must report capabilities")
    const gate = deferred()
    vi.spyOn(runtime, "describe").mockImplementation(async (...args) => {
      await gate.promise
      return describe.apply(runtime, args)
    })
    const events: MultiClawEvent[] = []
    const openSession = vi.spyOn(runtime, "openSession")
    const done = completions()
    const tui = await mount((bus, logDir) => {
      bus.subscribe((event) => events.push(event))
      done.onTurnStart(bus, logDir)
    })
    await tui.send("restricted task", "\r", "retained follow-up", "\r")
    gate.resolve()
    await done.ready
    await vi.waitFor(() => {
      const history = loadHistory(workDir)
      expect(history).toHaveLength(1)
      expect(history[0].requirement).toBe("restricted task")
      expect(history[0].phase).toBe("complete")
      expect(history[0].success).toBe(false)
    })
    tui.app.unmount()
    await tui.exit
    expect(tui.output()).toContain("queue paused")
    expect(tui.output()).toContain("retained follow-up")
    expect(done.count()).toBe(1)
    expect(execute).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
    expect(handles).toHaveLength(0)
    const warning = events.find((event) => event.type === "orchestration:warning")
    expect(warning?.payload.message).toContain("architect")
    expect(warning?.payload.message).toContain("tools")
    expect(warning?.payload.message).toContain("explicit")
    expect(warning?.payload.message).toMatch(/remove|omit|support/i)
    expect(events.find((event) => event.type === "orchestration:complete")?.payload.success).toBe(
      false
    )
  })

  it("/task closes old handles and starts a fresh conversation", async () => {
    const first = completions()
    const second = completions(2)
    const tui = await mount((bus, logDir) => {
      first.onTurnStart(bus, logDir)
      second.onTurnStart(bus, logDir)
    })
    await tui.send("old task", "\r")
    await first.ready
    await tui.send("/task fresh task", "\r")
    await second.ready
    // Completion precedes React's persistence effect and its atomic disk write.
    // Wait for the saved invariant while mounted, not a fixed render delay.
    await vi.waitFor(() =>
      expect(loadHistory(workDir).map((turn) => turn.requirement)).toEqual([
        "old task",
        "fresh task",
      ])
    )
    await tui.send("/quit", "\r")
    await tui.exit
    expect(handles.map((handle) => handle.agentId)).toEqual([
      "leader",
      "architect",
      "leader",
      "architect",
    ])
    expect(handles[0].close).toHaveBeenCalledOnce()
    expect(handles[1].close).toHaveBeenCalledOnce()
    expect(handles[2].prompts[0]).toContain("fresh task")
    expect(handles[2].prompts[0]).not.toContain("old task")
    expect(loadHistory(workDir).map((turn) => turn.requirement)).toEqual(["old task", "fresh task"])
  })

  it("pauses prequeued input after ask instead of treating it as an answer", async () => {
    const gate = deferred()
    respond = async (handle) => {
      if (handle.agentId === "leader") {
        await gate.promise
        return { output: ASK, exitCode: 0 }
      }
      return { output: "done", exitCode: 0 }
    }
    const done = completions()
    const tui = await mount(done.onTurnStart)
    await tui.send("build a web app", "\r", "unrelated queued task", "\r")
    gate.resolve()
    await done.ready
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(done.count()).toBe(1)
    expect(handles).toHaveLength(1)
    expect(handles[0].prompts).toHaveLength(1)
    tui.app.unmount()
    await tui.exit
    expect(tui.output()).toContain("queue paused — answer the leader first")
    expect(tui.output()).toContain("unrelated queued task")
  })

  it("refuses /continue while the leader needs an answer", async () => {
    respond = async () => ({ output: ASK, exitCode: 0 })
    const done = completions()
    const frame = stripAnsi(
      await driveFrame(<App config={config} onTurnStart={done.onTurnStart} />, {
        keys: ["build a web app", "\r"],
        ready: done.ready,
        thenKeys: ["/continue", "\r"],
        settleMs: 150,
      })
    )
    expect(frame).toContain("answer the leader first; queued input is not an answer")
    expect(handles).toHaveLength(1)
    expect(handles[0].prompts).toHaveLength(1)
  })

  it("quit awaits closing idle sessions before exiting", async () => {
    const done = completions()
    const tui = await mount(done.onTurnStart)
    await tui.send("first task", "\r")
    await done.ready
    await vi.waitFor(() =>
      expect(handles.every((handle) => handle.session.state === "idle")).toBe(true)
    )
    const closeGate = deferred()
    for (const handle of handles) {
      const originalClose = handle.close.getMockImplementation()
      handle.close.mockImplementation(async () => {
        await closeGate.promise
        await originalClose?.()
      })
    }
    await tui.send("/quit", "\r")
    await vi.waitFor(() =>
      expect(handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true)
    )
    expect(tui.exited()).toBe(false)
    closeGate.resolve()
    await tui.exit
  })

  it("quit aborts an active turn and awaits its async reporter disposer before closing", async () => {
    const started = deferred()
    const reporterStarted = deferred()
    const reporterGate = deferred()
    const order: string[] = []
    respond = async (handle, _text, options) => {
      if (handle.agentId === "leader") return { output: PLAN, exitCode: 0 }
      started.resolve()
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener(
          "abort",
          () => {
            order.push("aborted")
            resolve()
          },
          { once: true }
        )
      )
      return { output: "partial", exitCode: 0, stopReason: "cancelled" }
    }
    const tui = await mount(() => async () => {
      order.push("reporter started")
      reporterStarted.resolve()
      await reporterGate.promise
      order.push("reporter finished")
    })
    await tui.send("first task", "\r")
    await started.promise
    await tui.send("/quit", "\r")
    await reporterStarted.promise
    expect(tui.exited()).toBe(false)
    expect(handles.every((handle) => handle.close.mock.calls.length === 0)).toBe(true)
    reporterGate.resolve()
    await tui.exit
    expect(order).toEqual(["aborted", "reporter started", "reporter finished"])
    expect(handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true)
  })
})
