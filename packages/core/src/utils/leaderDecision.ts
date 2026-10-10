import type { LeaderDecision } from "../types/leader"
import { extractJsonObjects } from "./json"

/**
 * Read the leader's decision out of its raw output.
 *
 * The leader is asked for a bare JSON object, but a model will happily wrap it in
 * prose or markdown fences, so every object in the text is considered in order
 * and the first one that reads as a decision wins.
 *
 * `{"run": [...]}` with no `mode` is still accepted as a run: the field was added
 * after the shape was, and a model that forgets it has named the agents it wants
 * all the same.
 *
 * Returns `undefined` when nothing parses. That is deliberately *not* an error —
 * the caller treats it as the leader having answered in prose, which is exactly
 * what a reply looks like.
 */
export function parseLeaderDecision(text: string): LeaderDecision | undefined {
  for (const value of extractJsonObjects(text)) {
    const decision = asDecision(value)
    if (decision) return decision
  }
  return undefined
}

function asDecision(value: unknown): LeaderDecision | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const mode = record.mode

  if (mode === "reply" || mode === "ask") {
    const message = typeof record.message === "string" ? record.message.trim() : ""
    // An empty answer is not an answer. Falling through lets a later object in
    // the same output be considered.
    return message ? { mode, message } : undefined
  }

  if (mode === "run" || mode === undefined) {
    const run = record.run
    if (!Array.isArray(run) || !run.every((id) => typeof id === "string")) return undefined
    return { mode: "run", run }
  }

  return undefined
}
