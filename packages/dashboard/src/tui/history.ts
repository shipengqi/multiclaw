import * as fs from "node:fs"
import * as path from "node:path"
import { describeSession, isSessionEvent, isSessionRecord, isWorkContext } from "@multiclawcli/core"
import { appendLines } from "./atomic"
import { sessionDir } from "./sessions"
import { MAX_HISTORY, type TurnView } from "./state"

/** The finished-turn log a session keeps, one JSON turn per line. */
export const TURNS_FILE = "turns.jsonl"

/** Where exported turn markdown files are written by default. */
export const EXPORT_DIR = "exports"

/** Where a session keeps its finished turns. */
export function turnsPath(workDir: string, sessionId: string): string {
  return path.join(sessionDir(workDir, sessionId), TURNS_FILE)
}

/** True for a non-null object — the shape every element the panes walk must have. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isAcceptance(value: unknown): boolean {
  if (!isObject(value)) return false
  return (
    typeof value.status === "string" &&
    ["approved", "changes_required", "failed", "cancelled"].includes(value.status) &&
    typeof value.reviewer === "string" &&
    Number.isInteger(value.repairRounds) &&
    (value.repairRounds as number) >= 0 &&
    (value.reason === undefined || typeof value.reason === "string") &&
    Array.isArray(value.reviews) &&
    value.reviews.every(
      (review: unknown) =>
        isObject(review) &&
        (review.verdict === "approved" || review.verdict === "changes_required") &&
        typeof review.summary === "string" &&
        Array.isArray(review.issues) &&
        review.issues.every((issue: unknown) => typeof issue === "string")
    )
  )
}

/**
 * Is this a turn the panes can actually render?
 *
 * It validates the shapes the panes *walk*, not every field. The top level, and
 * the elements of the two collections they iterate, are checked because a `null`
 * element throws: `progress()` runs `Object.values(turn.agents)` and reads
 * `a.status`, and `railCellWidths` iterates `stage.agents` and reads
 * `agent.name`. Leaf fields are trusted — this file is written by this program
 * with an atomic write, and a field-by-field schema of `TurnView` would be a
 * second definition of the type that could drift from the real one. An empty
 * object is safe (`a.status` is `undefined`, `SETTLED.has(undefined)` is false,
 * and `agent?.logs ?` guards the log read), so the elements are required to be
 * objects, not to carry fields. A single bad entry costs that one turn, not the
 * whole file.
 */
function isTurnView(value: unknown): value is TurnView {
  if (!isObject(value)) return false
  const turn = value as Partial<TurnView>
  return (
    typeof turn.turn === "number" &&
    typeof turn.phase === "string" &&
    (turn.cancelled === undefined || typeof turn.cancelled === "boolean") &&
    (turn.interrupted === undefined || typeof turn.interrupted === "boolean") &&
    (turn.work === undefined || isWorkContext(turn.work)) &&
    (turn.sessionEvents === undefined ||
      (Array.isArray(turn.sessionEvents) && turn.sessionEvents.every(isSessionEvent))) &&
    (turn.acceptance === undefined || isAcceptance(turn.acceptance)) &&
    (turn.effectiveRequirement === undefined || typeof turn.effectiveRequirement === "string") &&
    isObject(turn.agents) &&
    Object.values(turn.agents).every(
      (agent) => isObject(agent) && (agent.session === undefined || isSessionRecord(agent.session))
    ) &&
    Array.isArray(turn.stages) &&
    turn.stages.every(
      (stage) =>
        isObject(stage) &&
        (stage.outcome === undefined ||
          [
            "pending",
            "running",
            "retrying",
            "handed_back",
            "success",
            "failed",
            "cancelled",
            "skipped",
          ].includes(stage.outcome)) &&
        (stage.memberStatuses === undefined ||
          (isObject(stage.memberStatuses) &&
            Object.values(stage.memberStatuses).every(
              (status) =>
                typeof status === "string" &&
                [
                  "pending",
                  "running",
                  "retrying",
                  "handed_back",
                  "success",
                  "failed",
                  "cancelled",
                  "skipped",
                ].includes(status)
            )))
    ) &&
    Array.isArray(turn.leaderIds)
  )
}

/**
 * Read a session's turn history.
 *
 * Synchronous on purpose: it runs once, inside the reducer's lazy initialiser,
 * before the first frame. An async load would race the user's first keystroke
 * and force a "history is still arriving" state the console does not need.
 *
 * Never throws. A missing directory, malformed JSON, or a value of the wrong
 * shape all mean "no history": the console can always start from empty, and
 * crashing on startup because a side file got corrupted would be far worse. The
 * log is line-oriented, so a single torn line (a crash mid-append) is skipped
 * rather than costing the whole session's history.
 */
export function loadTurns(workDir: string, sessionId: string): TurnView[] {
  try {
    const raw = fs.readFileSync(turnsPath(workDir, sessionId), "utf-8")
    const turns: TurnView[] = []
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isTurnView(parsed)) turns.push(parsed)
      } catch {
        // A torn or hand-mangled line costs that one turn, not the whole log.
      }
    }
    // A hand-edited or very long session may exceed the cap, so keep the newest.
    return turns.slice(-MAX_HISTORY)
  } catch {
    return []
  }
}

/**
 * Append finished turns to a session's log, one JSON object per line.
 *
 * Append-only and serialized per path (see {@link appendLines}): each settled
 * turn is an O(1) write rather than a rewrite of the whole history, and a crash
 * mid-append can only tear the last line, which {@link loadTurns} skips. Callers
 * pass only the turns not yet persisted, tracked by the highest turn number
 * already written.
 */
export function appendTurns(
  workDir: string,
  sessionId: string,
  turns: readonly TurnView[]
): Promise<void> {
  if (turns.length === 0) return Promise.resolve()
  return appendLines(
    turnsPath(workDir, sessionId),
    turns.map((turn) => JSON.stringify(turn))
  )
}

export function exportPath(workDir: string, sessionId: string, turn: number): string {
  return path.join(sessionDir(workDir, sessionId), EXPORT_DIR, `turn-${turn}.md`)
}

export async function exportTurn(turn: TurnView, filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, formatTurnMarkdown(turn), "utf-8")
}

export function formatTurnMarkdown(turn: TurnView): string {
  const lines: string[] = [`# Turn ${turn.turn}`, ""]
  if (turn.requirement) lines.push("## Requirement", "", turn.requirement, "")
  if (turn.effectiveRequirement && turn.effectiveRequirement !== turn.requirement)
    lines.push("## Complete requirement", "", turn.effectiveRequirement, "")
  if (turn.routing) {
    lines.push(
      "## Routing",
      "",
      "Type: " + turn.routing.mode,
      "Work: " + (turn.routing.workId ?? "none"),
      "Reroutes: " + turn.routing.reroutes,
      ""
    )
    if (turn.routing.error) lines.push("Incomplete: " + turn.routing.error, "")
  }
  if (turn.agentResults?.length) {
    lines.push("## Execution attempts", "")
    for (const result of turn.agentResults)
      lines.push(
        "- " +
          result.agentId +
          ": " +
          result.status +
          (result.handoffReason ? " — " + result.handoffReason : "") +
          (result.error ? " — " + result.error : "")
      )
    lines.push("")
  }
  if (turn.reply) {
    lines.push("## Reply", "", `_${turn.reply.mode}_`, "", turn.reply.message, "")
  } else {
    const acceptance = turn.acceptance
    const status = turn.interrupted
      ? "interrupted"
      : acceptance
        ? acceptance.status === "failed"
          ? "acceptance failed"
          : acceptance.status === "cancelled"
            ? "acceptance cancelled"
            : acceptance.status.replace("_", " ")
        : turn.cancelled
          ? "cancelled"
          : turn.success
            ? "success"
            : "failed"
    lines.push("## Result", "", `Status: ${status}`, "")
    if (acceptance) {
      lines.push(
        `Reviewer: ${acceptance.reviewer}`,
        `Repair rounds: ${acceptance.repairRounds}`,
        ""
      )
      if (acceptance.reason) lines.push(acceptance.reason, "")
      for (const review of acceptance.reviews) {
        lines.push(`### Review: ${review.verdict.replace("_", " ")}`, "", review.summary, "")
        for (const issue of review.issues) lines.push(`- ${issue}`)
        lines.push("")
      }
    }
  }
  if (turn.sessionEvents?.length) {
    lines.push("## Session lifecycle", "")
    for (const event of turn.sessionEvents)
      lines.push(
        "- " +
          event.record.agentId +
          ": " +
          event.action +
          (event.requestedSessionId ? " target=" + event.requestedSessionId : "") +
          " — " +
          describeSession(event.record) +
          (event.reason ? " — " + event.reason : "")
      )
    lines.push("")
  }
  const agents = Object.values(turn.agents)
  if (agents.length > 0) {
    lines.push("## Agents", "")
    for (const agent of agents) {
      lines.push(`- ${agent.id}: ${agent.name} — ${agent.status}`)
      if (agent.session) lines.push("  " + describeSession(agent.session))
    }
    lines.push("")
    lines.push("## Logs", "")
    for (const agent of agents) {
      const logsText = agent.logs.map((s) => s.text).join("")
      lines.push(`### ${agent.id}: ${agent.name}`, "", "```", logsText ?? "", "```", "")
    }
  }
  return `${lines.join("\n").trimEnd()}\n`
}
