/**
 * What a resume or retry will actually do, in words.
 *
 * `config.resume` runs the agents it names and nothing else, which changes two
 * things silently: an agent continues the ACP session it reported last time
 * only when a session id is handed back for it, and a `dependsOn` that points
 * outside the resumed set is pruned so the agent can run at all. Retrying one
 * failed agent therefore re-runs a *different* pipeline from the one that
 * failed, with nothing saying so — this is that sentence.
 *
 * The pruning rule mirrors `Orchestrator.selectAgents`: a dependency counts as
 * dropped when it names a *configured* agent that is not being resumed. A
 * dependency on an id that is not configured at all is left in place by core
 * and breaks the stage ordering in every run equally — a config bug, not
 * something a retry changes, so it is not reported here.
 */
export interface ResumePlan {
  /** Ids that will run, in the order the caller named them. */
  agents: readonly string[]
  /** Agent id → the session id to continue, for the agents that reported one. */
  sessions?: Readonly<Record<string, string>>
  /** The team the ids were chosen from; supplies each agent's dependencies. */
  team: readonly { id: string; dependsOn?: readonly string[] }[]
}

/**
 * One clause per agent — `dev starts fresh`, `reviewer continues its session` —
 * followed by one clause per agent whose dependencies were pruned.
 *
 * Deliberately a description, not a plan: what actually runs stays core's
 * decision (`selectAgents`), and this only reports it.
 */
export function describeResumePlan({ agents, sessions = {}, team }: ResumePlan): string {
  const teamById = new Map(team.map((member) => [member.id, member]))
  const running = new Set(agents)

  const clauses = agents.map((id) =>
    sessions[id] ? `${id} continues its session` : `${id} starts fresh`
  )
  for (const id of agents) {
    const dropped = (teamById.get(id)?.dependsOn ?? []).filter(
      (dep) => teamById.has(dep) && !running.has(dep)
    )
    if (dropped.length > 0) clauses.push(`${id} runs without ${dropped.join(", ")}`)
  }
  return clauses.join("; ")
}
