import * as path from "node:path"
import { Orchestrator as OrchestratorImpl, runtimeRegistry } from "@multiclawcli/core"
import { loadConfig } from "../loader/loadConfig"
import { ConsoleReporter } from "../reporters/ConsoleReporter"
import { FileLogWriter } from "../reporters/FileLogWriter"

export interface RunOptions {
  config?: string
  noLeader?: boolean
}

export async function runCommand(requirement: string, options: RunOptions): Promise<void> {
  const config = await loadConfig(options.config, requirement)

  if (options.noLeader) {
    config.useLeader = false
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  config.workDir = path.join(config.workDir, ".multiclaw", "runs", `run-${ts}`)

  const runtimeNames = new Set(config.agents.map((a) => a.runtime ?? "claude"))
  for (const name of runtimeNames) {
    if (!runtimeRegistry.has(name)) {
      console.error(`\x1b[31mError: Unknown runtime "${name}". Supported: claude\x1b[0m`)
      process.exit(1)
    }
    const rt = runtimeRegistry.get(name)
    if (!(await rt.checkAvailable())) {
      console.error(
        `\x1b[31mError: Runtime "${name}" is not available. Make sure the CLI is installed.\x1b[0m`
      )
      process.exit(1)
    }
  }

  const orchestrator = new OrchestratorImpl(config)

  new ConsoleReporter().attach(orchestrator.eventBus)

  const logDir = config.logDir ?? path.join(config.workDir, "logs")
  new FileLogWriter(logDir).attach(orchestrator.eventBus)
  console.log(`\x1b[2mLogs: ${logDir}\x1b[0m`)

  const result = await orchestrator.run()
  process.exit(result.success ? 0 : 1)
}
