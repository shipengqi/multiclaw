import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  type AgentTask,
  imagePaths,
  type MultiClawConfig,
  runtimeRegistry,
} from "@multiclawcli/core"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { readClipboard } from "./clipboard"
import { loadJournal } from "./session"
import { latestSession } from "./sessions"
import { driveFrame } from "./test-helpers"

vi.mock("./clipboard", async (original) => ({
  ...(await original<typeof import("./clipboard")>()),
  readClipboard: vi.fn(),
}))
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64"
)
const RUNTIME = "tui-images"
let dir: string
let tasks: AgentTask[]
let config: MultiClawConfig
let hold = false
beforeAll(() => {
  runtimeRegistry.register({
    name: RUNTIME,
    describe: async () => ({
      name: RUNTIME,
      available: true,
      capabilities: {
        streaming: false,
        sessions: false,
        resume: false,
        permissions: false,
        models: false,
        images: true,
        usage: false,
        cost: false,
        sandbox: false,
      },
    }),
    execute: async (task) => {
      tasks.push(task)
      if (hold && !task.signal?.aborted)
        await new Promise<void>((resolve) => {
          task.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
      return { output: "done", exitCode: 0 }
    },
  })
})
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-images-"))
  tasks = []
  hold = false
  config = {
    name: "images",
    workDir: dir,
    agents: [
      { id: "a", name: "Agent", runtime: RUNTIME, systemPrompt: "", taskPrompt: "{{requirement}}" },
    ],
  }
  vi.mocked(readClipboard).mockResolvedValue({ image: PNG })
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("image paste", () => {
  it("shows attachments and sends an image-only message as native image bytes", async () => {
    const attached = await driveFrame(<App config={config} />, { keys: ["\x16"] })
    expect(attached).toContain("1 image attached")
    expect(attached).not.toContain("multiclaw-image")
    await driveFrame(<App config={config} />, { keys: ["\x16", "\r"], settleMs: 250 })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }])
    const file = imagePaths(tasks[0].prompt)[0]
    expect(fs.readFileSync(file)).toEqual(PNG)
  })
  it("removes an attachment without deleting the typed text", async () => {
    await driveFrame(<App config={config} />, {
      keys: ["hello", "\x16", "\x1b\x7f", "\r"],
      settleMs: 250,
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].prompt).toContain("hello")
    expect(tasks[0].images).toEqual([])
  })
  it("keeps queued image references and bytes across a deliberate shutdown", async () => {
    hold = true
    await driveFrame(<App config={config} />, {
      keys: ["first", "\r", "\x16", "\r", "\x04"],
      settleMs: 250,
    })
    const session = latestSession(dir)
    expect(session).toBeDefined()
    const journal = loadJournal(dir, session?.id ?? "")
    expect(journal?.queue).toHaveLength(1)
    const file = imagePaths(journal?.queue?.[0] ?? "")[0]
    expect(fs.readFileSync(file)).toEqual(PNG)
    hold = false
    await driveFrame(<App config={config} />, { keys: ["/continue", "\r"], settleMs: 250 })
    expect(tasks[tasks.length - 1]?.images).toEqual([
      { data: PNG.toString("base64"), mimeType: "image/png" },
    ])
  })
  it("preserves multiline text when Ctrl+V reads text from the clipboard", async () => {
    vi.mocked(readClipboard).mockResolvedValue({ text: "first\r\nsecond" })
    await driveFrame(<App config={config} />, { keys: ["\x16", "\r"], settleMs: 250 })
    expect(tasks[0].prompt).toContain("first\nsecond")
  })
  it("reports a clipboard failure without starting a turn", async () => {
    vi.mocked(readClipboard).mockRejectedValue(new Error("clipboard unavailable"))
    const frame = await driveFrame(<App config={config} />, { keys: ["\x16"] })
    expect(frame).toContain("paste failed: clipboard unavailable")
    expect(tasks).toEqual([])
  })
})
