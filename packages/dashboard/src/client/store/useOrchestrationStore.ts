import { create } from "zustand"
import type { MultiClawEvent, StageInfo, AgentStatus } from "@multiclawcli/core"

const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")

interface AgentState {
  id: string
  name: string
  icon?: string
  model?: string
  taskTitle?: string
  status: AgentStatus
  duration?: number
  logs: string
}

interface OrchestrationState {
  name: string
  requirement?: string
  running: boolean
  success?: boolean
  totalDuration?: number
  stages: StageInfo[]
  agents: Record<string, AgentState>
  // Agents that completed before orchestration:start (e.g. leader)
  preflightBuffer: Record<string, AgentState>
  preflightAgentIds: string[]
  apply: (e: MultiClawEvent) => void
}

export const useOrchestrationStore = create<OrchestrationState>((set) => ({
  name: "",
  requirement: undefined,
  running: false,
  stages: [],
  agents: {},
  preflightBuffer: {},
  preflightAgentIds: [],
  apply: (e) => set((state) => {
    switch (e.type) {
      case "orchestration:start": {
        // Move pre-flight agents (e.g. leader) into the main agents map
        const preflightAgentIds = Object.keys(state.preflightBuffer)
        const map: Record<string, AgentState> = { ...state.preflightBuffer }
        for (const stage of e.payload.stages) {
          for (const a of stage.agents) {
            map[a.id] = { id: a.id, name: a.name, icon: a.icon, model: a.model, taskTitle: a.taskTitle, status: "pending", logs: "" }
          }
        }
        return {
          name: e.payload.name, requirement: e.payload.requirement, running: true,
          stages: e.payload.stages, agents: map,
          preflightBuffer: {}, preflightAgentIds,
        }
      }
      case "agent:start": {
        const agentId = e.payload.agentId
        // If already a known pipeline agent, update in place
        if (agentId in state.agents) {
          return { agents: { ...state.agents, [agentId]: { ...state.agents[agentId], status: "running" } } }
        }
        // Otherwise buffer as pre-flight (will be merged at orchestration:start)
        const existing = state.preflightBuffer[agentId]
        return {
          preflightBuffer: {
            ...state.preflightBuffer,
            [agentId]: existing
              ? { ...existing, status: "running" }
              : { id: agentId, name: e.payload.agentName, icon: e.payload.icon, model: e.payload.model, taskTitle: e.payload.taskTitle, status: "running", logs: "" },
          },
        }
      }
      case "agent:output": {
        const { agentId, chunk } = e.payload
        const text = stripAnsi(chunk)
        if (agentId in state.agents) {
          const a = state.agents[agentId]
          return { agents: { ...state.agents, [agentId]: { ...a, logs: a.logs + text } } }
        }
        if (agentId in state.preflightBuffer) {
          const a = state.preflightBuffer[agentId]
          return { preflightBuffer: { ...state.preflightBuffer, [agentId]: { ...a, logs: a.logs + text } } }
        }
        return {}
      }
      case "agent:retrying": {
        const { agentId, attempt, maxAttempts } = e.payload
        const msg = `\n[retry] attempt ${attempt} of ${maxAttempts}...\n`
        if (agentId in state.agents) {
          const a = state.agents[agentId]
          return { agents: { ...state.agents, [agentId]: { ...a, status: "retrying", logs: a.logs + msg } } }
        }
        if (agentId in state.preflightBuffer) {
          const a = state.preflightBuffer[agentId]
          return { preflightBuffer: { ...state.preflightBuffer, [agentId]: { ...a, status: "retrying", logs: a.logs + msg } } }
        }
        return {}
      }
      case "agent:complete": {
        const { agentId, duration } = e.payload
        if (agentId in state.agents) {
          return { agents: { ...state.agents, [agentId]: { ...state.agents[agentId], status: "success", duration } } }
        }
        if (agentId in state.preflightBuffer) {
          return { preflightBuffer: { ...state.preflightBuffer, [agentId]: { ...state.preflightBuffer[agentId], status: "success", duration } } }
        }
        return {}
      }
      case "agent:failed": {
        const { agentId, duration } = e.payload
        if (agentId in state.agents) {
          return { agents: { ...state.agents, [agentId]: { ...state.agents[agentId], status: "failed", duration } } }
        }
        if (agentId in state.preflightBuffer) {
          return { preflightBuffer: { ...state.preflightBuffer, [agentId]: { ...state.preflightBuffer[agentId], status: "failed", duration } } }
        }
        return {}
      }
      case "agent:skipped": {
        const { agentId } = e.payload
        if (agentId in state.agents) {
          return { agents: { ...state.agents, [agentId]: { ...state.agents[agentId], status: "skipped" } } }
        }
        return {}
      }
      case "orchestration:complete":
        return { running: false, success: e.payload.success, totalDuration: e.payload.totalDuration }
      default:
        return {}
    }
  }),
}))
