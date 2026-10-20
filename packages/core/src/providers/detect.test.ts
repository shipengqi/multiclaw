import { beforeEach, describe, expect, it, vi } from "vitest"
import { detectProviders, presentProviders } from "./detect"

// Control PATH / bundled-bridge resolution without touching the real filesystem.
vi.mock("./bridge", () => ({
  resolveExecutable: vi.fn(),
}))

import { resolveExecutable } from "./bridge"

// versionFor() shells out via spawn; fake it so detection is deterministic.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}))

import { spawn } from "node:child_process"

const resolveMock = resolveExecutable as unknown as ReturnType<typeof vi.fn>
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

/** A fake child that emits `stdout` on data then closes successfully. */
function fakeChild(stdout: string) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const on = (event: string, cb: (...args: unknown[]) => void) => {
    const existing = listeners[event]
    if (existing) existing.push(cb)
    else listeners[event] = [cb]
  }
  const child = {
    stdout: { on },
    on,
    kill: vi.fn(),
  }
  setImmediate(() => {
    for (const cb of listeners.data ?? []) cb(Buffer.from(stdout))
    for (const cb of listeners.close ?? []) cb(0)
  })
  return child
}

beforeEach(() => {
  resolveMock.mockReset()
  spawnMock.mockReset()
  // Default: every known binary resolves on PATH, which is the bare command —
  // an absolute path means the bundled bridge answered instead.
  resolveMock.mockImplementation((cmd: string) => cmd)
  spawnMock.mockImplementation((cmd: string) =>
    fakeChild(String(cmd).includes("cursor") ? "cursor-agent 0.4.2" : "1.0.0")
  )
})

describe("detectProviders", () => {
  it("marks non-ambiguous providers present when the binary resolves", async () => {
    const found = await detectProviders()
    const ids = found.filter((p) => p.status === "present").map((p) => p.id)
    // opencode / claude / codex have no `confirm`, so they are present;
    // cursor has `confirm` and is treated as missing without withVersion.
    expect(ids).toEqual(expect.arrayContaining(["opencode", "claude", "codex"]))
    expect(ids).not.toContain("cursor")
  })

  it("marks a provider that resolved on PATH as path-sourced", async () => {
    const found = await detectProviders()
    const claude = found.find((p) => p.id === "claude")
    expect(claude?.source).toBe("path")
    expect(claude?.resolvedPath).toBeUndefined()
  })

  // A bundled bridge is the case where "present" says nothing about what the
  // user installed: multiclaw supplied the executable itself, and the user
  // needs to be able to see which file it will actually spawn.
  it("marks a provider multiclaw's own bridge supplied as bundled, with its path", async () => {
    resolveMock.mockImplementation((cmd: string) =>
      cmd === "claude-agent-acp"
        ? "/opt/multiclaw/node_modules/@agentclientprotocol/claude-agent-acp/bin.js"
        : cmd
    )
    const found = await detectProviders()
    const claude = found.find((p) => p.id === "claude")
    expect(claude?.status).toBe("present")
    expect(claude?.source).toBe("bundled")
    expect(claude?.resolvedPath).toContain("claude-agent-acp")
    // Others are unaffected.
    expect(found.find((p) => p.id === "opencode")?.source).toBe("path")
  })

  it("reports the install hint for a missing provider", async () => {
    resolveMock.mockImplementation((cmd: string) =>
      cmd === "opencode" ? null : `/usr/local/bin/${cmd}`
    )
    const found = await detectProviders()
    const opencode = found.find((p) => p.id === "opencode")
    expect(opencode?.status).toBe("missing")
    expect(opencode?.note).toMatch(/opencode/)
  })

  it("confirms ambiguous binaries via --version when withVersion is set", async () => {
    const found = await detectProviders({ withVersion: true })
    const cursor = found.find((p) => p.id === "cursor")
    expect(cursor?.status).toBe("present")
    expect(cursor?.version).toBe("cursor-agent 0.4.2")
  })

  it("treats an ambiguous binary as missing when --version does not confirm it", async () => {
    spawnMock.mockImplementation(() => fakeChild("some-other-agent 9.9.9"))
    const found = await detectProviders({ withVersion: true })
    const cursor = found.find((p) => p.id === "cursor")
    expect(cursor?.status).toBe("missing")
  })

  it("captures version strings for non-ambiguous providers when withVersion is set", async () => {
    const found = await detectProviders({ withVersion: true })
    const claude = found.find((p) => p.id === "claude")
    expect(claude?.version).toBe("1.0.0")
  })
})

describe("presentProviders", () => {
  it("returns only the ids that are present", async () => {
    const found = await detectProviders()
    expect(presentProviders(found)).not.toContain("cursor")
    expect(presentProviders(found)).toEqual(expect.arrayContaining(["opencode", "claude", "codex"]))
  })
})
