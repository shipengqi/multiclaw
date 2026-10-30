import * as fs from "node:fs"
import * as path from "node:path"
import type { MultiClawConfig, OrchestratorResult } from "@multiclawcli/core"

/** A previous run's report, as much of it as resume needs. */
export interface ResumeTarget {
  runDir: string
  report: OrchestratorResult
}

/**
 * Resolve `--resume` into the run directory it names.
 *
 * `true` (a bare `--resume`) and `"latest"` both mean "the newest run". Run
 * directories are named `run-<ISO stamp>` with a fixed-width stamp, so a plain
 * lexicographic maximum is the most recent one — deterministic, and testable
 * without a clock.
 *
 * Any other value is treated as a path: either the run directory itself or its
 * `logs/` subdirectory, since that is where the report lives and a caller may
 * well point at it.
 */
export function resolveRunDir(runsRoot: string, target: string | boolean): string {
  // A bare `--resume` reaches us as `true` (commander's flag-without-value), and
  // `"latest"` is the explicit spelling; both name the newest run.
  if (typeof target !== "string" || target === "latest") {
    return latestRunDir(runsRoot)
  }
  const resolved = path.resolve(target)
  const runDir = path.basename(resolved) === "logs" ? path.dirname(resolved) : resolved
  if (!fs.existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`)
  }
  return runDir
}

/** The newest `run-*` directory under `runsRoot`. */
function latestRunDir(runsRoot: string): string {
  const names = fs.existsSync(runsRoot)
    ? fs
        .readdirSync(runsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
        .map((entry) => entry.name)
        .sort()
    : []
  const latest = names[names.length - 1]
  if (!latest) {
    // Naming the directory is the difference between a dead end and a lead.
    throw new Error(`No runs found to resume — looked in ${runsRoot}`)
  }
  return path.join(runsRoot, latest)
}

/** Read a run's `report.json`. */
export function readReport(runDir: string): OrchestratorResult {
  const reportPath = path.join(runDir, "logs", "report.json")
  let raw: string
  try {
    raw = fs.readFileSync(reportPath, "utf-8")
  } catch {
    throw new Error(`No report.json in ${runDir} — it may not be a complete run`)
  }
  try {
    return JSON.parse(raw) as OrchestratorResult
  } catch (err) {
    // Keep the parser's own words: "Unexpected token }" points at the real
    // problem far faster than a generic "bad report".
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse ${reportPath}: ${detail}`)
  }
}

/**
 * Turn a report (plus an optional requirement override) into run config.
 *
 * The requirement is the one thing a report cannot always supply — an older
 * report predates the field — so an explicit override wins, and its absence on
 * both sides is an error rather than a silently empty run.
 */
export function resumeOptionsFromReport(
  report: OrchestratorResult,
  requirementOverride?: string
): { requirement: string; resume: NonNullable<MultiClawConfig["resume"]> } {
  // A review loop records every pass; only the latest result owns a resumable session.
  const latest = new Map(report.agentResults.map((result) => [result.agentId, result]))
  const agents = [...latest.keys()].filter((id) => id !== report.acceptance?.reviewer)
  if (agents.length === 0) {
    throw new Error("The previous run has no agent results — nothing to resume")
  }

  const sessions: Record<string, string> = {}
  for (const result of latest.values()) {
    if (result.sessionId) sessions[result.agentId] = result.sessionId
  }

  const requirement = requirementOverride ?? report.requirement
  if (requirement === undefined) {
    throw new Error("The previous run recorded no requirement — pass one explicitly to resume")
  }

  return {
    requirement,
    resume: {
      agents,
      // Absent, not `{}`: core reads a missing `sessions` as "start every agent
      // fresh", which is exactly the single-agent retry of a failed agent.
      ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
    },
  }
}
