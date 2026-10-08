import type { AgentDefinition } from "./agent"

export interface MultiClawConfig {
  name: string
  workDir: string
  leader?: AgentDefinition
  agents: AgentDefinition[]
  context?: Record<string, string>
  logDir?: string
  continueOnError?: boolean
  maxConcurrency?: number
  dashboard?: {
    port?: number
    autoOpen?: boolean
  }
}

export interface OrchestratorResult {
  name: string
  success: boolean
  totalDuration: number
  agentResults: import("./agent").AgentResult[]
  startTime: string
  endTime: string
}
