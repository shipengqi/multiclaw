import * as path from "node:path"
import { Orchestrator as OrchestratorImpl } from "@multiclawcli/core"
import { assertRuntimesAvailable } from "../lib"
import { loadConfig } from "../loader/loadConfig"
import { ConsoleReporter } from "../reporters/ConsoleReporter"
import { FileLogWriter } from "../reporters/FileLogWriter"
import { readReport, resolveRunDir, resumeOptionsFromReport } from "./resume"

export interface RunOptions {
  config?: string
  noLeader?: boolean
  /**
   * `true` for a bare `--resume` (latest run), or a path to a specific run.
   * Commander only ever produces `undefined`, `true` or a string, so `false` is
   * not part of the domain.
   */
  resume?: string | true
}

/** Conventional exit code for a process stopped by SIGINT. */
const EXIT_CANCELLED = 130

export async function runCommand(
  requirementArg: string | undefined,
  options: RunOptions
): Promise<void> {
  const config = await loadConfig(options.config, requirementArg)

  if (options.noLeader) {
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
    console.log(`\x1b[2mResuming ${runDir} (${resume.agents.length} agents)\x1b[0m`)
  } else {
    config.workDir = path.join(config.workDir, ".multiclaw", "runs", `run-${stamp}`)
  }

  await assertRuntimesAvailable(config)

  const orchestrator = new OrchestratorImpl(config)

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
