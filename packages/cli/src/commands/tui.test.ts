import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  config: { name: "demo", workDir: "/tmp/demo", agents: [] },
  loadConfig: vi.fn(),
  assertRuntimesAvailable: vi.fn(),
  startTui: vi.fn(),
  attach: vi.fn(),
  drain: vi.fn(),
  detach: vi.fn(),
}))

vi.mock("../loader/loadConfig", () => ({ loadConfig: mocks.loadConfig }))
vi.mock("../lib", () => ({ assertRuntimesAvailable: mocks.assertRuntimesAvailable }))
vi.mock("@multiclawcli/dashboard/tui", () => ({ startTui: mocks.startTui }))
vi.mock("../reporters/FileLogWriter", () => ({
  FileLogWriter: class {
    attach = mocks.attach
    drain = mocks.drain
  },
}))

import { tuiCommand } from "./tui"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadConfig.mockResolvedValue(mocks.config)
  mocks.assertRuntimesAvailable.mockResolvedValue(undefined)
  mocks.startTui.mockResolvedValue(undefined)
  mocks.attach.mockReturnValue(mocks.detach)
  mocks.drain.mockResolvedValue(undefined)
})

describe("tuiCommand", () => {
  it("returns a disposer that awaits log durability before detaching", async () => {
    await tuiCommand({ config: "team.ts" })
    expect(mocks.loadConfig).toHaveBeenCalledWith("team.ts")
    expect(mocks.assertRuntimesAvailable).toHaveBeenCalledWith(mocks.config)
    const { onTurnStart } = mocks.startTui.mock.calls[0][0]
    const eventBus = {}
    const dispose = onTurnStart(eventBus, "/tmp/logs")
    expect(mocks.attach).toHaveBeenCalledWith(eventBus)
    let finishDrain!: () => void
    mocks.drain.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDrain = resolve
      })
    )
    const disposing = dispose()
    expect(mocks.drain).toHaveBeenCalledOnce()
    expect(mocks.detach).not.toHaveBeenCalled()
    finishDrain()
    await disposing
    expect(mocks.detach).toHaveBeenCalledOnce()
  })

  it("detaches even when draining rejects", async () => {
    await tuiCommand({})
    const { onTurnStart } = mocks.startTui.mock.calls[0][0]
    const dispose = onTurnStart({}, "/tmp/logs")
    mocks.drain.mockRejectedValue(new Error("drain failed"))
    await expect(dispose()).rejects.toThrow("drain failed")
    expect(mocks.detach).toHaveBeenCalledOnce()
  })
})
