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
