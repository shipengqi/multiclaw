import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { MultiClawConfig, OrchestratorResult } from "@multiclawcli/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Mutable state shared with the mocked dependencies, plus the values they
 * captured. `vi.hoisted` is what lets the `vi.mock` factories (which are lifted
 * above the imports) read and write it.
 */
const state = vi.hoisted(() => ({
  workDir: "",
  config: undefined as MultiClawConfig | undefined,
  logDir: undefined as string | undefined,
  result: undefined as OrchestratorResult | undefined,
}))

vi.mock("@multiclawcli/core", () => ({
  Orchestrator: class {
    readonly eventBus = { subscribe: () => () => {} }
    constructor(config: MultiClawConfig) {
      state.config = config
    }
    async run(): Promise<OrchestratorResult> {
      return state.result as OrchestratorResult
    }
  },
}))

vi.mock("../loader/loadConfig", () => ({
  loadConfig: async (_path?: string, requirement?: string): Promise<MultiClawConfig> => ({
    name: "demo",
    workDir: state.workDir,
    agents: [],
    context: requirement !== undefined ? { requirement } : {},
  }),
}))

vi.mock("../lib", () => ({ assertRuntimesAvailable: async () => {} }))

vi.mock("../reporters/ConsoleReporter", () => ({
  ConsoleReporter: class {
    attach() {
      return () => {}
    }
  },
}))

vi.mock("../reporters/FileLogWriter", () => ({
  FileLogWriter: class {
    constructor(logDir: string) {
      state.logDir = logDir
    }
    attach() {
      return () => {}
    }
    async drain() {}
  },
}))

import { runCommand } from "./run"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "run-cmd-"))
  state.workDir = root
  state.config = undefined
  state.logDir = undefined
  state.result = {
    name: "demo",
    success: true,
    totalDuration: 1,
    agentResults: [],
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-01T00:00:01.000Z",
  }
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Write a run directory with a report.json, under the project's runs root. */
function writeRun(stamp: string, report: unknown): string {
  const runDir = path.join(root, ".multiclaw", "runs", `run-${stamp}`)
  fs.mkdirSync(path.join(runDir, "logs"), { recursive: true })
  fs.writeFileSync(path.join(runDir, "logs", "report.json"), JSON.stringify(report, null, 2))
  return runDir
}

const REPORT = {
  name: "demo",
  success: false,
  totalDuration: 1,
  requirement: "ship it",
  agentResults: [
    {
      agentId: "dev",
      agentName: "dev",
      status: "failed",
      output: "",
      duration: 1,
      attempts: 1,
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-01T00:00:01.000Z",
    },
  ],
  startTime: "2026-01-01T00:00:00.000Z",
  endTime: "2026-01-01T00:00:01.000Z",
}

describe("runCommand · resume wiring", () => {
  it("resumes in the original run directory, beside the record it read", async () => {
    const runDir = writeRun("2026-01-01T00-00-00", REPORT)
    const reportPath = path.join(runDir, "logs", "report.json")
    const original = fs.readFileSync(reportPath, "utf-8")

    await runCommand(undefined, { resume: true })

    // The agents must continue where they wrote, so the run dir becomes the
    // work dir — not a fresh sandbox.
    expect(state.config?.workDir).toBe(runDir)
    expect(state.config?.resume).toEqual({ agents: ["dev"] })
    // The requirement is recovered from the report the resume was derived from.
    expect(state.config?.context?.requirement).toBe("ship it")
    // The record is never overwritten by the run that continues it.
    expect(fs.readFileSync(reportPath, "utf-8")).toBe(original)
    // And the resumed logs land in a sibling directory, not `logs/`.
    expect(state.logDir?.startsWith(path.join(runDir, "logs-resume-"))).toBe(true)
  })

  it("starts a fresh run-<stamp> directory when not resuming", async () => {
    await runCommand("do a thing", {})

    expect(state.config?.workDir).toMatch(/\.multiclaw[/\\]runs[/\\]run-/)
    expect(state.config?.resume).toBeUndefined()
    expect(state.config?.context?.requirement).toBe("do a thing")
  })
})
