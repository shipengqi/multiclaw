import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "./loadConfig"

const VALID_CONFIG = `export default {
  agents: [{ id: "a", name: "Agent A", systemPrompt: "s", taskPrompt: "t" }],
  workDir: "./work",
}`

function spyOnProcessCwd() {
  return vi.spyOn(process, "cwd")
}

let tmpDir: string
let cwdSpy: ReturnType<typeof spyOnProcessCwd>

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-cfg-"))
  // Treat the sandbox as a Node ESM project so `.js` configs parse as ESM.
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }))
  cwdSpy = spyOnProcessCwd().mockReturnValue(tmpDir)
})

afterEach(() => {
  cwdSpy.mockRestore()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(name: string, body: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, body)
  return p
}

describe("loadConfig", () => {
  it("discovers multiclaw.config.js in the working directory", async () => {
    write("multiclaw.config.js", VALID_CONFIG)
    const config = await loadConfig()
    expect(config.agents).toHaveLength(1)
    expect(config.agents[0].id).toBe("a")
  })

  it("prefers an explicit path and resolves workDir relative to the config file", async () => {
    const p = write("multiclaw.config.js", VALID_CONFIG)
    const config = await loadConfig(p)
    expect(config.workDir).toBe(path.join(tmpDir, "work"))
  })

  it("injects the requirement into context when provided", async () => {
    const p = write("multiclaw.config.js", VALID_CONFIG)
    const config = await loadConfig(p, "build a thing")
    expect(config.context?.requirement).toBe("build a thing")
  })

  it("leaves context untouched when no requirement is given", async () => {
    const p = write("multiclaw.config.js", VALID_CONFIG)
    const config = await loadConfig(p)
    expect(config.context?.requirement).toBeUndefined()
  })

  it("throws when an explicit config path does not exist", async () => {
    await expect(loadConfig(path.join(tmpDir, "nope.js"))).rejects.toThrow(/Config file not found/)
  })

  it("throws when no config file can be discovered", async () => {
    await expect(loadConfig()).rejects.toThrow(/No config file found/)
  })

  it("rejects a config without an agents array", async () => {
    const p = write("multiclaw.config.js", "export default { workDir: './w' }")
    await expect(loadConfig(p)).rejects.toThrow(/Invalid config format/)
  })

  it("loads a TypeScript config via the tsx loader", async () => {
    const p = write(
      "multiclaw.config.ts",
      `import type { MultiClawConfig } from "@multiclawcli/core"
export default {
  agents: [{ id: "ts", name: "TS", systemPrompt: "s", taskPrompt: "t" }],
  workDir: "./w",
} satisfies MultiClawConfig`
    )
    const config = await loadConfig(p)
    expect(config.agents[0].id).toBe("ts")
  })
})
