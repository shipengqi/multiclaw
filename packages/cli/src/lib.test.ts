import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpRuntime } from "@multiclawcli/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { assertRuntimesAvailable, type MultiClawConfig } from "./lib"

/** A config whose agents all target the ACP runtime with the given commands. */
function acpConfig(commands: (string | undefined)[]): MultiClawConfig {
  return {
    name: "t",
    workDir: "/tmp/work",
    agents: commands.map((command, i) => ({
      id: `a${i}`,
      name: `agent ${i}`,
      runtime: "acp",
      command,
      systemPrompt: "",
      taskPrompt: "",
    })),
  }
}

function makeExecutable(dir: string, name: string): void {
  const file = join(dir, name)
  writeFileSync(file, "#!/bin/sh\n")
  chmodSync(file, 0o755)
}

/** Make `process.exit` throw so the gate stops execution but stays catchable. */
function spyOnExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
}

function stderr(): string {
  return vi.mocked(console.error).mock.calls.flat().join(" ")
}

describe("assertRuntimesAvailable", () => {
  const originalPath = process.env.PATH
  afterEach(() => {
    process.env.PATH = originalPath
  })

  it("names the missing command, not just the runtime", async () => {
    const exit = spyOnExit()
    vi.spyOn(console, "error").mockImplementation(() => {})
    process.env.PATH = "/nonexistent-dir-for-gate-test"

    await expect(
      assertRuntimesAvailable(acpConfig(["definitely-not-installed-xyz"]))
    ).rejects.toThrow()

    expect(exit).toHaveBeenCalledWith(1)
    // "runtime acp is not available" would be useless here — the missing thing
    // is the pinned binary.
    expect(stderr()).toContain('Command "definitely-not-installed-xyz"')
  })

  it("checks every distinct (runtime, command) pair, not just the runtime name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"))
    makeExecutable(dir, "good-agent")
    process.env.PATH = dir
    const exit = spyOnExit()
    vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      // The first agent passes; the second reuses the SAME runtime with a
      // different, absent command and must still be checked.
      await expect(
        assertRuntimesAvailable(acpConfig(["good-agent", "missing-agent"]))
      ).rejects.toThrow()

      expect(exit).toHaveBeenCalledWith(1)
      expect(stderr()).toContain('Command "missing-agent"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("probes a given (runtime, command) pair only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"))
    makeExecutable(dir, "good-agent")
    process.env.PATH = dir
    const describeSpy = vi.spyOn(AcpRuntime.prototype, "describe")
    try {
      await assertRuntimesAvailable(acpConfig(["good-agent", "good-agent"]))
      expect(describeSpy).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects an unknown runtime by name", async () => {
    const exit = spyOnExit()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const config = acpConfig([undefined])
    config.agents[0].runtime = "nope"

    await expect(assertRuntimesAvailable(config)).rejects.toThrow()

    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr()).toContain('Unknown runtime "nope"')
  })
})
