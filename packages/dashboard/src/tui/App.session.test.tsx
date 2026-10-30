import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  type AgentOutput,
  type AgentRuntime,
  AgentSessionManager,
  abortError,
  agents,
  type EventBus,
  type MultiClawConfig,
  type RuntimePromptOptions,
  type RuntimeSession,
  runtimeRegistry,
} from "@multiclawcli/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { stripAnsi } from "./state"
import { driveFrame } from "./test-helpers"

const { exit } = vi.hoisted(() => ({ exit: vi.fn() }))
vi.mock("ink", async (original) => ({
  ...(await original<typeof import("ink")>()),
  useApp: () => ({ exit }),
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const RUNTIME = "tui-persistent-session-regression"
const RUN = { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
const DONE = { output: "work finished", exitCode: 0 }

describe("App · caller-owned live sessions", () => {
  let workDir: string
  let sessions: AgentSessionManager
  let prompts: { agentId: string; text: string; options?: RuntimePromptOptions }[]
  let opened: string[]
  let closed: string[]
  let respond: (
    agentId: string,
    text: string,
    options?: RuntimePromptOptions
  ) => Promise<AgentOutput>
  let closeSession: (agentId: string) => Promise<void>

  beforeEach(() => {
    exit.mockReset()
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-live-tui-"))
    sessions = new AgentSessionManager()
    prompts = []
    opened = []
    closed = []
    respond = async (id) => (id === "leader" ? RUN : DONE)
    closeSession = async () => {}
    const runtime: AgentRuntime = {
      name: RUNTIME,
      async describe() {
        return {
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
        }
      },
      async execute() {
        throw new Error("live sessions must not use the one-shot runtime")
      },
      async openSession({ agentId }) {
        opened.push(agentId)
        let state: RuntimeSession["state"] = "idle"
        return {
          sessionId: `${agentId}-${opened.length}`,
          get state() {
            return state
          },
          capabilities: { continuation: true, supplement: false },
          async prompt(text, options) {
            expect(state).toBe("idle")
            state = "running"
            prompts.push({ agentId, text, options })
            try {
              return await respond(agentId, text, options)
            } finally {
              state = "idle"
            }
          },
          async cancelTurn() {},
          async close() {
            state = "closing"
            await closeSession(agentId)
            closed.push(agentId)
            state = "closed"
          },
        }
      },
    }
    runtimeRegistry.register(runtime)
  })

  afterEach(async () => {
    await sessions.close()
    vi.restoreAllMocks()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  function config(): MultiClawConfig {
    return {
      name: "live-session-team",
      workDir,
      leader: agents.leader({ runtime: RUNTIME }),
      agents: [agents.architect({ runtime: RUNTIME })],
    }
  }

  function turns(count: number) {
    const ready = deferred()
    let completed = 0
    const start = (bus: EventBus) => {
      bus.subscribe((event) => {
        if (event.type === "orchestration:complete" && ++completed === count) ready.resolve()
      })
    }
    return { ready: ready.promise, start, completed: () => completed }
  }

  it("shows rejected acceptance and /retry reruns the selected workers, not nothing failed", async () => {
    const tracker = turns(2)
    let reviews = 0
    respond = async (id) =>
      id === "code-reviewer"
        ? {
            output: JSON.stringify({
              verdict: ++reviews === 1 ? "changes_required" : "approved",
              summary: "Checked",
              issues: reviews === 1 ? ["Fix validation"] : [],
            }),
            exitCode: 0,
          }
        : id === "leader"
          ? RUN
          : DONE
    const reviewed: MultiClawConfig = {
      ...config(),
      agents: [...config().agents, agents.codeReviewer({ runtime: RUNTIME })],
      review: { reviewer: "code-reviewer", repairAgents: ["architect"], maxRepairRounds: 0 },
    }
    const frame = stripAnsi(
      await driveFrame(<App config={reviewed} sessions={sessions} onTurnStart={tracker.start} />, {
        keys: ["build API", "\r", "/retry", "\r"],
        ready: tracker.ready,
      })
    )
    expect(tracker.completed()).toBe(2)
    expect(prompts.map((p) => p.agentId)).toEqual([
      "leader",
      "architect",
      "code-reviewer",
      "architect",
      "code-reviewer",
    ])
    expect(frame).toContain("delivery approved")
    expect(frame).not.toContain("nothing failed")
  })

  it("renders changes required even when every agent process succeeded", async () => {
    const tracker = turns(1)
    respond = async (id) =>
      id === "code-reviewer"
        ? {
            output:
              '{"verdict":"changes_required","summary":"Checked","issues":["Fix validation"]}',
            exitCode: 0,
          }
        : id === "leader"
          ? RUN
          : DONE
    const reviewed: MultiClawConfig = {
      ...config(),
      agents: [...config().agents, agents.codeReviewer({ runtime: RUNTIME })],
      review: { reviewer: "code-reviewer", repairAgents: ["architect"], maxRepairRounds: 0 },
    }
    const frame = stripAnsi(
      await driveFrame(<App config={reviewed} sessions={sessions} onTurnStart={tracker.start} />, {
        keys: ["build API", "\r"],
        ready: tracker.ready,
      })
    )
    expect(frame).toContain("changes required")
    expect(frame).not.toContain("finished with failures")
  })

  it("opens each agent once across two turns and gives each prompt a fresh signal", async () => {
    const tracker = turns(2)
    const frame = stripAnsi(
      await driveFrame(<App config={config()} sessions={sessions} onTurnStart={tracker.start} />, {
        keys: ["first task", "\r", "follow up", "\r"],
        ready: tracker.ready,
      })
    )
    expect(tracker.completed()).toBe(2)
    expect(opened).toEqual(["leader", "architect"])
    expect(prompts.map(({ agentId }) => agentId)).toEqual([
      "leader",
      "architect",
      "leader",
      "architect",
    ])
    expect(prompts[0].options?.signal).not.toBe(prompts[2].options?.signal)
    expect(prompts[2].text).toContain("first task")
    expect(frame).toContain("turn 2")
  })

  it("/task closes previous sessions and excludes the old conversation", async () => {
    const tracker = turns(1)
    const logDirs: string[] = []
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-10-30T12:00:00.000Z")
    await driveFrame(
      <App
        config={config()}
        sessions={sessions}
        onTurnStart={(bus, logDir) => {
          logDirs.push(logDir)
          tracker.start(bus)
        }}
      />,
      {
        keys: ["old task", "\r"],
        ready: tracker.ready,
        thenKeys: ["/task unrelated fresh task", "\r"],
        settleMs: 200,
      }
    )
    expect(opened).toEqual(["leader", "architect", "leader", "architect"])
    expect(closed.slice(0, 2).sort()).toEqual(["architect", "leader"])
    expect(prompts[2].text).toContain("unrelated fresh task")
    expect(prompts[2].text).not.toContain("old task")
    expect(new Set(logDirs).size).toBe(2)
    expect(logDirs.every((dir) => dir.startsWith(path.join(workDir, ".multiclaw", "runs")))).toBe(
      true
    )
  })

  it("does not treat a pre-queued requirement as the answer to a later question", async () => {
    respond = async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
      return { output: '{"mode":"ask","message":"which database?"}', exitCode: 0 }
    }
    const tracker = turns(1)
    const frame = stripAnsi(
      await driveFrame(<App config={config()} sessions={sessions} onTurnStart={tracker.start} />, {
        keys: ["build a web app", "\r", "queued unrelated work", "\r"],
        ready: tracker.ready,
        thenKeys: ["/continue", "\r"],
      })
    )
    expect(tracker.completed()).toBe(1)
    expect(prompts).toHaveLength(1)
    expect(frame).toContain("queued unrelated work")
    expect(frame).toContain("answer the leader first")
    expect(frame).toContain("needs your input")
  })

  it("keeps queued text behind an ask checkpoint until a fresh answer arrives", async () => {
    let leaderRuns = 0
    respond = async (id) => {
      if (id !== "leader") return DONE
      if (++leaderRuns === 1) {
        await new Promise((resolve) => setTimeout(resolve, 220))
        return { output: '{"mode":"ask","message":"which database?"}', exitCode: 0 }
      }
      return RUN
    }
    const tracker = turns(1)
    const frame = stripAnsi(
      await driveFrame(<App config={config()} sessions={sessions} onTurnStart={tracker.start} />, {
        keys: ["build a web app", "\r", "queued unrelated work", "\r"],
        ready: tracker.ready,
        thenKeys: ["/continue", "\r", "/answer Postgres", "\r"],
        settleMs: 220,
      })
    )
    expect(leaderRuns).toBe(2)
    expect(prompts[1].text).toContain("Postgres")
    expect(prompts[1].text).toContain("build a web app")
    expect(prompts[1].text).toContain("you asked: which database?")
    expect(prompts[1].text).not.toContain("queued unrelated work")
    expect(frame).toContain("queued unrelated work")
    expect(frame).toContain("paused")
  })

  it("retains the queued follow-up without starting it after a failed turn", async () => {
    respond = async (id) => {
      if (id === "leader") return RUN
      await new Promise((resolve) => setTimeout(resolve, 220))
      throw new Error("work failed")
    }
    const tracker = turns(1)
    const frame = stripAnsi(
      await driveFrame(<App config={config()} sessions={sessions} onTurnStart={tracker.start} />, {
        keys: ["first task", "\r", "retained follow up", "\r"],
        ready: tracker.ready,
      })
    )
    expect(tracker.completed()).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(frame).toContain("retained follow up")
    expect(frame).toContain("queue paused")
    expect(frame).toContain("finished with failures")
  })

  it("pauses the queue after failure and /continue runs the retained follow-up", async () => {
    let attempts = 0
    respond = async (id) => {
      if (id === "leader") return RUN
      if (++attempts === 1) {
        await new Promise((resolve) => setTimeout(resolve, 220))
        throw new Error("first attempt failed")
      }
      return DONE
    }
    const tracker = turns(1)
    let runsAtCheckpoint = 0
    const ready = tracker.ready.then(() => {
      runsAtCheckpoint = prompts.length
    })
    const frame = stripAnsi(
      await driveFrame(<App config={config()} sessions={sessions} onTurnStart={tracker.start} />, {
        keys: ["first task", "\r", "retained follow up", "\r"],
        ready,
        thenKeys: ["/continue", "\r"],
        settleMs: 220,
      })
    )
    expect(runsAtCheckpoint).toBe(2)
    expect(attempts).toBe(2)
    expect(prompts.map(({ agentId }) => agentId)).toEqual([
      "leader",
      "architect",
      "leader",
      "architect",
    ])
    expect(prompts[2].text).toContain("retained follow up")
    expect(frame).toContain("turn 2")
    expect(frame).toContain("done")
  })

  it("/pause leaves the active turn running and retains queued input", async () => {
    let activeSignal: AbortSignal | undefined
    respond = async (id, _text, options) => {
      if (id === "leader") return RUN
      activeSignal = options?.signal
      await new Promise((resolve) => setTimeout(resolve, 280))
      expect(activeSignal?.aborted).toBe(false)
      return DONE
    }
    const tracker = turns(1)
    const frame = stripAnsi(
      await driveFrame(<App config={config()} sessions={sessions} onTurnStart={tracker.start} />, {
        keys: ["first task", "\r", "queued follow up", "\r", "/pause", "\r"],
        ready: tracker.ready,
      })
    )
    expect(tracker.completed()).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(frame).toContain("queued follow up")
    expect(frame).toContain("paused")
    expect(frame).toContain("done")
  })

  it("/quit does not claim successful cleanup after a reporter disposer rejects", async () => {
    const disposed = deferred()
    const frame = stripAnsi(
      await driveFrame(
        <App
          config={config()}
          sessions={sessions}
          onTurnStart={() => async () => {
            disposed.resolve()
            throw new Error("reporter drain failed")
          }}
        />,
        {
          keys: ["first task", "\r"],
          ready: disposed.promise,
          thenKeys: ["/quit", "\r"],
        }
      )
    )
    expect(exit).not.toHaveBeenCalled()
    expect(closed.sort()).toEqual(["architect", "leader"])
    expect(frame).toContain("shutdown failed: reporter drain failed")
  })

  it("/quit waits for cancellation, reporter disposal and delayed session close before exit", async () => {
    const cancellationStarted = deferred()
    const cancellationFinished = deferred()
    const disposalStarted = deferred()
    const disposalFinished = deferred()
    const closingStarted = deferred()
    const closingFinished = deferred()
    const shutdownFinished = deferred()
    const order: string[] = []
    respond = async (id, _text, options) => {
      if (id === "leader") return RUN
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            order.push("cancel requested")
            cancellationStarted.resolve()
            resolve()
          },
          { once: true }
        )
      })
      await cancellationFinished.promise
      order.push("cancel settled")
      throw abortError()
    }
    closeSession = async () => {
      expect(order).toContain("reporter disposed")
      closingStarted.resolve()
      await closingFinished.promise
      order.push("session closed")
    }
    exit.mockImplementation(() => {
      order.push("exit")
      shutdownFinished.resolve()
    })
    const release = (async () => {
      await cancellationStarted.promise
      expect(exit).not.toHaveBeenCalled()
      expect(closed).toEqual([])
      cancellationFinished.resolve()
      await disposalStarted.promise
      expect(exit).not.toHaveBeenCalled()
      expect(closed).toEqual([])
      disposalFinished.resolve()
      await closingStarted.promise
      expect(exit).not.toHaveBeenCalled()
      closingFinished.resolve()
      await shutdownFinished.promise
    })()
    await driveFrame(
      <App
        config={config()}
        sessions={sessions}
        onTurnStart={() => async () => {
          order.push("reporter disposal started")
          disposalStarted.resolve()
          await disposalFinished.promise
          order.push("reporter disposed")
        }}
      />,
      { keys: ["active work", "\r", "/quit", "\r"], ready: release, settleMs: 0 }
    )
    expect(exit).toHaveBeenCalledTimes(1)
    expect(order.slice(0, 4)).toEqual([
      "cancel requested",
      "cancel settled",
      "reporter disposal started",
      "reporter disposed",
    ])
    expect(order[order.length - 1]).toBe("exit")
    expect(closed.sort()).toEqual(["architect", "leader"])
  })
})
