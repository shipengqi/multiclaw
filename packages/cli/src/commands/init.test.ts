import { describe, expect, it } from "vitest"
import { generateConfig, overrideChoices, PRESET_AGENT_IDS } from "./init"

const PRESETS = ["backend", "frontend", "fullstack"]

function config(overrides?: Array<{ id: string; model: string }>, preset = "backend"): string {
  return generateConfig({
    preset,
    workDir: ".",
    projectName: "demo",
    provider: "opencode",
    overrides,
  })
}

describe("generateConfig", () => {
  it("writes a default leader with no override", () => {
    // Before the fix the leader was simply absent from the generated file, so a
    // console opened on it had nobody to route the first requirement.
    expect(config()).toContain("leader: agents.leader(),")
  })

  it("writes a leader override explicitly, outside the pipeline block", () => {
    const out = config([{ id: "leader", model: "opus" }])
    expect(out).toContain('leader: agents.leader({ model: "opus" }),')
    expect(out).not.toContain("leader: agents.leader(),")
  })

  it("injects an agent override into its pipeline line", () => {
    // backend's architect line already carries a dependency, so the model must
    // be appended after it rather than replacing it.
    const out = config([{ id: "architect", model: "opus" }])
    expect(out).toContain('agents.architect({ dependsOn: ["product-manager"], model: "opus" })')
  })

  it("injects an override into an agent that has no arguments", () => {
    // frontend's architect is the bare `agents.architect()` call.
    const out = config([{ id: "architect", model: "opus" }], "frontend")
    expect(out).toContain('agents.architect({ model: "opus" })')
  })

  it("keeps PRESET_AGENT_IDS in step with the generated blocks", () => {
    // Every id offered by the override checkbox has to appear as a real
    // `agents.<id>(` call, or the override is silently dropped.
    for (const preset of PRESETS) {
      const out = config(undefined, preset)
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

  it("quotes every injected string, so a value cannot break out of the literal", () => {
    const out = generateConfig({
      preset: "backend",
      workDir: ".",
      projectName: 'a"b',
      provider: "opencode",
      overrides: [{ id: "leader", model: 'x"); evil();("' }],
    })
    expect(out).toContain('name: "a\\"b"')
    expect(out).toContain('leader: agents.leader({ model: "x\\"); evil();(\\"" }),')
  })
})

describe("overrideChoices", () => {
  it("always offers the leader, which belongs to no preset", () => {
    for (const preset of PRESETS) {
      expect(overrideChoices(preset).map((c) => c.value)).toContain("leader")
    }
  })

  it("offers only the agents the preset actually contains", () => {
    const values = overrideChoices("frontend").map((c) => c.value)
    expect(values).toContain("uiDesigner")
    // Not part of the frontend preset, so it must not be offered.
    expect(values).not.toContain("backendDeveloper")
    expect(values).not.toContain("productManager")
  })

  it("offers every id it declares, with a label for each", () => {
    for (const preset of PRESETS) {
      const choices = overrideChoices(preset)
      // The leader plus the preset's agents — no more, no less.
      expect(choices).toHaveLength(PRESET_AGENT_IDS[preset].length + 1)
      for (const choice of choices) {
        expect(choice.name.length).toBeGreaterThan(0)
      }
    }
  })
})
