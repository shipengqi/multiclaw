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

const taggedOutputEvent = (agentId: string, chunk: string, kind: "tool" | "tool-detail") =>
  ({ type: "agent:output", payload: { agentId, chunk, kind } }) as unknown as MultiClawEvent

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

  // The log file is the agent's prose, exactly as before `kind` existed: tool
  // activity is a live-view affordance, and writing it here would change every
  // existing log file's contents.
  it("keeps tagged tool activity out of the log files", async () => {
    const bus = fakeBus()
    const writer = new FileLogWriter(logDir)
    writer.attach(bus as unknown as EventBus)

    bus.emit(outputEvent("alpha", "prose"))
    bus.emit(taggedOutputEvent("alpha", "  ✓ detail\n", "tool-detail"))
    bus.emit(taggedOutputEvent("alpha", "\n› Bash\n", "tool"))
    bus.emit(outputEvent("alpha", " more"))

    const alphaLog = path.join(logDir, "alpha.log")
    await waitFor(
      () => fs.existsSync(alphaLog) && fs.readFileSync(alphaLog, "utf8") === "prose more"
    )
    expect(fs.readFileSync(alphaLog, "utf8")).toBe("prose more")

    bus.emit(completeEvent({}))
    await waitFor(() => fs.existsSync(path.join(logDir, "report.json")))
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

  // Regression: `stream.end()` only *starts* the flush. The old `run` command
  // called `process.exit()` on the next statement, so the tail of the last
  // agent's log could be lost.
  it("drain() waits until the streams have flushed", async () => {
    const bus = fakeBus()
    const writer = new FileLogWriter(logDir)
    writer.attach(bus as unknown as EventBus)

    bus.emit(outputEvent("alpha", "tail-of-the-log"))
    bus.emit(completeEvent({ success: true }))

    await writer.drain()
    expect(fs.readFileSync(path.join(logDir, "alpha.log"), "utf8")).toBe("tail-of-the-log")
  })

  it("reports a stream failure instead of letting it kill the process", async () => {
    const messages: string[] = []
    const doomed = path.join(logDir, "doomed")
    const writer = new FileLogWriter(doomed, (m) => messages.push(m))
    const bus = fakeBus()
    writer.attach(bus as unknown as EventBus)

    // Take the directory away behind the writer's back: opening the log now
    // fails asynchronously, which — without an 'error' handler — is an
    // unhandled error event that terminates the process.
    fs.rmSync(doomed, { recursive: true, force: true })
    bus.emit(outputEvent("alpha", "x"))

    await waitFor(() => messages.length > 0)
    expect(messages[0]).toContain("alpha.log")
  })
})
