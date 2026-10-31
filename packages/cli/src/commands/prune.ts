import * as fs from "node:fs"
import * as path from "node:path"
import { checkbox, confirm } from "@inquirer/prompts"
import { loadConfig } from "../loader/loadConfig"

export interface PruneOptions {
  config?: string
  history?: boolean
  runs?: boolean
  all?: boolean
  dryRun?: boolean
  yes?: boolean
}

export interface PruneItem {
  id: string
  label: string
  path: string
  size: number
  kind: "history" | "run" | "all-runs"
}

/** Scan `.multiclaw/` and list prune-able items with their sizes. */
export function scanPruneItems(workDir: string): PruneItem[] {
  const items: PruneItem[] = []
  const multiclawDir = path.join(workDir, ".multiclaw")

  const historyFile = path.join(multiclawDir, "console", "history.json")
  if (fs.existsSync(historyFile)) {
    const stat = fs.statSync(historyFile)
    const raw = fs.readFileSync(historyFile, "utf-8")
    let turns = 0
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) turns = parsed.length
    } catch {
      // malformed — still show it, just with 0 turns
    }
    items.push({
      id: "history",
      label: `Console history (${turns} turn${turns === 1 ? "" : "s"}, ${formatBytes(stat.size)})`,
      path: historyFile,
      size: stat.size,
      kind: "history",
    })
  }

  const runsDir = path.join(multiclawDir, "runs")
  if (fs.existsSync(runsDir)) {
    const entries = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("run-"))
      .sort((a, b) => a.name.localeCompare(b.name))

    let totalRunsSize = 0
    for (const entry of entries) {
      const runPath = path.join(runsDir, entry.name)
      const size = dirSize(runPath)
      totalRunsSize += size
      const agentCount = countAgentsInRun(runPath)
      items.push({
        id: entry.name,
        label: `${entry.name}  (${agentCount} agent${agentCount === 1 ? "" : "s"}, ${formatBytes(size)})`,
        path: runPath,
        size,
        kind: "run",
      })
    }

    if (entries.length > 1) {
      items.push({
        id: "all-runs",
        label: `All runs (${entries.length} total, ${formatBytes(totalRunsSize)})`,
        path: runsDir,
        size: totalRunsSize,
        kind: "all-runs",
      })
    }
  }

  return items
}

/** Delete the selected items. Returns what was removed. */
export function deletePruneItems(items: PruneItem[]): {
  deleted: string[]
  failed: Array<{ path: string; error: string }>
} {
  const deleted: string[] = []
  const failed: Array<{ path: string; error: string }> = []

  for (const item of items) {
    try {
      if (item.kind === "history") {
        fs.unlinkSync(item.path)
        deleted.push(item.id)
      } else if (item.kind === "run") {
        fs.rmSync(item.path, { recursive: true, force: true })
        deleted.push(item.id)
      } else if (item.kind === "all-runs") {
        // Delete every run-* directory, then remove the parent if empty.
        const runsDir = item.path
        const entries = fs
          .readdirSync(runsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name.startsWith("run-"))
        for (const entry of entries) {
          fs.rmSync(path.join(runsDir, entry.name), { recursive: true, force: true })
        }
        // Remove the empty runs directory itself.
        try {
          fs.rmdirSync(runsDir)
        } catch {
          // directory not empty (user files?) — leave it
        }
        deleted.push(item.id)
      }
    } catch (err) {
      failed.push({ path: item.path, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { deleted, failed }
}

/** Resolve non-interactive flags into item ids, or undefined if interactive. */
export function resolvePruneTargets(
  options: PruneOptions,
  items: PruneItem[]
): string[] | undefined {
  if (options.all) {
    return items.map((i) => i.id)
  }
  if (options.history && options.runs) {
    return items.map((i) => i.id)
  }
  if (options.history) {
    return items.filter((i) => i.kind === "history").map((i) => i.id)
  }
  if (options.runs) {
    return items.filter((i) => i.kind === "run" || i.kind === "all-runs").map((i) => i.id)
  }
  return undefined
}

export async function pruneCommand(options: PruneOptions): Promise<void> {
  const config = await loadConfig(options.config)
  const items = scanPruneItems(config.workDir)

  if (items.length === 0) {
    console.log("Nothing to prune — no history or runs found.")
    return
  }

  let selectedIds: string[]
  const nonInteractive = resolvePruneTargets(options, items)

  if (nonInteractive !== undefined) {
    selectedIds = nonInteractive
  } else {
    const choices = items.map((item) => ({
      value: item.id,
      name: item.label,
    }))
    selectedIds = await checkbox({
      message: "Select items to prune (space to select, enter to confirm):",
      choices,
    })
  }

  if (selectedIds.length === 0) {
    console.log("No items selected — nothing pruned.")
    return
  }

  const selected = items.filter((i) => selectedIds.includes(i.id))
  const totalSize = selected.reduce((sum, i) => sum + i.size, 0)

  if (options.dryRun) {
    console.log("")
    console.log("\x1b[2mDry run — the following would be deleted:\x1b[0m")
    for (const item of selected) {
      console.log(`  \x1b[31m- ${item.label}\x1b[0m`)
    }
    console.log(`\n  Total: ${formatBytes(totalSize)}`)
    return
  }

  if (!options.yes) {
    const ok = await confirm({
      message: `Delete ${selected.length} item${selected.length === 1 ? "" : "s"} (${formatBytes(totalSize)})? This cannot be undone.`,
      default: false,
    })
    if (!ok) {
      console.log("Cancelled — nothing pruned.")
      return
    }
  }

  const { deleted, failed } = deletePruneItems(selected)

  console.log("")
  if (deleted.length > 0) {
    console.log(
      `\x1b[32m✓\x1b[0m Pruned ${deleted.length} item${deleted.length === 1 ? "" : "s"} (${formatBytes(totalSize)} freed)`
    )
    for (const id of deleted) {
      const item = items.find((i) => i.id === id)
      if (item) console.log(`  \x1b[2m- ${item.label}\x1b[0m`)
    }
  }
  if (failed.length > 0) {
    console.log("")
    console.log(
      `\x1b[31m✗\x1b[0m Failed to delete ${failed.length} item${failed.length === 1 ? "" : "s"}:`
    )
    for (const { path: p, error } of failed) {
      console.log(`  \x1b[31m- ${p}: ${error}\x1b[0m`)
    }
    process.exitCode = 1
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${(bytes / k ** i).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`
}

function dirSize(root: string): number {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) continue
    for (const name of fs.readdirSync(dir)) {
      const absolute = path.join(dir, name)
      const stat = fs.statSync(absolute)
      if (stat.isDirectory()) {
        stack.push(absolute)
      } else {
        total += stat.size
      }
    }
  }
  return total
}

function countAgentsInRun(runDir: string): number {
  const logsDir = path.join(runDir, "logs")
  if (!fs.existsSync(logsDir)) return 0
  const reportPath = path.join(logsDir, "report.json")
  if (!fs.existsSync(reportPath)) {
    // No report — count log files as a rough proxy.
    return fs.readdirSync(logsDir).filter((n) => n.endsWith(".log")).length
  }
  try {
    const raw = fs.readFileSync(reportPath, "utf-8")
    const report = JSON.parse(raw) as { agentResults?: Array<{ agentId: string }> }
    return report.agentResults?.length ?? 0
  } catch {
    return fs.readdirSync(logsDir).filter((n) => n.endsWith(".log")).length
  }
}
