export type ToolName =
  | "Read"
  | "Write"
  | "Edit"
  | "MultiEdit"
  | "Bash"
  | "Glob"
  | "Grep"
  | "WebFetch"

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
  taskTitle?: string
  agentScope?: string
  agentPlan?: string
  tools?: ToolName[]
  dependsOn?: string[]
  timeout?: number
  retries?: number
  workDir?: string
}

export type AgentStatus = "pending" | "running" | "retrying" | "success" | "failed" | "skipped"

export interface AgentResult {
  agentId: string
  agentName: string
  status: AgentStatus
  output: string
  duration: number
  attempts: number
  error?: string
  startTime: string
  endTime: string
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
