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

/**
 * Shallow validation: could the panes render this as a turn?
 *
 * Deliberately not exhaustive. The file is written by this program and, at most,
 * hand-edited by a user who is on their own if they get it wrong. What it has to
 * reject is anything that would throw later — `null`, a bare number, an object
 * with no `turn` — so a single corrupted entry costs that one turn instead of
 * the whole file.
 */
function isTurnView(value: unknown): value is TurnView {
  if (typeof value !== "object" || value === null) return false
  const turn = value as Partial<TurnView>
  return typeof turn.turn === "number" && typeof turn.phase === "string"
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
