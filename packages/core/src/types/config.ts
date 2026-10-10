import type { AgentDefinition } from "./agent"
import type { LeaderMessage } from "./leader"

export interface MultiClawConfig {
  name: string
  workDir: string
  leader?: AgentDefinition
  agents: AgentDefinition[]
  context?: Record<string, string>
  logDir?: string
  continueOnError?: boolean
  maxConcurrency?: number
  useLeader?: boolean
}

export interface OrchestratorResult {
  name: string
  success: boolean
  totalDuration: number
  agentResults: import("./agent").AgentResult[]
  startTime: string
  endTime: string
  /**
   * Set when the turn ended in words instead of a pipeline — the leader answered
   * or asked a question, so no agent ran. Without it, "the team worked and
   * succeeded" and "nobody worked" look identical: both are `success: true` with
   * an empty `agentResults`.
   */
  reply?: LeaderMessage
}
