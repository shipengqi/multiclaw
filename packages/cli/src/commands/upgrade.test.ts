import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const execSyncMock = vi.fn()
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}))

// `upgrade.ts` resolves its own version via `require("../package.json")`, which
// does not exist relative to the source file under vitest. Stub createRequire.
vi.mock("node:module", () => ({
  createRequire: () => (id: string) => {
    if (id === "../package.json") return { version: "0.3.2" }
    throw new Error(`unexpected require: ${id}`)
  },
}))

const { upgradeCommand } = await import("./upgrade")

const CURRENT_VERSION = "0.3.2"

// Wrap each spy in a function so the variable type is the exact spy signature
// rather than the overly generic `ReturnType<typeof vi.spyOn>`.
function spyOnConsoleLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {})
}
function spyOnConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {})
}
function spyOnProcessExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
}

let logSpy: ReturnType<typeof spyOnConsoleLog>
let errorSpy: ReturnType<typeof spyOnConsoleError>
let exitSpy: ReturnType<typeof spyOnProcessExit>

beforeEach(() => {
  logSpy = spyOnConsoleLog()
  errorSpy = spyOnConsoleError()
  exitSpy = spyOnProcessExit()
})

afterEach(() => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
  exitSpy.mockRestore()
})

const logged = () => logSpy.mock.calls.flat().join("\n")

describe("upgradeCommand", () => {
  it("reports already-latest without installing", async () => {
    execSyncMock.mockReturnValue(`${CURRENT_VERSION}\n`)
    await upgradeCommand()

    expect(logged()).toContain("Already on the latest version")
    expect(execSyncMock).toHaveBeenCalledTimes(1)
    expect(execSyncMock).toHaveBeenCalledWith("npm show multiclaw version", {
      encoding: "utf8",
    })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("installs the latest version when an update is available", async () => {
    execSyncMock.mockReturnValueOnce("9.9.9\n").mockReturnValueOnce("")
    await upgradeCommand()

    expect(execSyncMock).toHaveBeenNthCalledWith(2, "npm install -g multiclaw@latest", {
      stdio: "inherit",
    })
    expect(logged()).toContain("Successfully upgraded to v9.9.9")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("exits with code 1 when the registry lookup fails", async () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error("network down")
    })
    await upgradeCommand()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch latest version"))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it("exits with code 1 when the install command fails", async () => {
    execSyncMock.mockReturnValueOnce("9.9.9\n").mockImplementationOnce(() => {
      throw new Error("install failed")
    })
    await upgradeCommand()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Upgrade failed"))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
