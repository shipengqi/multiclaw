/**
 * What the leader decided a request needs.
 *
 * The leader is the only agent that runs before the pipeline exists, which makes
 * it the only place where "does this even need the team?" can be answered. `run`
 * is the familiar case; the other two exist so that a greeting or a question is
 * answered instead of spinning up every agent in the config.
 */
export type LeaderMode = "run" | "reply" | "ask"

export type LeaderDecision =
  | {
      mode: "run"
      run: string[]
      /** Complete task combining the original goal with clarification constraints. */
      requirement?: string
      /**
       * Why these agents, in the leader's own words.
       *
       * Optional because the field was added after the decision shape was: a
       * model that omits it still gets its plan honoured. It exists so a user
       * can ask "why did this run only two agents?" and get an answer from the
       * run itself rather than from a re-run of the leader.
       */
      reason?: string
    }
  | { mode: "reply" | "ask"; message: string }

/**
 * A turn that ended in words rather than in a pipeline.
 *
 * Carried on {@link OrchestratorResult} so a caller can tell "the team ran and
 * succeeded" from "the leader answered you" — both of which are `success: true`
 * with an empty `agentResults`.
 */
export interface LeaderMessage {
  mode: "reply" | "ask"
  message: string
}
