import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { SessionRuntime } from "./chat-session"
import * as clipboard from "./clipboard"
import { displayWidth } from "./format"
import { createSession, sessionDir } from "./sessions"
import { createInitialState, stripAnsi } from "./state"
import { DEMO, driveFrame, renderFrame } from "./test-helpers"

const frame = (keys: string[] = [], columns = 145, rows = 30) =>
  driveFrame(<App config={DEMO} />, { keys, columns, rows, settleMs: 0 }).then(stripAnsi)
describe("chat-centered terminal UI", () => {
  it("attaches an image path pasted at the beginning instead of running a command", async () => {
    const runtime = new SessionRuntime(DEMO)
    const submit = vi.spyOn(runtime, "submit").mockResolvedValue(undefined)
    try {
      const output = stripAnsi(
        await driveFrame(<App config={DEMO} runtime={runtime} />, {
          keys: ["/Users/test/Library/Application\\ Support/PixPin/截图.png", "\r"],
          settleMs: 0,
        })
      )
      expect(output).not.toContain("Unknown command")
      expect(submit).toHaveBeenCalledWith(
        "![multiclaw-image](</Users/test/Library/Application Support/PixPin/截图.png>)"
      )
    } finally {
      await runtime.close()
    }
  })
  it("shows attachments without exposing the path and removes them with alt+backspace", async () => {
    const runtime = new SessionRuntime(DEMO)
    try {
      const output = stripAnsi(
        await driveFrame(<App config={DEMO} runtime={runtime} />, {
          keys: ["/tmp/截图.png", "描述图片"],
          columns: 145,
          rows: 30,
          settleMs: 0,
        })
      )
      expect(runtime.draft).toBe("描述图片")
      expect(runtime.draftImages).toEqual(["/tmp/截图.png"])
      expect(output).toContain("1 image attached")
      expect(output).not.toContain("/tmp/截图.png")
      expect(output.trimEnd().split("\n")).toHaveLength(30)
      await driveFrame(<App config={DEMO} runtime={runtime} />, { keys: ["\x1b\x7f"], settleMs: 0 })
      expect(runtime.draftImages).toEqual([])
      expect(runtime.draft).toBe("描述图片")
    } finally {
      await runtime.close()
    }
  })
  it("sends a native clipboard image with subsequent text", async () => {
    const runtime = new SessionRuntime(DEMO)
    vi.spyOn(clipboard, "readClipboard").mockResolvedValue({ image: Buffer.from("image") })
    vi.spyOn(clipboard, "saveClipboardImage").mockResolvedValue("/tmp/native.png")
    const submit = vi.spyOn(runtime, "submit").mockResolvedValue(undefined)
    try {
      await driveFrame(<App config={DEMO} runtime={runtime} />, {
        keys: ["\x16", "看下图片", "\r"],
        settleMs: 0,
      })
      expect(submit).toHaveBeenCalledWith("看下图片\n\n![multiclaw-image](</tmp/native.png>)")
      expect(runtime.draftImages).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await runtime.close()
    }
  })
  it("keeps images with their session drafts when switching chats", async () => {
    const runtime = new SessionRuntime(DEMO)
    const first = createSession(DEMO.workDir)
    const second = createSession(DEMO.workDir)
    try {
      runtime.open(first.id)
      await driveFrame(<App config={DEMO} runtime={runtime} />, {
        keys: ["/tmp/first.png"],
        settleMs: 0,
      })
      runtime.open(second.id)
      expect(runtime.draftImages).toEqual([])
      runtime.setDraftImages(["/tmp/second.png"])
      runtime.open(first.id)
      expect(runtime.draftImages).toEqual(["/tmp/first.png"])
      runtime.newChat()
      expect(runtime.draftImages).toEqual([])
    } finally {
      await runtime.close()
    }
  })
  it("waits for clipboard reading before submitting", async () => {
    const runtime = new SessionRuntime(DEMO)
    let release!: (content: clipboard.ClipboardContent) => void
    vi.spyOn(clipboard, "readClipboard").mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const submit = vi.spyOn(runtime, "submit").mockResolvedValue(undefined)
    try {
      const output = stripAnsi(
        await driveFrame(<App config={DEMO} runtime={runtime} />, {
          keys: ["说明", "\x16", "\r"],
          settleMs: 0,
        })
      )
      expect(output).toContain("Reading clipboard")
      expect(submit).not.toHaveBeenCalled()
      expect(runtime.draft).toBe("说明")
    } finally {
      release({ text: "" })
      vi.restoreAllMocks()
      await runtime.close()
    }
  })
  it("preserves attachments when a slash command is submitted", async () => {
    const runtime = new SessionRuntime(DEMO)
    const submit = vi.spyOn(runtime, "submit").mockResolvedValue(undefined)
    try {
      const output = stripAnsi(
        await driveFrame(<App config={DEMO} runtime={runtime} />, {
          keys: ["/tmp/image.png", "/new", "\r"],
          settleMs: 0,
        })
      )
      expect(output).toContain("Images attach to messages")
      expect(runtime.draft).toBe("/new")
      expect(runtime.draftImages).toEqual(["/tmp/image.png"])
      expect(submit).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })
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
  it.each([65, 145])("renders Markdown with team hidden at %s columns", async (columns) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-chat-"))
    const config = { ...DEMO, workDir }
    const meta = createSession(workDir)
    const dir = sessionDir(workDir, meta.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "session.json"),
      JSON.stringify({
        version: 2,
        queue: [],
        supplements: [],
        view: createInitialState(config),
        messages: [
          { id: "user", role: "user", text: "**literal input**" },
          {
            id: "reply",
            role: "assistant",
            kind: "summary",
            text: "### 执行结果\n\n**尚未完成**，检查 `api_keys`。\n\n> 请检查凭证\n\n```ts\nconst ready = false\n```",
          },
        ],
      })
    )
    const runtime = new SessionRuntime(config)
    try {
      runtime.open(meta.id)
      const raw = await renderFrame(<App config={config} runtime={runtime} />, columns, 40)
      const output = stripAnsi(raw)
      expect(output).toContain("执行结果")
      expect(output).toContain("尚未完成")
      expect(output).toContain("api_keys")
      expect(output).toContain("const ready = false")
      expect(output).not.toContain("###")
      expect(output).not.toContain("**尚未完成**")
      expect(output).not.toContain("`api_keys`")
      expect(output).not.toContain("```")
      expect(output).toContain("user: **literal input**")
      expect(output).not.toContain("Team ·")
      expect(
        output
          .trimEnd()
          .split("\n")
          .every((line) => displayWidth(line) <= columns)
      ).toBe(true)
    } finally {
      await runtime.close()
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })
  it("shows active running agents in the chat header when running", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "running-chat-"))
    const config = { ...DEMO, workDir }
    const meta = createSession(workDir)
    const dir = sessionDir(workDir, meta.id)
    fs.mkdirSync(dir, { recursive: true })
    const view = createInitialState(config)
    view.agents.architect.status = "running"
    fs.writeFileSync(
      path.join(dir, "session.json"),
      JSON.stringify({
        version: 2,
        queue: [],
        supplements: [],
        inFlight: true,
        view,
        messages: [{ id: "m1", role: "user", text: "Design app" }],
      })
    )
    const runtime = new SessionRuntime(config)
    try {
      runtime.open(meta.id)
      if (runtime.current) {
        runtime.current.running = true
        runtime.current.view.agents.architect.status = "running"
      }
      const raw = await renderFrame(<App config={config} runtime={runtime} />, 145, 30)
      const output = stripAnsi(raw)
      expect(output).toContain("running: Architect")
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
