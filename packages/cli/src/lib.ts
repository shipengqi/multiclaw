import { type MultiClawConfig, runtimeRegistry } from "@multiclawcli/core"

export type { AgentDefinition, MultiClawConfig } from "@multiclawcli/core"
export { agents, defineConfig } from "@multiclawcli/core"

/** Runtime names a config's agents reference, defaulting to the built-in one. */
function configRuntimeNames(config: MultiClawConfig): Set<string> {
  return new Set(config.agents.map((a) => a.runtime ?? "claude"))
}

/**
 * Hard gate for `run`/`tui`: every runtime the config names must exist and
 * report itself as installed, or the process exits before any work starts.
 *
 * Availability comes from `describe()` rather than an ad-hoc `execSync`, so
 * "is this runtime installed?" has exactly one implementation.
 */
export async function assertRuntimesAvailable(config: MultiClawConfig): Promise<void> {
  for (const name of configRuntimeNames(config)) {
    if (!runtimeRegistry.has(name)) {
      console.error(`\x1b[31mError: Unknown runtime "${name}". Supported: claude\x1b[0m`)
      process.exit(1)
    }
    const info = await runtimeRegistry.get(name).describe()
    if (!info.available) {
      console.error(
        `\x1b[31mError: Runtime "${name}" is not available. Make sure the CLI is installed.\x1b[0m`
      )
      process.exit(1)
    }
  }
}

/** Registered runtimes that report themselves as installed. Advisory only. */
export async function availableRuntimes(): Promise<string[]> {
  const available: string[] = []
  for (const name of runtimeRegistry.list()) {
    if ((await runtimeRegistry.get(name).describe()).available) available.push(name)
  }
  return available
}
