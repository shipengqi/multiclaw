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

  it("finds history with turn count", () => {
    const consoleDir = path.join(tmpDir, ".multiclaw", "console")
    fs.mkdirSync(consoleDir, { recursive: true })
    fs.writeFileSync(
      path.join(consoleDir, "history.json"),
      JSON.stringify([{ turn: 1 }, { turn: 2 }]),
      "utf-8"
    )

    const items = scanPruneItems(tmpDir)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("history")
    expect(items[0].kind).toBe("history")
    expect(items[0].label).toContain("2 turns")
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

  it("shows malformed history as 0 turns", () => {
    const consoleDir = path.join(tmpDir, ".multiclaw", "console")
    fs.mkdirSync(consoleDir, { recursive: true })
    fs.writeFileSync(path.join(consoleDir, "history.json"), "not json", "utf-8")

    const items = scanPruneItems(tmpDir)
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

  it("deletes history file", () => {
    const historyFile = path.join(tmpDir, "history.json")
    fs.writeFileSync(historyFile, "[]", "utf-8")

    const { deleted, failed } = deletePruneItems([
      makeItem({ id: "history", kind: "history", path: historyFile }),
    ])
    expect(deleted).toEqual(["history"])
    expect(failed).toEqual([])
    expect(fs.existsSync(historyFile)).toBe(false)
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
    const missing = path.join(tmpDir, "does-not-exist")

    const { deleted, failed } = deletePruneItems([
      makeItem({ id: "missing", kind: "history", path: missing }),
    ])
    expect(deleted).toEqual([])
    expect(failed).toHaveLength(1)
    expect(failed[0].path).toBe(missing)
  })
})

describe("resolvePruneTargets", () => {
  const items: PruneItem[] = [
    makeItem({ id: "history", kind: "history", path: "/h" }),
    makeItem({ id: "run-a", kind: "run", path: "/r/a" }),
    makeItem({ id: "run-b", kind: "run", path: "/r/b" }),
    makeItem({ id: "all-runs", kind: "all-runs", path: "/r" }),
  ]

  it("returns all ids when --all is set", () => {
    expect(resolvePruneTargets({ all: true }, items)).toEqual([
      "history",
      "run-a",
      "run-b",
      "all-runs",
    ])
  })

  it("returns all ids when both --history and --runs are set", () => {
    expect(resolvePruneTargets({ history: true, runs: true }, items)).toEqual([
      "history",
      "run-a",
      "run-b",
      "all-runs",
    ])
  })

  it("returns only history when --history is set alone", () => {
    expect(resolvePruneTargets({ history: true }, items)).toEqual(["history"])
  })

  it("returns runs and all-runs when --runs is set alone", () => {
    expect(resolvePruneTargets({ runs: true }, items)).toEqual(["run-a", "run-b", "all-runs"])
  })

  it("returns undefined when no flag is set (interactive mode)", () => {
    expect(resolvePruneTargets({}, items)).toBeUndefined()
  })
})
