import type { EventBus, MultiClawEvent } from "@multiclawcli/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConsoleReporter } from "./ConsoleReporter"

function fakeBus() {
  const listeners = new Set<(e: MultiClawEvent) => void>()
  return {
    subscribe(fn: (e: MultiClawEvent) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emit(e: MultiClawEvent) {
      for (const l of listeners) l(e)
    },
  }
}

const event = (type: string, payload: Record<string, unknown>) =>
  ({ type, timestamp: "t", payload }) as unknown as MultiClawEvent

// Wrap each spy in a function so the variable type is the exact spy signature
// rather than the overly generic `ReturnType<typeof vi.spyOn>`.
function spyOnConsoleLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {})
}
function spyOnStdoutWrite() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true)
}

let logSpy: ReturnType<typeof spyOnConsoleLog>
let writeSpy: ReturnType<typeof spyOnStdoutWrite>

beforeEach(() => {
  logSpy = spyOnConsoleLog()
  writeSpy = spyOnStdoutWrite()
})

afterEach(() => {
  logSpy.mockRestore()
  writeSpy.mockRestore()
})

const out = () => logSpy.mock.calls.flat().join("\n")

function reporter() {
  const bus = fakeBus()
  new ConsoleReporter().attach(bus as unknown as EventBus)
  return bus
}

describe("ConsoleReporter", () => {
  it("renders the orchestration header", () => {
    reporter().emit(
      event("orchestration:start", { name: "dev-team", totalAgents: 3, stages: [[], []] })
    )
    expect(out()).toContain("dev-team")
    expect(out()).toContain("Agents: 3  Stages: 2")
  })

  it("announces a regrouped plan", () => {
    // The task plan is applied after the header was printed, so the stage count
    // it advertised is no longer the whole truth.
    reporter().emit(event("orchestration:stages", { totalAgents: 3, stages: [[], [], []] }))
    expect(out()).toContain("Plan applied — 3 stages")
  })

  it("renders stage and agent lifecycle events", () => {
    const bus = reporter()
    bus.emit(event("stage:start", { stageIndex: 0 }))
    bus.emit(event("agent:start", { agentName: "Leader" }))
    bus.emit(event("agent:complete", { agentName: "Leader", duration: 1500 }))
    bus.emit(event("agent:failed", { agentName: "Tester", error: "boom" }))
    bus.emit(event("agent:skipped", { agentName: "Deployer" }))
    bus.emit(
      event("agent:retrying", { agentName: "Dev", attempt: 2, maxAttempts: 3, error: "net" })
    )

    expect(out()).toContain("Stage 1")
    expect(out()).toContain("[Leader] starting...")
    expect(out()).toContain("Leader done (1.5s)")
    expect(out()).toContain("Tester failed: boom")
    expect(out()).toContain("Deployer skipped")
    expect(out()).toContain("Dev retry 2/3: net")
  })

  it("writes agent output chunks straight to stdout", () => {
    reporter().emit(event("agent:output", { agentId: "a", chunk: "hello" }))
    expect(writeSpy).toHaveBeenCalledWith("  hello")
  })

  // Headless stdout carries the agent's prose only. Tool activity is tagged, so
  // filtering it here keeps the byte stream identical to before `kind` existed.
  it("keeps tagged tool activity out of stdout", () => {
    const bus = reporter()
    bus.emit(event("agent:output", { agentId: "a", chunk: "prose" }))
    bus.emit(event("agent:output", { agentId: "a", chunk: "  ✓ detail\n", kind: "tool-detail" }))
    bus.emit(event("agent:output", { agentId: "a", chunk: "\n› Bash\n", kind: "tool" }))
    bus.emit(event("agent:output", { agentId: "a", chunk: "text", kind: "text" }))
    expect(writeSpy.mock.calls.map((call) => call[0])).toEqual(["  prose", "  text"])
  })

  it("prints a total cost only when the run reported one", () => {
    reporter().emit(
      event("orchestration:complete", {
        success: true,
        totalDuration: 3000,
        agentResults: [{ agentName: "Leader", status: "success", duration: 1000 }],
        totalCostUsd: 1.23,
      })
    )
    expect(out()).toContain("$1.23")
  })

  it("omits the cost column entirely when no cost was reported", () => {
    reporter().emit(
      event("orchestration:complete", {
        success: true,
        totalDuration: 3000,
        agentResults: [{ agentName: "Leader", status: "success", duration: 1000 }],
      })
    )
    // No "$0.00": a run nobody priced must not read as costing nothing.
    expect(out()).not.toContain("$")
  })

  it("words a cancelled agent as cancelled, not failed", () => {
    reporter().emit(
      event("agent:failed", {
        agentName: "Tester",
        status: "cancelled",
        error: "Operation aborted",
      })
    )
    expect(out()).toContain("Tester cancelled")
    expect(out()).not.toContain("Tester failed")
  })

  it("marks a cancelled agent's summary row apart from a failure", () => {
    reporter().emit(
      event("orchestration:complete", {
        success: false,
        totalDuration: 1000,
        agentResults: [{ agentName: "Tester", status: "cancelled", duration: 1000 }],
      })
    )
    expect(out()).toContain("- Tester")
    expect(out()).not.toContain("x Tester")
  })

  it("heads a cancelled run as cancelled rather than failed", () => {
    reporter().emit(
      event("orchestration:complete", {
        success: false,
        cancelled: true,
        totalDuration: 1000,
        agentResults: [],
      })
    )
    expect(out()).toContain("Cancelled")
    expect(out()).not.toContain("Done (with failures)")
  })

  it("summarises a successful orchestration", () => {
    reporter().emit(
      event("orchestration:complete", {
        success: true,
        totalDuration: 3000,
        agentResults: [
          { agentName: "Leader", status: "success", duration: 1000 },
          { agentName: "Developer", status: "success", duration: 2000 },
        ],
      })
    )
    expect(out()).toContain("All done")
    expect(out()).toContain("Leader")
    expect(out()).toContain("Developer")
    expect(out()).toContain("3.0s")
  })

  it("flags a failed orchestration", () => {
    reporter().emit(
      event("orchestration:complete", {
        success: false,
        totalDuration: 1000,
        agentResults: [{ agentName: "Tester", status: "failed", duration: 1000 }],
      })
    )
    expect(out()).toContain("Done (with failures)")
  })

  // A turn the leader answered ran no pipeline. Calling it "All done" would
  // claim work that never happened, and the empty agent table says nothing.
  it("prints the leader's answer instead of an empty summary", () => {
    reporter().emit(
      event("orchestration:complete", {
        success: true,
        totalDuration: 800,
        agentResults: [],
        reply: { mode: "reply", message: "Hi — ask me for a change." },
      })
    )
    expect(out()).toContain("Hi — ask me for a change.")
    expect(out()).toContain("Answered")
    expect(out()).not.toContain("All done")
  })

  it("asks for input when the leader needs a decision", () => {
    reporter().emit(
      event("orchestration:complete", {
        success: true,
        totalDuration: 800,
        agentResults: [],
        reply: { mode: "ask", message: "Which database?" },
      })
    )
    expect(out()).toContain("Which database?")
    expect(out()).toContain("Needs your input")
  })

  it("renders orchestration warnings", () => {
    reporter().emit(event("orchestration:warning", { message: "task-plan.json ignored" }))
    expect(out()).toContain("task-plan.json ignored")
  })

  it("stops reporting after detach", () => {
    const bus = fakeBus()
    const detach = new ConsoleReporter().attach(bus as unknown as EventBus)
    detach()
    bus.emit(event("agent:start", { agentName: "Nobody" }))
    expect(out()).not.toContain("Nobody")
  })
})
