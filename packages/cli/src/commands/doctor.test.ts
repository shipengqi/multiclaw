import type { AgentDefinition, MultiClawConfig } from "@multiclawcli/core"
import { describe, expect, it } from "vitest"
import { buildDoctorReport, type DoctorReport, formatDoctorReport } from "./doctor"

const ESC = String.fromCharCode(27)

function detected(
  present: string[],
  missing: string[],
  source: Record<string, "path" | "bundled"> = {}
) {
  return [
    ...present.map((id) => ({
      id,
      label: id,
      command: id,
      status: "present" as const,
      version: "1.0.0",
      ...(source[id] ? { source: source[id] } : {}),
      ...(source[id] === "bundled" ? { resolvedPath: `/opt/multiclaw/${id}/bin.js` } : {}),
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

  it("warns when an agent configures tools for a provider that cannot enforce them", () => {
    const config: MultiClawConfig = {
      name: "demo",
      workDir: "/tmp",
      agents: [
        agent("safe", { provider: "claude", tools: ["Read"] }),
        agent("open", { provider: "codex", tools: ["Read"] }),
      ],
    }
    const report = buildDoctorReport(detected(["claude", "codex"], ["opencode", "cursor"]), config)
    expect(report.config?.agentsWithUnsupportedTools).toEqual(["open"])
  })

  it("does not warn for providers without tool support when the agent did not request tools", () => {
    const config: MultiClawConfig = {
      name: "demo",
      workDir: "/tmp",
      agents: [agent("open", { provider: "codex" })],
    }
    const report = buildDoctorReport(detected(["codex"], ["opencode", "claude", "cursor"]), config)
    expect(report.config?.agentsWithUnsupportedTools).toEqual([])
  })

  it("carries where a present provider resolved from", () => {
    const report = buildDoctorReport(
      detected(["claude", "opencode"], ["codex", "cursor"], { claude: "bundled" })
    )
    const claude = report.providers.find((p) => p.id === "claude")
    expect(claude?.source).toBe("bundled")
    expect(claude?.resolvedPath).toBe("/opt/multiclaw/claude/bin.js")
    const opencode = report.providers.find((p) => p.id === "opencode")
    expect(opencode?.source).toBeUndefined()
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

  it("prints a warning for configured tool allowlists that cannot be enforced", () => {
    const config: MultiClawConfig = {
      name: "demo",
      workDir: "/tmp",
      agents: [agent("open", { provider: "codex", tools: ["Read"] })],
    }
    const report = buildDoctorReport(detected(["codex"], ["opencode", "claude", "cursor"]), config)
    const out = formatDoctorReport(report, false)
    expect(out).toContain("cannot enforce tool allowlists")
    expect(out).toContain("open")
  })

  // "present" via a bundled bridge says nothing about what the user installed,
  // so the report names the file multiclaw will actually spawn.
  it("names the bridge a bundled provider resolves through", () => {
    const report = buildDoctorReport(
      detected(["claude"], ["opencode", "codex", "cursor"], { claude: "bundled" })
    )
    const out = formatDoctorReport(report, false)
    expect(out).toContain("source")
    expect(out).toContain("bundled")
    expect(out).toContain("bundled bridge: /opt/multiclaw/claude/bin.js")
  })

  it("prints no bridge line for a provider that resolved on PATH", () => {
    const report = buildDoctorReport(detected(["opencode"], ["claude", "codex", "cursor"]))
    const out = formatDoctorReport(report, false)
    expect(out).not.toContain("bundled bridge:")
  })
})
