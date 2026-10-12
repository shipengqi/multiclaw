import {
  detectProviders,
  type MultiClawConfig,
  presentProviders,
  resolveCommand,
  runtimeRegistry,
} from "@multiclawcli/core"

export type { AgentDefinition, MultiClawConfig } from "@multiclawcli/core"
export { agents, defineConfig } from "@multiclawcli/core"

/**
 * Hard gate for `run`/`tui`: every runtime the config names must exist and
 * report itself as installed, or the process exits before any work starts.
 *
 * Availability comes from `describe()` rather than an ad-hoc `execSync`, so
 * "is this runtime installed?" has exactly one implementation. `describe()`
 * receives the agent's configured command because an external-process runtime
 * (e.g. ACP) is only as available as the binary it was told to launch.
 */
export async function assertRuntimesAvailable(config: MultiClawConfig): Promise<void> {
  // Dedupe on the (runtime, command) pair, not the name alone: two agents can
  // both use `runtime: "acp"` while naming different binaries (`opencode` vs
  // `codex-acp`), and both must be checked.
  const checked = new Set<string>()
  for (const agent of config.agents) {
    const name = agent.runtime ?? "acp"
    if (!runtimeRegistry.has(name)) {
      const supported = runtimeRegistry.list().join(", ")
      console.error(`\x1b[31mError: Unknown runtime "${name}". Supported: ${supported}\x1b[0m`)
      process.exit(1)
    }
    // Resolve the command the runtime would actually launch: an agent may pin a
    // `provider` or rely on `defaults` instead of a literal `command`, and the
    // runtime is only as available as that resolved binary. Without this, a
    // `provider: "claude"` config (no `command`) fell back to the `opencode`
    // default and reported the runtime unavailable even though `claude-agent-acp`
    // was installed.
    const command = resolveCommand(agent, config)
    const key = `${name}\u0000${command}`
    if (checked.has(key)) continue
    checked.add(key)
    const info = await runtimeRegistry.get(name).describe({ command })
    if (!info.available) {
      // Name the command — "runtime acp is not available" is useless when the
      // real problem is a missing `claude-agent-acp` or `codex-acp`.
      const subject = `Command "${command}"`
      console.error(
        `\x1b[31mError: ${subject} is not available. Make sure the CLI is installed.\x1b[0m`
      )
      process.exit(1)
    }
  }
}

/** Re-export for consumers that need full detection details. */
export { detectProviders, presentProviders }

/**
 * Legacy alias: returns runtime names that have at least one provider present.
 * Prefer `detectProviders()` for new code.
 */
export async function availableRuntimes(): Promise<string[]> {
  const detected = await detectProviders()
  const present = presentProviders(detected)
  // Today the only runtime is "acp"; if any provider is present, acp is available.
  return present.length > 0 ? ["acp"] : []
}
