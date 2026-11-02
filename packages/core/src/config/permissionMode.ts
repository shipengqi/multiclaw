import type { AgentDefinition, PermissionMode } from "../types/agent"
import type { MultiClawConfig } from "../types/config"

/**
 * The approval mode that applies to one agent.
 *
 * Three levels, most specific first: the agent's own `permissions`, then the
 * project's `permissions`, then `defaults.permissions`. It lives here rather
 * than inline in the runner because a second copy drifts: the console's header
 * used to fold `defaults` into the same test as the project level, so a config
 * with `permissions: { mode: "deny" }` and `defaults.permissions.mode: "auto"`
 * announced `auto` while the runner enforced `deny`.
 *
 * `undefined` means nobody configured a mode and the runtime's own default
 * applies. The console resolves that to `ask` for itself, because a human is
 * sitting there to answer.
 */
export function resolvePermissionMode(
  config: Pick<MultiClawConfig, "permissions" | "defaults">,
  agent?: Pick<AgentDefinition, "permissions">
): PermissionMode | undefined {
  return agent?.permissions?.mode ?? config.permissions?.mode ?? config.defaults?.permissions?.mode
}
