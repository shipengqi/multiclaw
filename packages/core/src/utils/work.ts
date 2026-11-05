import type { WorkContext } from "../types/config"
import { isSessionRecord } from "./session"

/** Validate persisted ownership and execution facts consumed by routing. */
export function isWorkContext(value: unknown): value is WorkContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const work = value as Record<string, unknown>
  if (
    (work.revision !== undefined &&
      (!Number.isInteger(work.revision) || Number(work.revision) < 1)) ||
    typeof work.id !== "string" ||
    !work.id.trim() ||
    typeof work.originalRequirement !== "string" ||
    typeof work.requirement !== "string" ||
    !Array.isArray(work.agents)
  )
    return false
  if (
    !work.agents.every((item: unknown) => {
      if (typeof item !== "object" || item === null) return false
      const agent = item as Record<string, unknown>
      return (
        typeof agent.agentId === "string" &&
        !!agent.agentId.trim() &&
        ["scope", "plan", "taskTitle"].every(
          (key) => agent[key] === undefined || typeof agent[key] === "string"
        ) &&
        (agent.session === undefined ||
          (isSessionRecord(agent.session) &&
            agent.session.agentId === agent.agentId &&
            agent.session.workId === work.id)) &&
        (agent.dependsOn === undefined ||
          (Array.isArray(agent.dependsOn) && agent.dependsOn.every((id) => typeof id === "string")))
      )
    })
  )
    return false
  if (new Set(work.agents.map((item) => item.agentId)).size !== work.agents.length) return false
  if (work.outcome !== undefined) {
    if (typeof work.outcome !== "object" || work.outcome === null) return false
    const outcome = work.outcome as Record<string, unknown>
    if (
      !["success", "failed", "cancelled", "interrupted", "unknown"].includes(
        String(outcome.execution)
      ) ||
      !Array.isArray(outcome.completedAgents) ||
      !outcome.completedAgents.every((id) => typeof id === "string") ||
      !Array.isArray(outcome.failedAgents) ||
      !outcome.failedAgents.every(
        (item) =>
          item &&
          typeof item.agentId === "string" &&
          (item.reason === undefined || typeof item.reason === "string")
      )
    )
      return false
  }
  return true
}
