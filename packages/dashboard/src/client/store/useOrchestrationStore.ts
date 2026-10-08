import { create } from "zustand"
import type { MultiClawEvent, StageInfo, AgentStatus } from "@multiclaw/core"

const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")

interface AgentState {
  id: string
  name: string
  icon?: string
  status: AgentStatus
  duration?: number
  logs: string
}

interface OrchestrationState {
  name: string
  running: boolean
  success?: boolean
  totalDuration?: number
  stages: StageInfo[]
  agents: Record<string, AgentState>
  apply: (e: MultiClawEvent) => void
}

export const useOrchestrationStore = create<OrchestrationState>((set) => ({
  name: "",
  running: false,
  stages: [],
  agents: {},
  apply: (e) => set((state) => {
    const agents = { ...state.agents }
    switch (e.type) {
      case "orchestration:start": {
        const map: Record<string, AgentState> = {}
        for (const stage of e.payload.stages) {
          for (const a of stage.agents) {
            map[a.id] = { id: a.id, name: a.name, icon: a.icon, status: "pending", logs: "" }
          }
        }
        return { name: e.payload.name, running: true, stages: e.payload.stages, agents: map }
      }
      case "agent:start":
        agents[e.payload.agentId] = { ...agents[e.payload.agentId], status: "running" }
        return { agents }
      case "agent:output":
        agents[e.payload.agentId] = {
          ...agents[e.payload.agentId],
          logs: (agents[e.payload.agentId]?.logs ?? "") + stripAnsi(e.payload.chunk),
        }
        return { agents }
      case "agent:retrying":
        agents[e.payload.agentId] = {
          ...agents[e.payload.agentId],
          status: "retrying",
          logs: (agents[e.payload.agentId]?.logs ?? "") + `\n🔄 第 ${e.payload.attempt} 次重试 (共 ${e.payload.maxAttempts} 次)...\n`,
        }
        return { agents }
      case "agent:complete":
        agents[e.payload.agentId] = {
          ...agents[e.payload.agentId], status: "success", duration: e.payload.duration,
        }
        return { agents }
      case "agent:failed":
        agents[e.payload.agentId] = {
          ...agents[e.payload.agentId], status: "failed", duration: e.payload.duration,
        }
        return { agents }
      case "agent:skipped":
        agents[e.payload.agentId] = {
          ...agents[e.payload.agentId], status: "skipped",
        }
        return { agents }
      case "orchestration:complete":
        return { running: false, success: e.payload.success, totalDuration: e.payload.totalDuration }
      default:
        return {}
    }
  }),
}))
