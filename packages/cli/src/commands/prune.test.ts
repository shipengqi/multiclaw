import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { deletePruneItems, type PruneItem, resolvePruneTargets, scanPruneItems } from "./prune"

function makeItem(
  overrides: Partial<PruneItem> & Pick<PruneItem, "id" | "kind" | "path">
): PruneItem {
  return {
    label: overrides.id,
    size: 0,
    ...overrides,
  }
}

interface SeedSession {
  id: string
  title?: string
  turnCount?: number
  lastActiveAt?: number
  /** Written into the session's turns.jsonl so the directory has some size. */
  turns?: string
}

/** Seed a sessions index and, for each, its directory under `.multiclaw/sessions`. */
function seedSessions(root: string, sessions: SeedSession[]): void {
  const sessionsDir = path.join(root, ".multiclaw", "sessions")
  fs.mkdirSync(sessionsDir, { recursive: true })
  const index = sessions.map((s, i) => ({
    id: s.id,
    title: s.title ?? "",
    turnCount: s.turnCount ?? 0,
    createdAt: i,
    lastActiveAt: s.lastActiveAt ?? i,
  }))
  fs.writeFileSync(path.join(sessionsDir, "index.json"), JSON.stringify(index), "utf-8")
  for (const s of sessions) {
    if (s.turns === undefined) continue
    const dir = path.join(sessionsDir, s.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "turns.jsonl"), s.turns, "utf-8")
  }
}

describe("scanPruneItems", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-prune-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns empty when .multiclaw does not exist", () => {
    expect(scanPruneItems(tmpDir)).toEqual([])
  })

  it("finds sessions with their title and turn count, newest first", () => {
    seedSessions(tmpDir, [
      { id: "old", title: "old task", turnCount: 1, lastActiveAt: 1, turns: "{}\n" },
      { id: "new", title: "new task", turnCount: 5, lastActiveAt: 2, turns: "{}\n" },
    ])

    const items = scanPruneItems(tmpDir).filter((i) => i.kind === "session")
    expect(items.map((i) => i.id)).toEqual(["new", "old"])
    expect(items[0].label).toContain("new task")
    expect(items[0].label).toContain("5 turns")
    expect(items[1].label).toContain("old task")
    expect(items[1].label).toContain("1 turn")
  })

  it("lists an index-only session with zero size, and a dir-only session as untitled", () => {
    const sessionsDir = path.join(tmpDir, ".multiclaw", "sessions")
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessionsDir, "index.json"),
      JSON.stringify([{ id: "ghost", title: "never ran", turnCount: 0, lastActiveAt: 9 }]),
      "utf-8"
    )
    // A directory with no index entry — a hand-deleted index.
    fs.mkdirSync(path.join(sessionsDir, "orphan"), { recursive: true })
    fs.writeFileSync(path.join(sessionsDir, "orphan", "turns.jsonl"), "{}\n", "utf-8")

    const items = scanPruneItems(tmpDir).filter((i) => i.kind === "session")
    const ghost = items.find((i) => i.id === "ghost")
    const orphan = items.find((i) => i.id === "orphan")
    expect(ghost?.size).toBe(0)
    expect(ghost?.label).toContain("never ran")
    expect(orphan?.label).toContain("(untitled)")
  })

  it("finds runs with agent count from report.json", () => {
    const runsDir = path.join(tmpDir, ".multiclaw", "runs")
    const runDir = path.join(runsDir, "run-2026-01-01T00-00-00")
    const logsDir = path.join(runDir, "logs")
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, "report.json"),
      JSON.stringify({ agentResults: [{ agentId: "a" }, { agentId: "b" }] }),
      "utf-8"
    )
    fs.writeFileSync(path.join(logsDir, "a.log"), "log a", "utf-8")

    const items = scanPruneItems(tmpDir)
    const runs = items.filter((i) => i.kind === "run")
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe("run-2026-01-01T00-00-00")
    expect(runs[0].label).toContain("2 agents")
  })

  it("falls back to counting log files when report.json is missing", () => {
    const runsDir = path.join(tmpDir, ".multiclaw", "runs")
    const runDir = path.join(runsDir, "run-2026-01-01T00-00-00")
    const logsDir = path.join(runDir, "logs")
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(path.join(logsDir, "leader.log"), "log", "utf-8")
    fs.writeFileSync(path.join(logsDir, "architect.log"), "log", "utf-8")

    const items = scanPruneItems(tmpDir)
    const run = items.find((i) => i.kind === "run")
    expect(run?.label).toContain("2 agents")
  })

  it("adds an all-runs item when there are multiple runs", () => {
    const runsDir = path.join(tmpDir, ".multiclaw", "runs")
    for (const name of ["run-2026-01-01T00-00-00", "run-2026-01-02T00-00-00"]) {
      const logsDir = path.join(runsDir, name, "logs")
      fs.mkdirSync(logsDir, { recursive: true })
      fs.writeFileSync(
        path.join(logsDir, "report.json"),
        JSON.stringify({ agentResults: [] }),
        "utf-8"
      )
    }

    const items = scanPruneItems(tmpDir)
    expect(items.some((i) => i.kind === "all-runs")).toBe(true)
    expect(items.find((i) => i.kind === "all-runs")?.label).toContain("2 total")
  })

  it("does not add all-runs when there is only one run", () => {
    const runsDir = path.join(tmpDir, ".multiclaw", "runs")
    const logsDir = path.join(runsDir, "run-2026-01-01T00-00-00", "logs")
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, "report.json"),
      JSON.stringify({ agentResults: [] }),
      "utf-8"
    )

    const items = scanPruneItems(tmpDir)
    expect(items.some((i) => i.kind === "all-runs")).toBe(false)
  })

  it("calculates directory size correctly", () => {
    const runsDir = path.join(tmpDir, ".multiclaw", "runs")
    const logsDir = path.join(runsDir, "run-2026-01-01T00-00-00", "logs")
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(path.join(logsDir, "a.log"), "x".repeat(1000), "utf-8")
    fs.writeFileSync(path.join(logsDir, "b.log"), "y".repeat(500), "utf-8")

    const items = scanPruneItems(tmpDir)
    const run = items.find((i) => i.kind === "run")
    expect(run?.size).toBe(1500)
  })

  it("tolerates a corrupt index, still listing on-disk sessions as untitled", () => {
    const sessionsDir = path.join(tmpDir, ".multiclaw", "sessions")
    fs.mkdirSync(path.join(sessionsDir, "abc"), { recursive: true })
    fs.writeFileSync(path.join(sessionsDir, "abc", "turns.jsonl"), "{}\n", "utf-8")
    fs.writeFileSync(path.join(sessionsDir, "index.json"), "not json", "utf-8")

    const items = scanPruneItems(tmpDir).filter((i) => i.kind === "session")
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("abc")
    expect(items[0].label).toContain("(untitled)")
    expect(items[0].label).toContain("0 turns")
  })
})

describe("deletePruneItems", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-prune-del-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("deletes a session directory and drops its index entry", () => {
    const sessionsDir = path.join(tmpDir, ".multiclaw", "sessions")
    const dir = path.join(sessionsDir, "sid")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "turns.jsonl"), "{}\n", "utf-8")
    fs.writeFileSync(
      path.join(sessionsDir, "index.json"),
      JSON.stringify([
        { id: "sid", title: "gone", turnCount: 1, createdAt: 0, lastActiveAt: 0 },
        { id: "keep", title: "stays", turnCount: 1, createdAt: 1, lastActiveAt: 1 },
      ]),
      "utf-8"
    )

    const { deleted, failed } = deletePruneItems([
      makeItem({ id: "sid", kind: "session", path: dir }),
    ])

    expect(deleted).toEqual(["sid"])
    expect(failed).toEqual([])
    expect(fs.existsSync(dir)).toBe(false)
    const index = JSON.parse(fs.readFileSync(path.join(sessionsDir, "index.json"), "utf-8"))
    expect(index.map((e: { id: string }) => e.id)).toEqual(["keep"])
  })

  it("deletes an index-only session without a directory", () => {
    const sessionsDir = path.join(tmpDir, ".multiclaw", "sessions")
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessionsDir, "index.json"),
      JSON.stringify([{ id: "ghost", title: "", turnCount: 0, createdAt: 0, lastActiveAt: 0 }]),
      "utf-8"
    )

    const { deleted, failed } = deletePruneItems([
      makeItem({ id: "ghost", kind: "session", path: path.join(sessionsDir, "ghost") }),
    ])

    expect(deleted).toEqual(["ghost"])
    expect(failed).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, "index.json"), "utf-8"))).toEqual([])
  })

  it("deletes a run directory recursively", () => {
    const runDir = path.join(tmpDir, "run-2026-01-01")
    fs.mkdirSync(path.join(runDir, "logs"), { recursive: true })
    fs.writeFileSync(path.join(runDir, "logs", "a.log"), "log", "utf-8")

    const { deleted } = deletePruneItems([
      makeItem({ id: "run-2026-01-01", kind: "run", path: runDir }),
    ])
    expect(deleted).toEqual(["run-2026-01-01"])
    expect(fs.existsSync(runDir)).toBe(false)
  })

  it("deletes all runs and removes the parent directory", () => {
    const runsDir = path.join(tmpDir, "runs")
    fs.mkdirSync(path.join(runsDir, "run-a", "logs"), { recursive: true })
    fs.mkdirSync(path.join(runsDir, "run-b", "logs"), { recursive: true })
    fs.writeFileSync(path.join(runsDir, "run-a", "logs", "a.log"), "log", "utf-8")

    const { deleted } = deletePruneItems([
      makeItem({ id: "all-runs", kind: "all-runs", path: runsDir }),
    ])
    expect(deleted).toEqual(["all-runs"])
    expect(fs.existsSync(runsDir)).toBe(false)
  })

  it("leaves the runs parent if non-run files exist", () => {
    const runsDir = path.join(tmpDir, "runs")
    fs.mkdirSync(path.join(runsDir, "run-a", "logs"), { recursive: true })
    fs.writeFileSync(path.join(runsDir, "keep-me.txt"), "keep", "utf-8")

    const { deleted } = deletePruneItems([
      makeItem({ id: "all-runs", kind: "all-runs", path: runsDir }),
    ])
    expect(deleted).toEqual(["all-runs"])
    expect(fs.existsSync(runsDir)).toBe(true)
    expect(fs.existsSync(path.join(runsDir, "keep-me.txt"))).toBe(true)
    expect(fs.existsSync(path.join(runsDir, "run-a"))).toBe(false)
  })

  it("reports failures without stopping", () => {
    // An `all-runs` item lists its directory; pointing it at a file makes the
    // listing throw, which is the error path this verifies.
    const notADir = path.join(tmpDir, "not-a-dir")
    fs.writeFileSync(notADir, "x", "utf-8")

    const { deleted, failed } = deletePruneItems([
      makeItem({ id: "all-runs", kind: "all-runs", path: notADir }),
    ])

    expect(deleted).toEqual([])
    expect(failed).toHaveLength(1)
    expect(failed[0].path).toBe(notADir)
  })
})

describe("resolvePruneTargets", () => {
  const items: PruneItem[] = [
    makeItem({ id: "sid", kind: "session", path: "/s/sid" }),
    makeItem({ id: "run-a", kind: "run", path: "/r/a" }),
    makeItem({ id: "run-b", kind: "run", path: "/r/b" }),
    makeItem({ id: "all-runs", kind: "all-runs", path: "/r" }),
  ]

  it("returns all ids when --all is set", () => {
    expect(resolvePruneTargets({ all: true }, items)).toEqual(["sid", "run-a", "run-b", "all-runs"])
  })

  it("returns all ids when both --sessions and --runs are set", () => {
    expect(resolvePruneTargets({ sessions: true, runs: true }, items)).toEqual([
      "sid",
      "run-a",
      "run-b",
      "all-runs",
    ])
  })

  it("returns only sessions when --sessions is set alone", () => {
    expect(resolvePruneTargets({ sessions: true }, items)).toEqual(["sid"])
  })

  it("returns runs and all-runs when --runs is set alone", () => {
    expect(resolvePruneTargets({ runs: true }, items)).toEqual(["run-a", "run-b", "all-runs"])
  })

  it("returns undefined when no flag is set (interactive mode)", () => {
    expect(resolvePruneTargets({}, items)).toBeUndefined()
  })
})
