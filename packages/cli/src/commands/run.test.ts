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
  constructed: 0,
  ran: 0,
  previewed: 0,
}))

// Only the orchestrator is swapped out; everything else in core — the resume
// plan description included — stays real, so the tests below exercise the same
// helpers the command ships with.
vi.mock("@multiclawcli/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiclawcli/core")>()
  return {
    ...actual,
    Orchestrator: class {
      readonly listeners = new Set<(event: unknown) => void>()
      readonly eventBus = {
        subscribe: (fn: (event: unknown) => void) => {
          this.listeners.add(fn)
          return () => this.listeners.delete(fn)
        },
      }
      constructor(config: MultiClawConfig) {
        state.constructed += 1
        state.config = config
      }
      async preview() {
        state.previewed += 1
        return {
          name: state.config?.name ?? "demo",
          requirement: state.config?.context?.requirement,
          totalAgents: state.config?.agents.length ?? 0,
          selectionReason: "small routed change",
          stages: [
            {
              stageIndex: 0,
              agents: (state.config?.agents ?? []).map((agent) => ({
                id: agent.id,
                name: agent.name,
                model: agent.model,
              })),
            },
          ],
        }
      }
      async run(): Promise<OrchestratorResult> {
        state.ran += 1
        const workDir = state.config?.workDir ?? state.workDir
        fs.mkdirSync(workDir, { recursive: true })
        fs.writeFileSync(path.join(workDir, "artifact.txt"), "made")
        const result = state.result as OrchestratorResult
        for (const listener of this.listeners) {
          listener({ type: "orchestration:complete", payload: result })
        }
        return result
      }
    },
  }
})

vi.mock("../loader/loadConfig", () => ({
  loadConfig: async (_path?: string, requirement?: string): Promise<MultiClawConfig> => ({
    name: "demo",
    workDir: state.workDir,
    agents: [{ id: "dev", name: "Developer", model: "fast", systemPrompt: "", taskPrompt: "" }],
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
      fs.mkdirSync(logDir, { recursive: true })
    }
    attach(eventBus: { subscribe: (fn: (event: unknown) => void) => () => void }) {
      return eventBus.subscribe((event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "orchestration:complete" &&
          "payload" in event
        ) {
          fs.writeFileSync(
            path.join(state.logDir as string, "report.json"),
            JSON.stringify(event.payload, null, 2)
          )
        }
      })
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
  state.constructed = 0
  state.ran = 0
  state.previewed = 0
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

/** Everything the command printed, joined — `console.log` is mocked per test. */
function consoleLines(): string {
  return (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n")
}

describe("runCommand · dry run and deliverables", () => {
  it("previews the routed plan without running the pipeline or creating logs", async () => {
    await runCommand("ship it", { dryRun: true })

    expect(state.constructed).toBe(1)
    expect(state.previewed).toBe(1)
    expect(state.ran).toBe(0)
    expect(state.logDir).toBeUndefined()
    expect(fs.existsSync(path.join(state.config?.workDir ?? root, "logs"))).toBe(false)
    const printed = consoleLines()
    expect(printed).toContain("Dry run")
    expect(printed).toContain("Requirement: ship it")
    expect(printed).toContain("Why: small routed change")
    expect(printed).toContain("Stage 1: dev (fast)")
  })

  it("records files created by the run in report.json", async () => {
    await runCommand("make a file", {})

    expect(state.ran).toBe(1)
    const reportPath = path.join(state.logDir as string, "report.json")
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as OrchestratorResult
    expect(report.deliverables).toEqual([
      expect.objectContaining({ path: "artifact.txt", status: "created", size: 4 }),
    ])
  })
})

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
    // The resumed run is a different pipeline from the recorded one, so the
    // banner spells out what this one actually does: this agent reported no
    // session, so it starts from scratch rather than picking up where the
    // failed run left off.
    expect(consoleLines()).toContain("dev starts fresh")
  })

  it("says which agents continue a session when the report carried one", async () => {
    writeRun("2026-01-02T00-00-00", {
      ...REPORT,
      agentResults: [{ ...REPORT.agentResults[0], status: "success", sessionId: "s-42" }],
    })

    await runCommand(undefined, { resume: true })

    expect(state.config?.resume).toEqual({ agents: ["dev"], sessions: { dev: "s-42" } })
    expect(consoleLines()).toContain("dev continues its session")
  })

  it("starts a fresh run-<stamp> directory when not resuming", async () => {
    await runCommand("do a thing", {})

    expect(state.config?.workDir).toMatch(/\.multiclaw[/\\]runs[/\\]run-/)
    expect(state.config?.resume).toBeUndefined()
    expect(state.config?.context?.requirement).toBe("do a thing")
  })
})
