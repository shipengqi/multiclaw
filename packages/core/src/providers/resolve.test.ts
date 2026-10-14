import { describe, expect, it } from "vitest"
import type { AgentDefinition } from "../types/agent"
import type { MultiClawConfig } from "../types/config"
import { resolveArgs, resolveCommand, resolveModel, resolveProvider } from "./resolve"

const baseAgent = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: "a",
  name: "A",
  systemPrompt: "s",
  taskPrompt: "t",
  ...overrides,
})

const baseConfig = (overrides: Partial<MultiClawConfig> = {}): MultiClawConfig => ({
  name: "test",
  workDir: ".",
  agents: [],
  ...overrides,
})

describe("resolveProvider", () => {
  it("uses agent.provider when present", () => {
    expect(resolveProvider(baseAgent({ provider: "codex" }), baseConfig())).toBe("codex")
  })

  it("infers from agent.command", () => {
    expect(resolveProvider(baseAgent({ command: "claude-agent-acp" }), baseConfig())).toBe("claude")
  })

  it("falls back to config.defaults.provider", () => {
    expect(resolveProvider(baseAgent(), baseConfig({ defaults: { provider: "opencode" } }))).toBe(
      "opencode"
    )
  })

  it("falls back to the default command's provider", () => {
    expect(resolveProvider(baseAgent(), baseConfig())).toBe("opencode")
  })
})

describe("resolveCommand", () => {
  it("uses agent.command when present", () => {
    expect(resolveCommand(baseAgent({ command: "/opt/bin/custom" }), baseConfig())).toBe(
      "/opt/bin/custom"
    )
  })

  it("falls back to provider's command", () => {
    expect(resolveCommand(baseAgent({ provider: "claude" }), baseConfig())).toBe("claude-agent-acp")
  })
})

describe("resolveArgs", () => {
  it("uses agent.args when present", () => {
    expect(resolveArgs(baseAgent({ provider: "claude", args: ["--x"] }), baseConfig())).toEqual([
      "--x",
    ])
  })

  it("pairs the provider's args with its command", () => {
    // The bundled bridges take no args; opencode needs the `acp` subcommand.
    // Getting this wrong launches e.g. `claude-agent-acp acp`.
    expect(resolveArgs(baseAgent({ provider: "claude" }), baseConfig())).toEqual([])
    expect(resolveArgs(baseAgent({ provider: "opencode" }), baseConfig())).toEqual(["acp"])
  })

  it("returns undefined for an unknown provider so the runtime default applies", () => {
    expect(resolveArgs(baseAgent({ provider: "unknown" }), baseConfig())).toBeUndefined()
  })

  it("returns undefined for a custom command outside the catalog", () => {
    // A truly custom command has no known args, so the runtime's own default
    // must apply rather than the default provider's ["acp"].
    expect(resolveArgs(baseAgent({ command: "/opt/bin/custom" }), baseConfig())).toBeUndefined()
  })

  it("pairs an explicit command's catalog args with that command", () => {
    expect(resolveArgs(baseAgent({ command: "claude-agent-acp" }), baseConfig())).toEqual([])
    expect(resolveArgs(baseAgent({ command: "opencode" }), baseConfig())).toEqual(["acp"])
  })

  it("uses config.defaults.command when the agent names none", () => {
    expect(
      resolveArgs(baseAgent(), baseConfig({ defaults: { command: "/opt/bin/custom" } }))
    ).toBeUndefined()
    expect(resolveArgs(baseAgent(), baseConfig({ defaults: { command: "opencode" } }))).toEqual([
      "acp",
    ])
  })

  it("prefers an explicit args array over the command's catalog args", () => {
    expect(resolveArgs(baseAgent({ command: "opencode", args: ["--x"] }), baseConfig())).toEqual([
      "--x",
    ])
  })
})

describe("resolveModel", () => {
  it("uses agent.model as the highest priority", () => {
    expect(
      resolveModel(baseAgent({ model: "custom", models: { acp: "sonnet" } }), baseConfig())
    ).toBe("custom")
  })

  it("uses agent.models keyed by provider id", () => {
    expect(
      resolveModel(
        baseAgent({ models: { claude: "opus" } }),
        baseConfig({ defaults: { provider: "claude" } })
      )
    ).toBe("opus")
  })

  it("falls back to legacy acp alias", () => {
    expect(resolveModel(baseAgent({ models: { acp: "sonnet" } }), baseConfig())).toBe("sonnet")
  })

  it("uses modelTier when no explicit model is set", () => {
    expect(resolveModel(baseAgent({ provider: "claude", modelTier: "fast" }), baseConfig())).toBe(
      "haiku"
    )
  })

  it("uses config.defaults.model", () => {
    expect(resolveModel(baseAgent(), baseConfig({ defaults: { model: "gpt-5" } }))).toBe("gpt-5")
  })

  it("uses provider defaultModel as final fallback", () => {
    expect(resolveModel(baseAgent({ provider: "claude" }), baseConfig())).toBe("sonnet")
  })

  it("returns undefined when nothing is configured and provider is unknown", () => {
    expect(resolveModel(baseAgent({ provider: "unknown" }), baseConfig())).toBeUndefined()
  })

  it('preserves old-config behaviour: { command: "opencode", models: { acp: "sonnet" } }', () => {
    const agent = baseAgent({ command: "opencode", models: { acp: "sonnet" } })
    expect(resolveModel(agent, baseConfig())).toBe("sonnet")
  })
})
