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
   * Set when the run was stopped via its AbortSignal. Cancellation is a third
   * outcome, not a flavour of failure: the team stopped because it was told to.
   * It still reports `success: false` — a run that never finished must not exit
   * 0 — but the console says "cancelled" rather than "failed", and the CLI can
   * exit with the conventional 130.
   */
  cancelled?: boolean
  /**
   * Set when the turn ended in words instead of a pipeline — the leader answered
   * or asked a question, so no agent ran. Without it, "the team worked and
   * succeeded" and "nobody worked" look identical: both are `success: true` with
   * an empty `agentResults`.
   */
  reply?: LeaderMessage
}
