import * as fs from "node:fs"
import * as path from "node:path"
import {
  describeResumePlan,
  Orchestrator as OrchestratorImpl,
  type OrchestratorResult,
} from "@multiclawcli/core"
import { assertRuntimesAvailable } from "../lib"
import { loadConfig } from "../loader/loadConfig"
import { ConsoleReporter } from "../reporters/ConsoleReporter"
import { FileLogWriter } from "../reporters/FileLogWriter"
import { readReport, resolveRunDir, resumeOptionsFromReport } from "./resume"

export interface RunOptions {
  config?: string
  leader?: boolean
  noLeader?: boolean
  /**
   * `true` for a bare `--resume` (latest run), or a path to a specific run.
   * Commander only ever produces `undefined`, `true` or a string, so `false` is
   * not part of the domain.
   */
  resume?: string | true
  dryRun?: boolean
}

/** Conventional exit code for a process stopped by SIGINT. */
const EXIT_CANCELLED = 130

export async function runCommand(
  requirementArg: string | undefined,
  options: RunOptions
): Promise<void> {
  const config = await loadConfig(options.config, requirementArg)

  if (options.leader === false || options.noLeader) {
    config.useLeader = false
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  if (options.resume !== undefined) {
    // Resolve against the project directory: `loadConfig` already resolved
    // `workDir` against the config file's directory, and the run dirs live under
    // it. Only after we know which run we are resuming do we move `workDir`
    // onto it — the agents must continue in the directory they wrote to, or the
    // bridge sees a different cwd and rebuilds the session instead of loading it.
    const runsRoot = path.join(config.workDir, ".multiclaw", "runs")
    const runDir = resolveRunDir(runsRoot, options.resume)
    const report = readReport(runDir)
    const { requirement, resume } = resumeOptionsFromReport(report, requirementArg)
    config.workDir = runDir
    config.resume = resume
    config.context = { ...config.context, requirement }
    // Never reuse `logs/`: the original report.json lives there and the resumed
    // run must not overwrite the record it was derived from.
    config.logDir = path.join(runDir, `logs-resume-${stamp}`)
    // A resumed run is a different pipeline from the one that was recorded:
    // resuming a cancelled run leaves out the agents whose stage never started
    // (an agent that was cancelled *does* have a result, and so is resumed
    // again), and an agent only keeps its session when the report carried one.
    // Spelling that out is cheaper than the user guessing why the retry behaved
    // differently from the run it continues.
    const plan = describeResumePlan({
      agents: resume.agents,
      sessions: resume.sessions,
      team: config.agents,
    })
    console.log(`\x1b[2mResuming ${runDir} (${resume.agents.length} agents) — ${plan}\x1b[0m`)
  } else {
    config.workDir = path.join(config.workDir, ".multiclaw", "runs", `run-${stamp}`)
  }

  if (options.dryRun) {
    const preview = await new OrchestratorImpl(config).preview()
    printDryRun(preview, config.workDir)
    process.exitCode = 0
    return
  }

  await assertRuntimesAvailable(config)

  const before = snapshotFiles(config.workDir)
  const orchestrator = new OrchestratorImpl(config)
  orchestrator.eventBus.subscribe((event) => {
    if (event.type !== "orchestration:complete") return
    event.payload.deliverables = collectDeliverables(config.workDir, before)
  })

  new ConsoleReporter().attach(orchestrator.eventBus)

  const logDir = config.logDir ?? path.join(config.workDir, "logs")
  const logs = new FileLogWriter(logDir)
  logs.attach(orchestrator.eventBus)
  console.log(`\x1b[2mLogs: ${logDir}\x1b[0m`)

  // Ctrl-C stops the team rather than orphaning it: the in-flight agents are
  // aborted, the run reports itself as cancelled, and the logs still get flushed.
  // A second Ctrl-C means the user is done waiting, so it exits immediately.
  const controller = new AbortController()
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(EXIT_CANCELLED)
    controller.abort()
  }
  process.on("SIGINT", onSigint)

  try {
    const result = await orchestrator.run({ signal: controller.signal })
    // Flush before exiting: `stream.end()` is asynchronous, so `process.exit()`
    // on the next line would truncate the tail of the last agent's log.
    await logs.drain()
    process.exitCode = result.cancelled ? EXIT_CANCELLED : result.success ? 0 : 1
  } finally {
    process.off("SIGINT", onSigint)
  }
}

function printDryRun(
  preview: Awaited<ReturnType<InstanceType<typeof OrchestratorImpl>["preview"]>>,
  workDir: string
): void {
  console.log("Dry run — no pipeline agents will execute.")
  console.log(`Project: ${preview.name}`)
  console.log(`Work dir: ${workDir}`)
  if (preview.requirement) console.log(`Requirement: ${preview.requirement}`)
  if (preview.reply) {
    console.log(`${preview.reply.mode === "ask" ? "Question" : "Reply"}: ${preview.reply.message}`)
    return
  }
  console.log(`Agents: ${preview.totalAgents}`)
  if (preview.selectionReason) console.log(`Why: ${preview.selectionReason}`)
  for (const stage of preview.stages) {
    const agents = stage.agents.map(
      (agent) => `${agent.id}${agent.model ? ` (${agent.model})` : ""}`
    )
    console.log(`Stage ${stage.stageIndex + 1}: ${agents.join(", ") || "—"}`)
  }
}

interface FileSnapshot {
  mtimeMs: number
  size: number
}

function snapshotFiles(root: string): Map<string, FileSnapshot> {
  const snapshot = new Map<string, FileSnapshot>()
  walkFiles(root, (_absolute, relative, stat) => {
    snapshot.set(relative, { mtimeMs: stat.mtimeMs, size: stat.size })
  })
  return snapshot
}

function collectDeliverables(
  root: string,
  before: Map<string, FileSnapshot>
): NonNullable<OrchestratorResult["deliverables"]> {
  const deliverables: NonNullable<OrchestratorResult["deliverables"]> = []
  walkFiles(root, (_absolute, relative, stat) => {
    const previous = before.get(relative)
    if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) return
    deliverables.push({
      path: relative,
      status: previous ? "modified" : "created",
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    })
  })
  return deliverables.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 20)
}

function walkFiles(
  root: string,
  visit: (absolute: string, relative: string, stat: fs.Stats) => void
): void {
  if (!fs.existsSync(root)) return
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const name of fs.readdirSync(dir)) {
      if (name === ".multiclaw") continue
      const absolute = path.join(dir, name)
      const stat = fs.statSync(absolute)
      if (stat.isDirectory()) stack.push(absolute)
      else if (stat.isFile()) visit(absolute, path.relative(root, absolute), stat)
    }
  }
}
