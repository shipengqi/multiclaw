import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  appendTurns,
  EXPORT_DIR,
  exportPath,
  exportTurn,
  formatTurnMarkdown,
  loadTurns,
  TURNS_FILE,
  turnsPath,
} from "./history"
import { SESSIONS_DIR } from "./sessions"
import { MAX_HISTORY, type TurnView } from "./state"

const SID = "session-1"

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

/** Write raw JSONL lines straight to the turn log, bypassing `appendTurns`. */
function writeLines(values: unknown[]): void {
  const target = turnsPath(workDir, SID)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${values.map((v) => JSON.stringify(v)).join("\n")}\n`, "utf-8")
}

describe("turnsPath", () => {
  it("points inside .multiclaw/sessions/<id>", () => {
    expect(turnsPath("/work", SID)).toBe(
      path.join("/work", ".multiclaw", SESSIONS_DIR, SID, "turns.jsonl")
    )
    expect(TURNS_FILE).toBe("turns.jsonl")
  })
})

describe("appendTurns concurrency", () => {
  it("serializes rapid appends and keeps every turn in order", async () => {
    const writes = Array.from({ length: 10 }, (_, index) =>
      appendTurns(workDir, SID, [turn(index + 1)])
    )
    await Promise.all(writes)
    expect(loadTurns(workDir, SID).map((t) => t.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe("loadTurns", () => {
  it("returns an empty list when the file does not exist", () => {
    expect(loadTurns(workDir, SID)).toEqual([])
  })

  it("skips a line that is not valid JSON", () => {
    const target = turnsPath(workDir, SID)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, "{ not json\n", "utf-8")

    expect(loadTurns(workDir, SID)).toEqual([])
  })

  it("skips a line that is not a turn", () => {
    writeLines([{ version: 1 }])

    expect(loadTurns(workDir, SID)).toEqual([])
  })

  it("drops only the malformed lines and keeps the good ones", () => {
    const good = turn(1)
    // A hand-edited or torn log can hold anything on a line: `null`, a bare
    // number, an object missing `turn`, a string. Each bad line goes, each good
    // one stays.
    writeLines([good, null, 7, { phase: "complete" }, "nope", turn(2)])

    expect(loadTurns(workDir, SID)).toEqual([good, turn(2)])
  })

  // `turn` and `phase` are not enough to render a turn: the panes dereference
  // `agents` (via `progress`'s `Object.values`) and read `stages` / `leaderIds`
  // as lists for every listed turn. A line missing any of them would throw while
  // rendering `/history`, so it must be dropped rather than kept.
  it("drops a line missing a field the panes dereference", () => {
    const good = turn(1)
    writeLines([
      good,
      { turn: 2, phase: "complete" },
      { turn: 3, phase: "complete", agents: {}, stages: [] },
      { turn: 4, phase: "complete", agents: null, stages: [], leaderIds: [] },
      { turn: 5, phase: "complete", agents: {}, stages: "nope", leaderIds: [] },
      { turn: 6, phase: "complete", agents: {}, stages: [], leaderIds: "nope" },
      { turn: 7, phase: 5, agents: {}, stages: [], leaderIds: [] },
    ])

    expect(loadTurns(workDir, SID)).toEqual([good])
  })

  // The collection being the right type is not enough: the panes walk its
  // *elements*. `progress()` reads `a.status` off every `agents` value, and
  // `railCellWidths` reads `agent.name` off every `stage.agents` element — a
  // `null` element throws in both.
  it("drops a line whose `agents` value is not an object", () => {
    const good = turn(1)
    writeLines([good, { ...good, turn: 2, agents: { a: null } }])

    expect(loadTurns(workDir, SID)).toEqual([good])
  })

  it("drops a line whose `stages` element is not an object", () => {
    const good = turn(1)
    writeLines([good, { ...good, turn: 3, stages: [null] }])

    expect(loadTurns(workDir, SID)).toEqual([good])
  })

  it("accepts older records and validates optional turn metadata", () => {
    const older = turn(1)
    const current = turn(2, { cancelled: true, effectiveRequirement: "resolved request" })
    writeLines([
      older,
      current,
      { ...turn(3), cancelled: "false" },
      { ...turn(4), effectiveRequirement: 42 },
    ])
    expect(loadTurns(workDir, SID)).toEqual([older, current])
  })

  it("round-trips acceptance and rejects malformed acceptance metadata", async () => {
    const acceptance = {
      status: "changes_required" as const,
      reviewer: "qa",
      repairRounds: 1,
      reviews: [
        {
          verdict: "changes_required" as const,
          summary: "Fix tests",
          issues: ["Missing coverage"],
        },
      ],
    }
    const good = turn(1, { acceptance })
    await appendTurns(workDir, SID, [good])
    expect(loadTurns(workDir, SID)).toEqual([good])
    writeLines([
      good,
      ...[
        null,
        {},
        { ...acceptance, status: "success" },
        { ...acceptance, reviewer: 1 },
        { ...acceptance, repairRounds: -1 },
        { ...acceptance, repairRounds: 0.5 },
        { ...acceptance, reviews: [null] },
        { ...acceptance, reviews: [{ verdict: "approved", summary: "ok", issues: [42] }] },
        { ...acceptance, reason: 42 },
      ].map((bad, i) => ({ ...turn(i + 2), acceptance: bad })),
    ])
    expect(loadTurns(workDir, SID)).toEqual([good])
  })

  it("round-trips stage outcomes and rejects invalid optional outcomes", async () => {
    const good = turn(1, {
      stages: [{ stageIndex: 0, agents: [{ id: "a", name: "a" }], outcome: "success" }],
    })
    await appendTurns(workDir, SID, [good])
    expect(loadTurns(workDir, SID)).toEqual([good])
    writeLines([
      good,
      turn(2),
      ...[null, "approved", 42, {}].map((outcome, i) => ({
        ...turn(i + 3),
        stages: [{ stageIndex: 0, agents: [], outcome }],
      })),
    ])
    expect(loadTurns(workDir, SID)).toEqual([good, turn(2)])
  })

  it("round-trips stage member statuses and rejects invalid member maps", async () => {
    const good = turn(1, {
      stages: [
        {
          stageIndex: 0,
          agents: [],
          outcome: "failed",
          memberStatuses: { a: "success", b: "failed" },
        },
      ],
    })
    await appendTurns(workDir, SID, [good])
    expect(loadTurns(workDir, SID)).toEqual([good])
    writeLines([
      good,
      ...[null, "failed", { a: "approved" }, { a: 42 }].map((memberStatuses, i) => ({
        ...turn(i + 2),
        stages: [{ stageIndex: 0, agents: [], memberStatuses }],
      })),
    ])
    expect(loadTurns(workDir, SID)).toEqual([good])
  })

  it("keeps only the last MAX_HISTORY entries", () => {
    writeLines(Array.from({ length: MAX_HISTORY + 5 }, (_, i) => turn(i + 1)))

    const loaded = loadTurns(workDir, SID)

    expect(loaded).toHaveLength(MAX_HISTORY)
    expect(loaded[0].turn).toBe(6)
    expect(loaded[MAX_HISTORY - 1].turn).toBe(MAX_HISTORY + 5)
  })
})

describe("exportTurn", () => {
  it("formats requirement, agent statuses, and logs as markdown", () => {
    const markdown = formatTurnMarkdown(
      turn(3, {
        agents: {
          dev: { id: "dev", name: "Developer", status: "success", logs: "built it" },
        },
        success: true,
      })
    )

    expect(markdown).toContain("# Turn 3")
    expect(markdown).toContain("## Requirement")
    expect(markdown).toContain("req 3")
    expect(markdown).toContain("- dev: Developer — success")
    expect(markdown).toContain("built it")
  })

  it.each([
    ["approved", "approved"],
    ["changes_required", "changes required"],
    ["failed", "acceptance failed"],
    ["cancelled", "acceptance cancelled"],
  ] as const)("exports acceptance %s explicitly", (status, label) => {
    const markdown = formatTurnMarkdown(
      turn(1, {
        success: status === "approved",
        acceptance: {
          status,
          reviewer: "qa",
          repairRounds: 1,
          reason: "Gate result",
          reviews: [
            { verdict: "changes_required", summary: "Fix tests", issues: ["Missing tests"] },
          ],
        },
      })
    )
    expect(markdown).toContain(`Status: ${label}`)
    expect(markdown).toContain("Reviewer: qa")
    expect(markdown).toContain("Repair rounds: 1")
    expect(markdown).toContain("Gate result")
    expect(markdown).toContain("Fix tests")
    expect(markdown).toContain("Missing tests")
  })

  it("writes to the session's export directory", async () => {
    const target = exportPath(workDir, SID, 4)

    await exportTurn(turn(4), target)

    expect(target).toBe(
      path.join(workDir, ".multiclaw", SESSIONS_DIR, SID, EXPORT_DIR, "turn-4.md")
    )
    expect(fs.readFileSync(target, "utf-8")).toContain("# Turn 4")
  })
})

describe("appendTurns", () => {
  it("creates the directory and round-trips through loadTurns", async () => {
    const turns = [turn(1), turn(2, { phase: "running" })]

    await appendTurns(workDir, SID, turns)

    expect(loadTurns(workDir, SID)).toEqual(turns)
  })

  it("appends rather than replacing", async () => {
    await appendTurns(workDir, SID, [turn(1)])
    await appendTurns(workDir, SID, [turn(2), turn(3)])

    expect(loadTurns(workDir, SID).map((t) => t.turn)).toEqual([1, 2, 3])
  })

  it("writes one JSON object per line and no temp file", async () => {
    await appendTurns(workDir, SID, [turn(1), turn(2)])

    const target = turnsPath(workDir, SID)
    const lines = fs
      .readFileSync(target, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")

    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    expect(fs.existsSync(`${target}.tmp`)).toBe(false)
  })

  it("does nothing when given no turns", async () => {
    await appendTurns(workDir, SID, [])
    expect(fs.existsSync(turnsPath(workDir, SID))).toBe(false)
  })
})
