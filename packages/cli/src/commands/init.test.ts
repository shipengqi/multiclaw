import { describe, expect, it } from "vitest"
import { generateConfig, PRESET_AGENT_IDS } from "./init"

const PRESETS = ["backend", "frontend", "fullstack"]

function config(preset = "backend"): string {
  return generateConfig({
    preset,
    workDir: ".",
    projectName: "demo",
    provider: "opencode",
    permissionMode: "ask",
  })
}

describe("generateConfig", () => {
  it("writes a leader with no per-agent overrides", () => {
    expect(config()).not.toContain("leader:")
  })

  it("keeps PRESET_AGENT_IDS in step with the generated blocks", () => {
    // Every id in PRESET_AGENT_IDS must appear as a real `agents.<id>(` call,
    // or a model override would be silently injected into the wrong line.
    for (const preset of PRESETS) {
      const out = config(preset)
      for (const id of PRESET_AGENT_IDS[preset]) {
        expect(out).toContain(`agents.${id}(`)
      }
    }
  })

  it("emits a module that imports and default-exports the config", () => {
    const out = config()
    expect(out).toContain('import { defineConfig, agents } from "multiclaw"')
    expect(out).toContain("export default defineConfig(")
  })

  it("quotes injected strings so a value cannot break out of the literal", () => {
    const out = generateConfig({
      preset: "backend",
      workDir: ".",
      projectName: 'a"b',
      provider: "opencode",
      permissionMode: "ask",
    })
    expect(out).toContain('name: "a\\"b"')
  })

  it.each(["auto", "ask"] as const)("records the chosen %s mode in defaults", (mode) => {
    // The mode is a decision the user made, so it belongs in the file. Leaving
    // "ask" implicit made the same config mean auto under `multiclaw run`,
    // which reads the file rather than the console's own default.
    const out = generateConfig({
      preset: "backend",
      workDir: ".",
      projectName: "demo",
      provider: "opencode",
      permissionMode: mode,
    })
    expect(out).toContain(`permissions: { mode: "${mode}" }`)
  })
})
