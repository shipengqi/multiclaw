import type { AgentDefinition } from "./agent"
import type { LeaderMessage } from "./leader"
import type { RuntimePermissionHandler, RuntimeQuestionHandler } from "./runtime"

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
  /** Observed execution and acceptance facts; absent in older caller-provided history. */
  outcome?: TurnOutcome
}

/** Compact facts for the next leader turn, not a model-generated summary or retry instruction. */
export interface TurnOutcome {
  execution: "success" | "failed" | "cancelled" | "interrupted" | "unknown"
  completedAgents: string[]
  failedAgents: { agentId: string; reason?: string }[]
  acceptance?: { status: AcceptanceResult["status"]; reason?: string }
}

export interface ReviewPolicy {
  /** Configured agent reserved for final review, outside the normal pipeline. */
  reviewer: string
  /** Configured workers allowed to repair, in dependency order. */
  repairAgents: string[]
  /** Maximum repair passes (0–5); defaults to 1. Review runs once more after each pass. */
  maxRepairRounds?: number
}

export interface ReviewVerdict {
  verdict: "approved" | "changes_required"
  summary: string
  issues: string[]
}

export interface AcceptanceResult {
  status: "approved" | "changes_required" | "failed" | "cancelled"
  reviewer: string
  repairRounds: number
  reviews: ReviewVerdict[]
  reason?: string
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
  /**
   * Re-run a known set of agents instead of letting the leader route, continuing
   * their sessions where one is known.
   *
   * Set by a resume/retry driver — the CLI's `--resume`, the console's `/retry` —
   * which already knows which agents to redo. Like `history`, it is per-run state
   * the caller carries: core has no session of its own, and a config that never
   * resumes leaves it unset and behaves exactly as before.
   */
  resume?: {
    /** Agent ids to run, in the order they were originally selected. */
    agents: string[]
    /** agentId → session id, for agents whose session is worth continuing. */
    sessions?: Record<string, string>
  }
  logDir?: string
  continueOnError?: boolean
  maxConcurrency?: number
  useLeader?: boolean
  /** Opt-in delivery gate. Execution success alone does not satisfy this policy. */
  review?: ReviewPolicy
  /** Caller-owned live approvals. Ask mode without a handler fails closed. */
  permissions?: {
    mode: "auto" | "ask" | "deny"
    onRequest?: RuntimePermissionHandler
  }
  /** Caller-owned structured questions; headless callers cancel explicitly. */
  questions?: {
    onRequest: RuntimeQuestionHandler
  }
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

export interface OrchestrationPreview {
  name: string
  requirement?: string
  totalAgents: number
  stages: import("./event").StageInfo[]
  /** Present when the leader answered or asked instead of choosing a pipeline. */
  reply?: LeaderMessage
  /** The leader's explanation for the agent set, when it gave one. */
  selectionReason?: string
}

export interface DeliverableSummary {
  /** Path relative to the run work directory. */
  path: string
  status: "created" | "modified"
  size: number
  modifiedAt: string
}

export interface OrchestratorResult {
  name: string
  /** With review enabled, true only when execution and delivery acceptance both succeed. */
  success: boolean
  /** Present only for a review-gated pipeline, never for a leader reply/ask. */
  acceptance?: AcceptanceResult
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
  /**
   * The leader's explanation for the agent set it selected, when it gave one.
   *
   * This is orchestration metadata, not agent state: it answers "why did this
   * turn run these agents?" without asking the leader again. Absent for a
   * resumed run, a leader-less run, and any leader that omitted the field.
   */
  selectionReason?: string
  /**
   * Sum of the per-agent costs that were actually reported, in USD.
   *
   * Present only when at least one agent reported a cost — "no data" is not the
   * same as "free", so a run in which nobody priced itself must leave this
   * `undefined` rather than reporting `0`.
   */
  totalCostUsd?: number
  /**
   * The requirement this turn was run for, when the caller supplied one.
   *
   * Carried on the result because the completion event *is* the report a resume
   * driver reads back: without it, a resumed run has no way to recover the
   * requirement it is continuing.
   */
  requirement?: string
  /** Files created or modified by this run, when the caller collected them. */
  deliverables?: DeliverableSummary[]
}
