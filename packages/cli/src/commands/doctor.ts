import {
  type DetectedProvider,
  detectProviders,
  type ModelSelectionMode,
  type MultiClawConfig,
  type ProviderStatus,
  presentProviders,
  resolveProvider,
  specForProvider,
} from "@multiclawcli/core"
import { loadConfig } from "../loader/loadConfig"

export interface DoctorProviderRow {
  id: string
  label: string
  status: ProviderStatus
  command: string
  version?: string
  modelCount: number
  modelSelection: ModelSelectionMode
  authHint: string
  installHint?: string
}

export interface DoctorReport {
  providers: DoctorProviderRow[]
  installedCount: number
  config?: {
    name?: string
    defaultsProvider?: string
    defaultsProviderOk: boolean
    agentsWithMissingProvider: string[]
  }
  runnable: boolean
}

/** Build the diagnostic model from detection results and an optional config. */
export function buildDoctorReport(
  detected: DetectedProvider[],
  config?: MultiClawConfig
): DoctorReport {
  const present = presentProviders(detected)

  const providers: DoctorProviderRow[] = detected.map((d) => {
    const spec = specForProvider(d.id)
    return {
      id: d.id,
      label: d.label,
      status: d.status,
      command: d.command,
      version: d.version,
      modelCount: spec?.models.length ?? 0,
      modelSelection: spec?.modelSelection ?? "none",
      authHint: spec?.auth.hint ?? "",
      installHint: d.status === "missing" ? spec?.install.hint : undefined,
    }
  })

  const installedCount = present.length

  let configReport: DoctorReport["config"]
  if (config) {
    const defaultsProvider = config.defaults?.provider
    const defaultsProviderOk = !defaultsProvider || present.includes(defaultsProvider)

    const agents = [...config.agents]
    if (config.leader) agents.push(config.leader)
    const agentsWithMissingProvider = agents
      .map((a) => ({ id: a.id, intended: resolveProvider(a, config) }))
      .filter((a) => !present.includes(a.intended))
      .map((a) => a.id)

    configReport = {
      name: config.name,
      defaultsProvider,
      defaultsProviderOk,
      agentsWithMissingProvider,
    }
  }

  return {
    providers,
    installedCount,
    config: configReport,
    runnable: installedCount > 0,
  }
}

const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

// Matches SGR escape sequences so visible width can be measured for column padding.
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g")

function color(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${RESET}` : text
}

/** Render the report as human-readable text for stdout. */
export function formatDoctorReport(report: DoctorReport, useColor = true): string {
  const lines: string[] = []
  const c = (code: string, text: string) => color(useColor, code, text)
  // Pad by *visible* width so ANSI codes do not shift columns.
  const cell = (text: string, width: number, code?: string) => {
    const rendered = code ? color(useColor, code, text) : text
    const visible = text.replace(ANSI_RE, "").length
    return rendered + " ".repeat(Math.max(0, width - visible))
  }

  lines.push("")
  lines.push(c(DIM, "multiclaw doctor — environment check"))
  lines.push("")

  // Provider table.
  lines.push(`${cell("provider", 12)}${cell("status", 10)}${cell("version", 14)}models  auth`)
  for (const p of report.providers) {
    const mark = p.status === "present" ? "✓ present" : "✗ missing"
    const markCode = p.status === "present" ? GREEN : RED
    const version = p.version ?? (p.status === "present" ? "" : "—")
    const models = p.modelSelection === "none" ? "n/a" : String(p.modelCount)
    const auth = p.authHint ? c(DIM, p.authHint) : ""
    lines.push(
      `${cell(p.label, 12)}${cell(mark, 10, markCode)}${cell(version, 14)}${cell(models, 7)}${auth}`
    )
    if (p.status === "missing" && p.installHint) {
      lines.push(c(YELLOW, `  install: ${p.installHint}`))
    }
  }

  // Config sanity.
  if (report.config) {
    lines.push("")
    lines.push(c(DIM, `config: ${report.config.name ?? "(unnamed)"}`))
    if (report.config.defaultsProvider) {
      const ok = report.config.defaultsProviderOk
      lines.push(
        `  default provider: ${report.config.defaultsProvider} ${
          ok ? c(GREEN, "✓ installed") : c(RED, "✗ not installed")
        }`
      )
    }
    if (report.config.agentsWithMissingProvider.length > 0) {
      lines.push(
        c(
          RED,
          `  ${report.config.agentsWithMissingProvider.length} agent(s) need a provider that is not installed: ${report.config.agentsWithMissingProvider.join(", ")}`
        )
      )
    } else {
      lines.push(c(GREEN, "  all agents resolve to an installed provider ✓"))
    }
  }

  // Verdict.
  lines.push("")
  if (report.runnable) {
    lines.push(
      c(
        GREEN,
        `✓ ${report.installedCount} of ${report.providers.length} providers available — multiclaw can run.`
      )
    )
  } else {
    lines.push(c(RED, `✗ no providers installed — install one of the above to run multiclaw.`))
  }
  lines.push("")

  return lines.join("\n")
}

/** Run the `doctor` command: detect providers, print the report, set exit code. */
export async function doctorCommand(configPath?: string): Promise<void> {
  const detected = await detectProviders({ withVersion: true })
  const config = await loadConfigSafe(configPath)
  const report = buildDoctorReport(detected, config)
  const useColor = !process.env.NO_COLOR && process.stdout.isTTY
  console.log(formatDoctorReport(report, useColor))
  process.exitCode = report.runnable ? 0 : 1
}

/** Load a config if one exists; return undefined otherwise (doctor still runs). */
async function loadConfigSafe(configPath?: string): Promise<MultiClawConfig | undefined> {
  try {
    return await loadConfig(configPath)
  } catch {
    return undefined
  }
}
