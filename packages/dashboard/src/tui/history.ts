import * as fs from "node:fs"
import * as path from "node:path"
import { MAX_HISTORY, type TurnView } from "./state"

/** Directory, under a workspace's `.multiclaw/`, that holds console state. */
export const CONSOLE_DIR = "console"

/** The finished-turn record the console keeps across sessions. */
export const HISTORY_FILE = "history.json"

/** Where exported turn markdown files are written by default. */
export const EXPORT_DIR = "exports"

/** Where the console keeps its turn history for a workspace. */
export function historyPath(workDir: string): string {
  return path.join(workDir, ".multiclaw", CONSOLE_DIR, HISTORY_FILE)
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
    (turn.acceptance === undefined || isAcceptance(turn.acceptance)) &&
    (turn.effectiveRequirement === undefined || typeof turn.effectiveRequirement === "string") &&
    isObject(turn.agents) &&
    Object.values(turn.agents).every(isObject) &&
    Array.isArray(turn.stages) &&
    turn.stages.every(
      (stage) =>
        isObject(stage) &&
        (stage.outcome === undefined ||
          ["pending", "running", "retrying", "success", "failed", "cancelled", "skipped"].includes(
            stage.outcome
          )) &&
        (stage.memberStatuses === undefined ||
          (isObject(stage.memberStatuses) &&
            Object.values(stage.memberStatuses).every(
              (status) =>
                typeof status === "string" &&
                [
                  "pending",
                  "running",
                  "retrying",
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
 * Read the workspace's turn history.
 *
 * Synchronous on purpose: it runs once, inside the reducer's lazy initialiser,
 * before the first frame. An async load would race the user's first keystroke
 * and force a "history is still arriving" state the console does not need.
 *
 * Never throws. A missing directory, malformed JSON, or a value of the wrong
 * shape all mean "no history": the console can always start from empty, and
 * crashing on startup because a side file got corrupted would be far worse.
 */
export function loadHistory(workDir: string): TurnView[] {
  try {
    const raw = fs.readFileSync(historyPath(workDir), "utf-8")
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Keep only the entries that survive validation; a hand-edited or
    // older-version file may also exceed the cap, so keep the newest.
    return parsed.filter(isTurnView).slice(-MAX_HISTORY)
  } catch {
    return []
  }
}

/**
 * Write the workspace's turn history.
 *
 * Written to a temp file and renamed into place: `rename` is atomic within a
 * filesystem, so a crash mid-write leaves the *previous* file intact. Writing
 * `history.json` directly would instead leave half a JSON document, and since
 * `loadHistory` can only drop a file it cannot parse, that would cost the user
 * *all* of their history rather than the last write.
 */
const historyWrites = new Map<string, Promise<void>>()

export function saveHistory(workDir: string, turns: readonly TurnView[]): Promise<void> {
  const target = historyPath(workDir)
  const json = JSON.stringify(turns)
  // Serialize writes to one workspace: rapid turns must not rename the same
  // temporary file out from under each other or overwrite newer history.
  const write = (historyWrites.get(target) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      const tmp = `${target}.tmp`
      await fs.promises.writeFile(tmp, json, "utf-8")
      await fs.promises.rename(tmp, target)
    })
  historyWrites.set(target, write)
  void write
    .finally(() => {
      if (historyWrites.get(target) === write) historyWrites.delete(target)
    })
    .catch(() => {})
  return write
}

export function exportPath(workDir: string, turn: number): string {
  return path.join(workDir, ".multiclaw", CONSOLE_DIR, EXPORT_DIR, `turn-${turn}.md`)
}

export async function exportTurn(turn: TurnView, filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, formatTurnMarkdown(turn), "utf-8")
}

export function formatTurnMarkdown(turn: TurnView): string {
  const lines: string[] = [`# Turn ${turn.turn}`, ""]
  if (turn.requirement) lines.push("## Requirement", "", turn.requirement, "")
  if (turn.reply) {
    lines.push("## Reply", "", `_${turn.reply.mode}_`, "", turn.reply.message, "")
  } else {
    const acceptance = turn.acceptance
    const status = acceptance
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
  const agents = Object.values(turn.agents)
  if (agents.length > 0) {
    lines.push("## Agents", "")
    for (const agent of agents) {
      lines.push(`- ${agent.id}: ${agent.name} — ${agent.status}`)
    }
    lines.push("")
    lines.push("## Logs", "")
    for (const agent of agents) {
      lines.push(`### ${agent.id}: ${agent.name}`, "", "```", agent.logs ?? "", "```", "")
    }
  }
  return `${lines.join("\n").trimEnd()}\n`
}
