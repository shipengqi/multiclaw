import type { AgentOutput } from "./runtime"

/**
 * How a runtime answers a provider's tool-permission request.
 *
 * `auto` approves every request, `ask` hands it to a human (and refuses when
 * nobody is listening), `deny` refuses every request.
 */
export type PermissionMode = "auto" | "ask" | "deny"

export interface AgentDefinition {
  id: string
  name: string
  icon?: string
  runtime?: string
  /**
   * Agent product (e.g. "claude", "opencode", "codex", "cursor").
   * Distinct from `runtime` (the protocol, always "acp" today).
   * When absent it is inferred from `command` or config defaults.
   */
  provider?: string
  /**
   * Command to launch for this agent's runtime, when the runtime talks to an
   * external process (e.g. ACP). Generic — "which binary to start", not a
   * protocol detail — so a built-in runtime simply ignores it.
   */
  command?: string
  /** Arguments for {@link command}. */
  args?: string[]
  model?: string
  /**
   * Map of provider ids (or the legacy alias "acp") to model names.
   * Provider id is preferred; "acp" is kept for backward compatibility.
   */
  models?: Partial<Record<string, string>>
  /**
   * Model tier preference. Used when `model` and `models` are absent.
   * The catalog maps each tier to a provider-specific model id.
   */
  modelTier?: "strong" | "balanced" | "fast"
  systemPrompt: string
  taskPrompt: string
  /**
   * One-line role, for display. Every built-in agent declares one.
   *
   * Distinct from {@link taskTitle}, which the orchestrator fills in per turn
   * from the leader's task plan — "what this agent was asked to do *this* run".
   * A `description` is "what this agent is for", so it is the one that is still
   * available before the first turn has been planned.
   */
  description?: string
  /**
   * Marks the agent that owns task decomposition (writes task-plan.json).
   * When absent, the orchestrator falls back to the id "architect" so every
   * existing config keeps working unchanged.
   */
  role?: "planner"
  taskTitle?: string
  agentScope?: string
  agentPlan?: string
  permissions?: { mode: PermissionMode }
  dependsOn?: string[]
  /** Per-attempt timeout in ms. Defaults to 1,800,000 (30 minutes); can be increased. */
  timeout?: number
  retries?: number
  workDir?: string
}

export type AgentStatus =
  | "pending"
  | "running"
  | "retrying"
  | "handed_back"
  | "success"
  | "failed"
  /**
   * The run was stopped by its AbortSignal rather than finishing or erroring.
   * Distinct from `failed` so a Ctrl-C does not read as a crash, and so the
   * roster can mark the agent stopped instead of broken.
   */
  | "cancelled"
  | "skipped"

export interface AgentResult {
  revision?: number
  handoffReason?: string
  agentId: string
  agentName: string
  status: AgentStatus
  output: string
  duration: number
  attempts: number
  error?: string
  startTime: string
  endTime: string
  /** Model actually requested for this agent. */
  model?: string
  /** Context-window usage the runtime reported; absent when it reported none. */
  usage?: AgentOutput["usage"]
  /** USD cost the runtime reported; absent when the provider does not price in USD. */
  costUsd?: number
  /** Reliable Session facts, including on failed and cancelled executions. */
  session?: import("./session").SessionRecord
}

export interface SubTask {
  id: string // matches AgentDefinition.id
  title: string
  scope: string
  plan?: string[]
  dependsOn?: string[]
}

export interface TaskPlan {
  projectName: string
  requirement: string
  tasks: SubTask[]
}
