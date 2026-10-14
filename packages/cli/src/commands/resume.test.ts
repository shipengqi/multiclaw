import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentResult, OrchestratorResult } from "@multiclawcli/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readReport, resolveRunDir, resumeOptionsFromReport } from "./resume"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resume-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Create `run-<stamp>` under `root`, with an optional report.json inside. */
function makeRun(stamp: string, report?: unknown): string {
  const runDir = join(root, `run-${stamp}`)
  mkdirSync(join(runDir, "logs"), { recursive: true })
  if (report !== undefined) {
    writeFileSync(join(runDir, "logs", "report.json"), JSON.stringify(report))
  }
  return runDir
}

function result(agentId: string, patch: Partial<AgentResult> = {}): AgentResult {
  return {
    agentId,
    agentName: agentId,
    status: "success",
    output: "",
    duration: 1,
    attempts: 1,
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-01T00:00:01.000Z",
    ...patch,
  }
}

function report(patch: Partial<OrchestratorResult> = {}): OrchestratorResult {
  return {
    name: "demo",
    success: true,
    totalDuration: 1,
    agentResults: [],
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-01T00:00:01.000Z",
    ...patch,
  }
}

describe("resolveRunDir", () => {
  it("picks the newest run for `latest`", () => {
    makeRun("2026-01-01T00-00-00")
    const newest = makeRun("2026-01-02T00-00-00")

    // The stamp is fixed-width ISO, so a lexicographic maximum is the most
    // recent run — deterministic without consulting a clock.
    expect(resolveRunDir(root, "latest")).toBe(newest)
  })

  it("picks the newest run for a bare `--resume`", () => {
    makeRun("2026-01-01T00-00-00")
    const newest = makeRun("2026-01-02T00-00-00")

    expect(resolveRunDir(root, true)).toBe(newest)
  })

  it("errors when there are no runs, naming where it looked", () => {
    expect(() => resolveRunDir(root, "latest")).toThrow(root)
  })

  it("resolves an explicit run directory", () => {
    const runDir = makeRun("2026-01-01T00-00-00")

    expect(resolveRunDir(root, runDir)).toBe(runDir)
  })

  it("accepts the run's logs/ subdirectory", () => {
    const runDir = makeRun("2026-01-01T00-00-00")

    expect(resolveRunDir(root, join(runDir, "logs"))).toBe(runDir)
  })

  it("errors on a path that does not exist", () => {
    expect(() => resolveRunDir(root, join(root, "nope"))).toThrow(/not found/i)
  })
})

describe("readReport", () => {
  it("reads a run's report.json", () => {
    const runDir = makeRun("2026-01-01T00-00-00", report({ name: "demo" }))

    expect(readReport(runDir).name).toBe("demo")
  })

  it("errors when report.json is missing", () => {
    const runDir = makeRun("2026-01-01T00-00-00")

    expect(() => readReport(runDir)).toThrow(/report\.json/)
  })

  it("errors with the parser's own detail when report.json is corrupt", () => {
    const runDir = makeRun("2026-01-01T00-00-00")
    writeFileSync(join(runDir, "logs", "report.json"), "{ not json")

    expect(() => readReport(runDir)).toThrow(/Could not parse/)
  })
})

describe("resumeOptionsFromReport", () => {
  it("takes every agent id, in report order", () => {
    const { resume } = resumeOptionsFromReport(
      report({
        requirement: "ship it",
        agentResults: [result("architect"), result("dev")],
      })
    )

    expect(resume.agents).toEqual(["architect", "dev"])
  })

  it("de-duplicates agent ids", () => {
    const { resume } = resumeOptionsFromReport(
      report({ requirement: "ship it", agentResults: [result("dev"), result("dev")] })
    )

    expect(resume.agents).toEqual(["dev"])
  })

  it("collects only the sessions the run reported", () => {
    const { resume } = resumeOptionsFromReport(
      report({
        requirement: "ship it",
        agentResults: [result("architect", { sessionId: "s-1" }), result("dev")],
      })
    )

    expect(resume.sessions).toEqual({ architect: "s-1" })
  })

  it("omits sessions entirely when nobody reported one", () => {
    const { resume } = resumeOptionsFromReport(
      report({ requirement: "ship it", agentResults: [result("dev")] })
    )

    // Absent, not `{}`: core reads an absent `sessions` as "start fresh".
    expect("sessions" in resume).toBe(false)
  })

  it("prefers an explicit requirement over the report's", () => {
    const { requirement } = resumeOptionsFromReport(
      report({ requirement: "old", agentResults: [result("dev")] }),
      "new"
    )

    expect(requirement).toBe("new")
  })

  it("falls back to the report's requirement", () => {
    const { requirement } = resumeOptionsFromReport(
      report({ requirement: "old", agentResults: [result("dev")] })
    )

    expect(requirement).toBe("old")
  })

  it("errors when the report has no requirement and none is given", () => {
    expect(() => resumeOptionsFromReport(report({ agentResults: [result("dev")] }))).toThrow(
      /requirement/i
    )
  })

  it("errors when the report has no agent results", () => {
    expect(() => resumeOptionsFromReport(report({ requirement: "x" }))).toThrow(/agent results/i)
  })
})
