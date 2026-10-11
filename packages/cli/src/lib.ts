import { type MultiClawConfig, runtimeRegistry } from "@multiclawcli/core"

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
    const name = agent.runtime ?? "claude"
    if (!runtimeRegistry.has(name)) {
      const supported = runtimeRegistry.list().join(", ")
      console.error(`\x1b[31mError: Unknown runtime "${name}". Supported: ${supported}\x1b[0m`)
      process.exit(1)
    }
    const key = `${name}\u0000${agent.command ?? ""}`
    if (checked.has(key)) continue
    checked.add(key)
    const info = await runtimeRegistry.get(name).describe({ command: agent.command })
    if (!info.available) {
      // Name the command when the config pinned one — "runtime acp is not
      // available" is useless when the real problem is a missing `codex-acp`.
      const subject = agent.command ? `Command "${agent.command}"` : `Runtime "${name}"`
      console.error(
        `\x1b[31mError: ${subject} is not available. Make sure the CLI is installed.\x1b[0m`
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
