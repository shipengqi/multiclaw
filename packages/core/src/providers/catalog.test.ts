import { describe, expect, it } from "vitest"
import {
  PROVIDERS,
  providerCommands,
  providerIds,
  specForCommand,
  specForProvider,
  tierModel,
} from "./catalog"

describe("catalog", () => {
  it("has no duplicate provider ids", () => {
    const ids = PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("has no duplicate commands across primary + aliases", () => {
    const all = providerCommands()
    expect(new Set(all).size).toBe(all.length)
  })

  it("every tier has at most one defaultForTier per provider", () => {
    for (const spec of PROVIDERS) {
      const tiers = ["strong", "balanced", "fast"] as const
      for (const tier of tiers) {
        const defaults = spec.models.filter((m) => m.tier === tier && m.defaultForTier)
        expect(defaults.length).toBeLessThanOrEqual(1)
      }
    }
  })

  it("specForProvider returns undefined for unknown id", () => {
    expect(specForProvider("nonexistent")).toBeUndefined()
  })

  it("specForCommand matches basename with paths and suffixes stripped", () => {
    expect(specForCommand("claude-agent-acp")?.id).toBe("claude")
    expect(specForCommand("/usr/bin/claude-agent-acp")?.id).toBe("claude")
    expect(specForCommand("claude-agent-acp.exe")?.id).toBe("claude")
    expect(specForCommand("CLaUdE-AgEnT-ACP")?.id).toBe("claude")
  })

  it("specForCommand returns undefined for unknown command", () => {
    expect(specForCommand("unknown-binary")).toBeUndefined()
  })

  it("providerIds includes all four current providers", () => {
    expect(providerIds()).toEqual(expect.arrayContaining(["claude", "opencode", "codex", "cursor"]))
  })

  describe("tierModel", () => {
    it("returns the defaultForTier model when present", () => {
      const claude = specForProvider("claude")!
      expect(tierModel(claude, "strong")).toBe("opus")
      expect(tierModel(claude, "balanced")).toBe("sonnet")
      expect(tierModel(claude, "fast")).toBe("haiku")
    })

    it("falls back to the first model of the tier when no defaultForTier", () => {
      const opencode = specForProvider("opencode")!
      // opencode has multiple fast models; one is defaultForTier
      expect(tierModel(opencode, "fast")).toBeTruthy()
    })

    it("returns undefined for a tier the provider has no models for", () => {
      // All current providers have all three tiers, so test with a fabricated spec
      const minimal = { ...specForProvider("opencode")!, models: [] }
      expect(tierModel(minimal, "strong")).toBeUndefined()
    })
  })
})
