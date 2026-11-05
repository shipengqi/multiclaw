import { leader } from "../agents/leader"
import type { AgentDefinition } from "../types/agent"

export const COORDINATOR_ID = "__coordinator"

/** Fixed host role; callers can choose project runtime defaults, never override this role. */
export function coordinatorAgent(): AgentDefinition {
  const routing = leader()
  return {
    id: COORDINATOR_ID,
    name: "Coordinator",
    runtime: "acp",
    systemPrompt:
      routing.systemPrompt +
      "\nYou are the permanent conversation coordinator. Never edit files or execute commands. In chat mode use the supplied live facts; a delivered message is not proof of implementation. Do not claim acceptance for an older requirement. Follow the contract of the current phase.",
    taskPrompt: "{{coordinatorRequest}}",
    permissions: { mode: "deny" },
  }
}
