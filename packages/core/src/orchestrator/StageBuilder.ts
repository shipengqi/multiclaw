import type { AgentDefinition } from "../types/agent"

export function buildStages(agents: AgentDefinition[]): AgentDefinition[][] {
  const stages: AgentDefinition[][] = []
  const completed = new Set<string>()
  let remaining = [...agents]

  const allIds = new Set(agents.map((a) => a.id))
  for (const a of agents) {
    for (const dep of a.dependsOn ?? []) {
      if (!allIds.has(dep)) {
        throw new Error(`Agent "${a.id}" depends on "${dep}" which does not exist`)
      }
    }
  }

  while (remaining.length > 0) {
    const stage = remaining.filter((a) =>
      (a.dependsOn ?? []).every((dep) => completed.has(dep))
    )
    if (stage.length === 0) {
      const ids = remaining.map((a) => a.id).join(", ")
      throw new Error(`Circular or unsatisfiable dependency detected: ${ids}`)
    }
    stages.push(stage)
    stage.forEach((a) => completed.add(a.id))
    remaining = remaining.filter((a) => !stage.includes(a))
  }
  return stages
}
