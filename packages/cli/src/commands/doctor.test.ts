import type { AgentDefinition, MultiClawConfig } from "@multiclawcli/core"
import { describe, expect, it } from "vitest"
import { buildDoctorReport, type DoctorReport, formatDoctorReport } from "./doctor"

const ESC = String.fromCharCode(27)

function detected(present: string[], missing: string[]) {
  return [
    ...present.map((id) => ({
      id,
      label: id,
      command: id,
      status: "present" as const,
      version: "1.0.0",
    })),
    ...missing.map((id) => ({
      id,
      label: id,
      command: id,
      status: "missing" as const,
    })),
  ]
}

function agent(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    systemPrompt: "sys",
    taskPrompt: "task",
    ...extra,
  }
}

describe("buildDoctorReport", () => {
  it("counts installed providers and marks runnable", () => {
    const report = buildDoctorReport(detected(["opencode", "claude", "cursor"], ["codex"]))
    expect(report.installedCount).toBe(3)
    expect(report.runnable).toBe(true)
    expect(report.providers).toHaveLength(4)
  })

  it("is not runnable with zero providers", () => {
    const report = buildDoctorReport(detected([], ["opencode", "claude", "codex", "cursor"]))
    expect(report.runnable).toBe(false)
    expect(report.installedCount).toBe(0)
  })

  it("resolves model counts and selection mode from the catalog", () => {
    const report = buildDoctorReport(detected(["opencode"], ["claude", "codex", "cursor"]))
    const opencode = report.providers.find((p) => p.id === "opencode")
    expect(opencode?.modelCount).toBeGreaterThan(0)
    expect(opencode?.modelSelection).toBe("config-option")
  })

  it("reports config agents missing their provider", () => {
    const config: MultiClawConfig = {
      name: "demo",
      workDir: "/tmp",
      defaults: { provider: "cursor" },
      agents: [agent("x"), agent("y")],
    }
    // cursor is missing in this fixture.
    const report = buildDoctorReport(detected(["opencode"], ["claude", "codex", "cursor"]), config)
    expect(report.config?.defaultsProvider).toBe("cursor")
    expect(report.config?.defaultsProviderOk).toBe(false)
    expect(report.config?.agentsWithMissingProvider.sort()).toEqual(["x", "y"])
  })

  it("reports all-ok when the default provider is installed", () => {
    const config: MultiClawConfig = {
      name: "demo",
      workDir: "/tmp",
      agents: [agent("x"), agent("y")], // no provider set -> resolves to opencode
    }
    const report = buildDoctorReport(detected(["opencode"], ["claude", "codex", "cursor"]), config)
    expect(report.config?.agentsWithMissingProvider).toEqual([])
    expect(report.config?.defaultsProviderOk).toBe(true)
  })
})

describe("formatDoctorReport", () => {
  it("includes a present marker and a runnable verdict without color", () => {
    const report: DoctorReport = buildDoctorReport(detected(["opencode"], ["claude"]))
    const out = formatDoctorReport(report, false)
    expect(out).toContain("present")
    expect(out).toContain("1 of 2 providers available")
  })

  it("strips ANSI codes when color is disabled", () => {
    const report: DoctorReport = buildDoctorReport(detected(["opencode"], ["claude"]))
    const plain = formatDoctorReport(report, false)
    expect(plain).not.toContain(ESC)
    const colored = formatDoctorReport(report, true)
    expect(colored).toContain(ESC)
  })

  it("prints install hints for missing providers", () => {
    const report = buildDoctorReport(detected([], ["opencode", "claude", "codex", "cursor"]))
    const out = formatDoctorReport(report, false)
    expect(out).toContain("install:")
  })
})
