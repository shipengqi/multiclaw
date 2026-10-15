import * as fs from "node:fs"
import * as path from "node:path"
import { MAX_HISTORY, type TurnView } from "./state"

/** Directory, under a workspace's `.multiclaw/`, that holds console state. */
export const CONSOLE_DIR = "console"

/** The finished-turn record the console keeps across sessions. */
export const HISTORY_FILE = "history.json"

/** Where the console keeps its turn history for a workspace. */
export function historyPath(workDir: string): string {
  return path.join(workDir, ".multiclaw", CONSOLE_DIR, HISTORY_FILE)
}

/** True for a non-null object — the shape every element the panes walk must have. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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
    isObject(turn.agents) &&
    Object.values(turn.agents).every(isObject) &&
    Array.isArray(turn.stages) &&
    turn.stages.every(isObject) &&
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
export async function saveHistory(workDir: string, turns: readonly TurnView[]): Promise<void> {
  const target = historyPath(workDir)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await fs.promises.writeFile(tmp, JSON.stringify(turns), "utf-8")
  await fs.promises.rename(tmp, target)
}
