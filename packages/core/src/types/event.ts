import type { AgentResult, OrchestratorResult } from "./index"

export interface StageInfo {
  stageIndex: number
  agents: Array<{ id: string; name: string; icon?: string; model?: string; taskTitle?: string }>
}

export type MultiClawEvent =
  | {
      type: "orchestration:start"
      timestamp: string
      payload: { name: string; requirement?: string; totalAgents: number; stages: StageInfo[] }
    }
  | { type: "orchestration:complete"; timestamp: string; payload: OrchestratorResult }
  | {
      type: "orchestration:warning"
      timestamp: string
      payload: { message: string }
    }
  | { type: "stage:start"; timestamp: string; payload: { stageIndex: number; agentIds: string[] } }
  | { type: "stage:complete"; timestamp: string; payload: { stageIndex: number } }
  | {
      type: "agent:start"
      timestamp: string
      payload: {
        agentId: string
        agentName: string
        icon?: string
        model?: string
        taskTitle?: string
      }
    }
  | { type: "agent:output"; timestamp: string; payload: { agentId: string; chunk: string } }
  | { type: "agent:complete"; timestamp: string; payload: AgentResult }
  | { type: "agent:failed"; timestamp: string; payload: AgentResult }
  | {
      type: "agent:skipped"
      timestamp: string
      payload: { agentId: string; agentName: string; icon?: string }
    }
  | {
      type: "agent:retrying"
      timestamp: string
      payload: {
        agentId: string
        agentName: string
        attempt: number
        maxAttempts: number
        error: string
      }
    }

export type EventListener = (event: MultiClawEvent) => void
