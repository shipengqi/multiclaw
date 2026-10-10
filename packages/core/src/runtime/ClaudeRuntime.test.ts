import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"

const spawnMock = vi.fn()
const execSyncMock = vi.fn()
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}))

const { ClaudeRuntime } = await import("./ClaudeRuntime")

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "do it",
    tools: ["Read", "Bash"],
    workDir: "/tmp/work",
    ...overrides,
  } as never
}

afterEach(() => {
  spawnMock.mockReset()
  execSyncMock.mockReset()
})

describe("ClaudeRuntime.checkAvailable", () => {
  it("returns true when the claude CLI responds", async () => {
    execSyncMock.mockReturnValue(Buffer.from("1.0.0"))
    expect(await new ClaudeRuntime().checkAvailable()).toBe(true)
    expect(execSyncMock).toHaveBeenCalledWith("claude --version", { stdio: "ignore" })
  })

  it("returns false when the CLI is missing", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not found")
    })
    expect(await new ClaudeRuntime().checkAvailable()).toBe(false)
  })
})

describe("ClaudeRuntime.execute", () => {
  it("spawns claude with the base args", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask())
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["-p", "do it", "--allowedTools", "Read,Bash"],
      { cwd: "/tmp/work", env: process.env }
    )

    child.emit("close", 0)
    await expect(p).resolves.toEqual({ output: "", exitCode: 0 })
  })

  it("appends --system-prompt and --model when provided", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask({ systemPrompt: "sys", model: "sonnet" }))
    expect(spawnMock.mock.calls[0][1]).toEqual([
      "-p",
      "do it",
      "--allowedTools",
      "Read,Bash",
      "--system-prompt",
      "sys",
      "--model",
      "sonnet",
    ])

    child.emit("close", 0)
    await p
  })

  it("streams stdout chunks and forwards them to onOutput", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const onOutput = vi.fn()

    const p = new ClaudeRuntime().execute(makeTask({ onOutput }))
    child.stdout.emit("data", Buffer.from("he"))
    child.stdout.emit("data", Buffer.from("llo"))
    child.emit("close", 0)

    await expect(p).resolves.toEqual({ output: "hello", exitCode: 0 })
    expect(onOutput).toHaveBeenNthCalledWith(1, "he")
    expect(onOutput).toHaveBeenNthCalledWith(2, "llo")
  })

  it("rejects with the stderr output when the process exits non-zero", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask())
    child.stderr.emit("data", Buffer.from("boom"))
    child.emit("close", 1)

    await expect(p).rejects.toThrow("claude exited with code 1: boom")
  })

  it("kills the child on abort and leaves the promise unsettled", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()

    let settled = false
    const p = new ClaudeRuntime().execute(makeTask({ signal: controller.signal }))
    p.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    controller.abort()
    expect(child.kill).toHaveBeenCalled()

    child.emit("close", 0)
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
  })

  it("rejects when the process fails to start", async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const p = new ClaudeRuntime().execute(makeTask())
    child.emit("error", new Error("ENOENT"))

    await expect(p).rejects.toThrow("Failed to start claude: ENOENT")
  })
})
