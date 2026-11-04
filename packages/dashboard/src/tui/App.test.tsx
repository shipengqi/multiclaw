import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { App } from "./App"
import { SessionRuntime } from "./chat-session"
import { displayWidth } from "./format"
import { createSession, sessionDir } from "./sessions"
import { createInitialState, stripAnsi } from "./state"
import { DEMO, driveFrame, renderFrame } from "./test-helpers"

const frame = (keys: string[] = [], columns = 145, rows = 30) =>
  driveFrame(<App config={DEMO} />, { keys, columns, rows, settleMs: 0 }).then(stripAnsi)
describe("chat-centered terminal UI", () => {
  it("starts blank with sessions on the left and team hidden", async () => {
    const output = stripAnsi(await renderFrame(<App config={DEMO} />, 145, 30))
    expect(output).toContain("Sessions")
    expect(output).toContain("Main chat")
    expect(output).toContain("message the coordinator…")
    expect(output).not.toContain("Leader")
    expect(output).not.toContain("Team ·")
  })
  it("preserves the brand colour, pane dividers and input boundary", async () => {
    const raw = await renderFrame(<App config={DEMO} />, 145, 30)
    const output = stripAnsi(raw)
    expect(raw).toContain(String.fromCharCode(27) + "[36m")
    expect(output).toContain("─".repeat(145))
    expect(output).toContain("│")
    const lines = output.trimEnd().split("\n")
    expect(lines).toHaveLength(30)
    expect(lines.every((line) => displayWidth(line) <= 145)).toBe(true)
    expect(lines.find((line) => line.includes("Main chat"))?.indexOf("Main chat")).toBe(25)
    expect(lines.find((line) => line.includes("message the coordinator"))?.indexOf("›")).toBe(25)
  })
  it("keeps both team separators and semantic colours in a populated chat", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "styled-chat-"))
    const config = { ...DEMO, workDir }
    const meta = createSession(workDir)
    const dir = sessionDir(workDir, meta.id)
    fs.mkdirSync(dir, { recursive: true })
    const view = createInitialState(config)
    view.agents.architect.status = "success"
    view.agents.dev.status = "failed"
    fs.writeFileSync(
      path.join(dir, "session.json"),
      JSON.stringify({
        version: 2,
        queue: [],
        supplements: [],
        view,
        messages: [
          { id: "reply", role: "assistant", text: "Completed implementation" },
          { id: "error", role: "system", text: "Verification failed", kind: "error" },
        ],
      })
    )
    const runtime = new SessionRuntime(config)
    try {
      runtime.open(meta.id)
      const raw = await driveFrame(<App config={config} runtime={runtime} />, {
        keys: [String.fromCharCode(20)],
        columns: 145,
        rows: 30,
        settleMs: 0,
      })
      const output = stripAnsi(raw)
      expect(raw).toContain(String.fromCharCode(27) + "[32m")
      expect(raw).toContain(String.fromCharCode(27) + "[31m")
      expect(output).toContain("✗ ◇ Developer")
      expect(output).toContain("Verification failed")
      expect(
        output.split("\n").filter((line) => (line.match(/│/g) ?? []).length === 2).length
      ).toBeGreaterThan(10)
    } finally {
      await runtime.close()
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })
  it("opens team separately and returns to the main input", async () => {
    const output = await frame(["\x14", "\x1b"])
    expect(output).toContain("Main chat")
    expect(output).toContain("Team ·")
    expect(output).toContain("message the coordinator…")
  })
  it("opens a temporary team viewer on a narrow terminal", async () => {
    const output = await frame(["\x14"], 65, 20)
    expect(output).toContain("Team ·")
    expect(output).toContain("Architect")
  })
  it("new chat selection keeps an unsent input draft", async () => {
    const r = new SessionRuntime(DEMO)
    const output = await driveFrame(<App config={DEMO} runtime={r} />, {
      keys: ["draft", "\x02", "\r"],
      settleMs: 0,
    }).then(stripAnsi)
    expect(r.draft).toBe("draft")
    expect(output).toContain("draft")
    await r.close()
  })
  it("documents request focus and separate current-work cancellation", async () => {
    const output = await frame(["?"])
    expect(output).toContain("Ctrl+G answer request")
    expect(output).toContain("Ctrl+C stop current work")
    expect(output).not.toContain("/sessions")
  })
  it.each([
    [145, 30],
    [100, 24],
    [65, 20],
    [40, 10],
    [20, 5],
  ])("keeps the main input visible at %s columns and %s rows", async (columns, rows) => {
    const output = await frame([], columns, rows)
    expect(output).toContain("multiclaw")
    expect(output).toContain("message the")
  })
  it("keeps multi-line Chinese text in the main draft", async () => {
    const r = new SessionRuntime(DEMO)
    await driveFrame(<App config={DEMO} runtime={r} />, {
      keys: ["实现分页\n保留测试"],
      settleMs: 0,
    })
    expect(r.draft).toBe("实现分页\n保留测试")
    await r.close()
  })
})
