import type { AgentDefinition } from "../types/agent"
import type { AgentRuntime, AgentTask, AgentOutput } from "../types/runtime"

/** Build a minimal AgentDefinition, overriding only what a test cares about. */
export function makeAgent(
  partial: Partial<AgentDefinition> & { id: string }
): AgentDefinition {
  return {
    name: partial.id,
    systemPrompt: "system",
    taskPrompt: "task",
    ...partial,
  }
}

/** A stub runtime whose `execute` behaviour is supplied per-test. */
export function fakeRuntime(
  name: string,
  execute: (task: AgentTask) => Promise<AgentOutput>
): AgentRuntime {
  return {
    name,
    checkAvailable: async () => true,
    execute,
  }
}
