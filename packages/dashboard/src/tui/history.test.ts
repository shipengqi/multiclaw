import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CONSOLE_DIR, HISTORY_FILE, historyPath, loadHistory, saveHistory } from "./history"
import { MAX_HISTORY, type TurnView } from "./state"

/** A minimal well-formed turn, enough for a round-trip to be meaningful. */
function turn(n: number, patch: Partial<TurnView> = {}): TurnView {
  return {
    turn: n,
    phase: "complete",
    requirement: `req ${n}`,
    stages: [],
    agents: {},
    leaderIds: [],
    autoFollow: true,
    scroll: 0,
    ...patch,
  }
}

let workDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-history-"))
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

/** Write a raw value straight to the history file, bypassing `saveHistory`. */
function writeRaw(value: unknown): void {
  const target = historyPath(workDir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(value), "utf-8")
}

describe("historyPath", () => {
  it("points inside .multiclaw/console", () => {
    expect(historyPath("/work")).toBe(path.join("/work", ".multiclaw", "console", "history.json"))
    expect(CONSOLE_DIR).toBe("console")
    expect(HISTORY_FILE).toBe("history.json")
  })
})

describe("loadHistory", () => {
  it("returns an empty list when the file does not exist", () => {
    expect(loadHistory(workDir)).toEqual([])
  })

  it("returns an empty list on malformed JSON", () => {
    const target = historyPath(workDir)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, "{ not json", "utf-8")

    expect(loadHistory(workDir)).toEqual([])
  })

  it("returns an empty list when the JSON is not an array", () => {
    writeRaw({ version: 1 })

    expect(loadHistory(workDir)).toEqual([])
  })

  it("drops only the malformed entries and keeps the good ones", () => {
    const good = turn(1)
    // A hand-edited or older file can hold anything: `null`, a bare number, an
    // object missing `turn`, a string. Each bad entry goes, each good one stays.
    writeRaw([good, null, 7, { phase: "complete" }, "nope", turn(2)])

    expect(loadHistory(workDir)).toEqual([good, turn(2)])
  })

  // `turn` and `phase` are not enough to render a turn: the panes dereference
  // `agents` (via `progress`'s `Object.values`) and read `stages` / `leaderIds`
  // as lists for every listed turn. An entry missing any of them would throw
  // while rendering `/history`, so it must be dropped rather than kept.
  it("drops an entry missing a field the panes dereference", () => {
    const good = turn(1)
    writeRaw([
      good,
      { turn: 2, phase: "complete" },
      { turn: 3, phase: "complete", agents: {}, stages: [] },
      { turn: 4, phase: "complete", agents: null, stages: [], leaderIds: [] },
      { turn: 5, phase: "complete", agents: {}, stages: "nope", leaderIds: [] },
      { turn: 6, phase: "complete", agents: {}, stages: [], leaderIds: "nope" },
      { turn: 7, phase: 5, agents: {}, stages: [], leaderIds: [] },
    ])

    expect(loadHistory(workDir)).toEqual([good])
  })

  it("keeps only the last MAX_HISTORY entries", () => {
    writeRaw(Array.from({ length: MAX_HISTORY + 5 }, (_, i) => turn(i + 1)))

    const loaded = loadHistory(workDir)

    expect(loaded).toHaveLength(MAX_HISTORY)
    expect(loaded[0].turn).toBe(6)
    expect(loaded[MAX_HISTORY - 1].turn).toBe(MAX_HISTORY + 5)
  })
})

describe("saveHistory", () => {
  it("creates the directory and round-trips through loadHistory", async () => {
    const turns = [turn(1), turn(2, { phase: "running" })]

    await saveHistory(workDir, turns)

    expect(loadHistory(workDir)).toEqual(turns)
  })

  it("replaces the file in place, leaving no temp file behind", async () => {
    await saveHistory(workDir, [turn(1)])
    await saveHistory(workDir, [turn(2), turn(3)])

    expect(loadHistory(workDir).map((t) => t.turn)).toEqual([2, 3])
    expect(fs.existsSync(`${historyPath(workDir)}.tmp`)).toBe(false)
  })

  it("writes a bare array, not a wrapper object", async () => {
    await saveHistory(workDir, [turn(1)])

    const raw: unknown = JSON.parse(fs.readFileSync(historyPath(workDir), "utf-8"))

    expect(Array.isArray(raw)).toBe(true)
  })
})
