import type { AgentDefinition } from "./agent"
import type { LeaderMessage } from "./leader"

/**
 * One finished turn of a session, as dialogue the leader can read back.
 *
 * A requirement alone is not always interpretable: when the leader asked "which
 * database?" and the user answered "Postgres", turn two's requirement is the
 * bare word "Postgres". Paired with the turn that produced the question it is
 * obvious; on its own it is not.
 */
export interface TurnRecord {
  /** What the user asked for. */
  requirement: string
  /** How the turn ended in words, when it ended that way. */
  reply?: LeaderMessage
}

export interface MultiClawConfig {
  name: string
  workDir: string
  leader?: AgentDefinition
  agents: AgentDefinition[]
  context?: Record<string, string>
  /**
   * Earlier turns of this session, oldest first.
   *
   * Core has no notion of a session — the orchestrator is built fresh per turn —
   * so whoever runs several turns in a row (the console) is the one that has to
   * carry them. Rendered into the leader's prompt; a single-turn run leaves it
   * unset and sees no conversation at all.
   */
  history?: TurnRecord[]
  logDir?: string
  continueOnError?: boolean
  maxConcurrency?: number
  useLeader?: boolean
  /**
   * Project-level defaults applied to every agent that does not override them.
   * Keeps generated configs readable: one line instead of 12 repeated parameters.
   */
  defaults?: {
    provider?: string
    model?: string
    command?: string
  }
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
