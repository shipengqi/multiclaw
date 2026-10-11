import type { AgentDefinition } from "../types/agent"
import type { MultiClawConfig } from "../types/config"
import { type ProviderSpec, specForCommand, specForProvider, tierModel } from "./catalog"

const DEFAULT_COMMAND = "opencode"
const DEFAULT_PROVIDER = "opencode"

/** Resolve the provider id for an agent, falling back through config defaults. */
export function resolveProvider(agent: AgentDefinition, config: MultiClawConfig): string {
  return (
    agent.provider ??
    specForCommand(agent.command ?? "")?.id ??
    config.defaults?.provider ??
    specForCommand(DEFAULT_COMMAND)?.id ??
    DEFAULT_PROVIDER
  )
}

/** Resolve the launch command for an agent. */
export function resolveCommand(agent: AgentDefinition, config: MultiClawConfig): string {
  return (
    agent.command ??
    config.defaults?.command ??
    specForProvider(resolveProvider(agent, config))?.command ??
    DEFAULT_COMMAND
  )
}

/** Resolve the model id an agent will actually run with. */
export function resolveModel(agent: AgentDefinition, config: MultiClawConfig): string | undefined {
  if (agent.model) return agent.model

  const provider = resolveProvider(agent, config)
  const spec = specForProvider(provider)

  // Prefer provider-id key, then legacy "acp" alias for backward compatibility.
  const fromModels = agent.models?.[provider] ?? agent.models?.acp
  if (fromModels) return fromModels

  if (agent.modelTier && spec) {
    const fromTier = tierModel(spec, agent.modelTier)
    if (fromTier) return fromTier
  }

  if (config.defaults?.model) return config.defaults.model
  if (spec) return spec.defaultModel
  return undefined
}

/** Convenience: full resolution in one call. */
export function resolveAgentRuntime(
  agent: AgentDefinition,
  config: MultiClawConfig
): {
  provider: string
  command: string
  model: string | undefined
  spec: ProviderSpec | undefined
} {
  const provider = resolveProvider(agent, config)
  const spec = specForProvider(provider)
  return {
    provider,
    command: resolveCommand(agent, config),
    model: resolveModel(agent, config),
    spec,
  }
}
