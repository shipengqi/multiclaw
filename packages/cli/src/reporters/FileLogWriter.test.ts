import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { EventBus, MultiClawEvent } from "@multiclawcli/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FileLogWriter } from "./FileLogWriter"

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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn: () => boolean, timeout = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      if (fn()) return
    } catch {
      /* file may not be flushed yet — retry */
    }
    await delay(10)
  }
  throw new Error("waitFor timed out")
}

const outputEvent = (agentId: string, chunk: string) =>
  ({ type: "agent:output", payload: { agentId, chunk } }) as unknown as MultiClawEvent

const completeEvent = (payload: Record<string, unknown>) =>
  ({ type: "orchestration:complete", payload }) as unknown as MultiClawEvent

let logDir: string

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-logs-"))
})

afterEach(async () => {
  // Give any pending write-stream open/end a chance to settle before removing
  // the directory, otherwise the stream emits an unhandled ENOENT on open.
  await delay(50)
  fs.rmSync(logDir, { recursive: true, force: true })
})

describe("FileLogWriter", () => {
  it("writes agent output chunks to a per-agent log file", async () => {
    const bus = fakeBus()
    const writer = new FileLogWriter(logDir)
    writer.attach(bus as unknown as EventBus)

    bus.emit(outputEvent("alpha", "hello "))
    bus.emit(outputEvent("alpha", "world"))
    bus.emit(outputEvent("beta", "other"))

    const alphaLog = path.join(logDir, "alpha.log")
    await waitFor(
      () => fs.existsSync(alphaLog) && fs.readFileSync(alphaLog, "utf8") === "hello world"
    )
    expect(fs.readFileSync(alphaLog, "utf8")).toBe("hello world")

    const betaLog = path.join(logDir, "beta.log")
    await waitFor(() => fs.existsSync(betaLog) && fs.readFileSync(betaLog, "utf8") === "other")

    // Close the streams so the afterEach cleanup is race-free.
    bus.emit(completeEvent({}))
    await waitFor(() => fs.existsSync(path.join(logDir, "report.json")))
  })

  it("writes report.json and closes streams on orchestration:complete", async () => {
    const bus = fakeBus()
    const writer = new FileLogWriter(logDir)
    writer.attach(bus as unknown as EventBus)

    bus.emit(outputEvent("alpha", "data"))
    bus.emit(completeEvent({ success: true, totalDuration: 1234 }))

    const reportPath = path.join(logDir, "report.json")
    await waitFor(() => fs.existsSync(reportPath))
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toEqual({
      success: true,
      totalDuration: 1234,
    })
  })

  it("creates the log directory if it does not exist", () => {
    const nested = path.join(logDir, "deep", "nested")
    new FileLogWriter(nested)
    expect(fs.existsSync(nested)).toBe(true)
  })

  it("stops writing after detach", async () => {
    const bus = fakeBus()
    const writer = new FileLogWriter(logDir)
    const detach = writer.attach(bus as unknown as EventBus)

    detach()
    bus.emit(outputEvent("alpha", "ignored"))

    await delay(50)
    expect(fs.existsSync(path.join(logDir, "alpha.log"))).toBe(false)
  })
})
