import type { AgentDefinition } from "../types/agent"
import type { AgentOutput, AgentRuntime, AgentTask, RuntimeCapabilities } from "../types/runtime"

/** Build a minimal AgentDefinition, overriding only what a test cares about. */
export function makeAgent(partial: Partial<AgentDefinition> & { id: string }): AgentDefinition {
  return {
    name: partial.id,
    systemPrompt: "system",
    taskPrompt: "task",
    ...partial,
  }
}

/** A runtime that claims nothing beyond being present. */
const NO_CAPABILITIES: RuntimeCapabilities = {
  streaming: false,
  sessions: false,
  resume: false,
  permissions: false,
  tools: false,
  models: false,
  images: false,
  usage: false,
  cost: false,
  sandbox: false,
}

/** A stub runtime whose `execute` behaviour is supplied per-test. */
export function fakeRuntime(
  name: string,
  execute: (task: AgentTask) => Promise<AgentOutput>
): AgentRuntime {
  return {
    name,
    describe: async () => ({
      name,
      available: true,
      capabilities: { ...NO_CAPABILITIES },
    }),
    execute,
  }
}
