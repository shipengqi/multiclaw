import type { AgentDefinition } from "../types/agent"
import type { AgentOutput, AgentRuntime, AgentTask, RuntimeCapabilities } from "../types/runtime"
import { sessionCompatibilityKey } from "../utils/session"

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

/** Test Session facts with a real compatibility digest, never an inferred ID. */
export function makeSessionRecord(
  overrides: Partial<import("../types/session").SessionRecord> = {},
  task: Partial<AgentTask> = {}
): import("../types/session").SessionRecord {
  const record = {
    bindingId: "test-binding",
    agentId: "a",
    runtime: "test-fake",
    state: "idle" as const,
    action: "created" as const,
    sessionId: "session-1",
    capabilities: { continuation: true, load: true, supplement: false },
    compatibilityKey: "",
    observedAt: "2026-11-02T00:00:00Z",
    ...overrides,
  }
  record.compatibilityKey =
    overrides.compatibilityKey ??
    sessionCompatibilityKey(
      { name: record.runtime },
      {
        agentId: record.agentId,
        provider: "opencode",
        command: "opencode",
        args: ["acp"],
        model: "opencode/big-pickle",
        systemPrompt: "system",
        prompt: "task",
        timeout: 1000,
        ...task,
        workDir: task.workDir ?? "/tmp",
      }
    )
  return record
}
