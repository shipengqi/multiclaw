export type ToolName =
  | "Read" | "Write" | "Edit" | "MultiEdit"
  | "Bash" | "Glob" | "Grep" | "WebFetch"

export interface AgentDefinition {
  id: string
  name: string
  icon?: string
  runtime?: string
  systemPrompt: string
  taskPrompt: string
  tools?: ToolName[]
  dependsOn?: string[]
  timeout?: number
  retries?: number
  workDir?: string
}

export type AgentStatus =
  | "pending" | "running" | "retrying" | "success" | "failed" | "skipped"

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
