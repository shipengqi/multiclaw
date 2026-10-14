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

/**
 * Resolve the launch arguments for an agent.
 *
 * Paired with {@link resolveCommand}: the catalog carries per-provider args
 * (`opencode acp` needs `["acp"]`, the bundled bridges need `[]`), so leaving
 * `args` undefined would let the runtime fall back to its `["acp"]` default and
 * launch e.g. `claude-agent-acp acp`. Returns undefined for a truly custom
 * command so the runtime's default still applies.
 */
export function resolveArgs(agent: AgentDefinition, config: MultiClawConfig): string[] | undefined {
  if (agent.args) return agent.args
  // The command decides its own args: an explicit command must not inherit the
  // default provider's ["acp"]. Without this, a custom binary outside the
  // catalog resolved through `resolveProvider` to `opencode` and was launched as
  // `<custom> acp`.
  const command = agent.command ?? config.defaults?.command
  if (command) return specForCommand(command)?.args
  return specForProvider(resolveProvider(agent, config))?.args
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
