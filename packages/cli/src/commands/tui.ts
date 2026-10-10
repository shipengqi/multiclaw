import { runtimeRegistry } from "@multiclawcli/core"
import { loadConfig } from "../loader/loadConfig"
import { FileLogWriter } from "../reporters/FileLogWriter"

export interface TuiCommandOptions {
  config?: string
}

export async function tuiCommand(options: TuiCommandOptions): Promise<void> {
  const config = await loadConfig(options.config)

  const runtimeNames = new Set(config.agents.map((a) => a.runtime ?? "claude"))
  for (const name of runtimeNames) {
    if (!runtimeRegistry.has(name)) {
      console.error(`\x1b[31mError: Unknown runtime "${name}". Supported: claude\x1b[0m`)
      process.exit(1)
    }
    const runtime = runtimeRegistry.get(name)
    if (!(await runtime.checkAvailable())) {
      console.error(
        `\x1b[31mError: Runtime "${name}" is not available. Make sure the CLI is installed.\x1b[0m`
      )
      process.exit(1)
    }
  }

  const { startTui } = await import("@multiclawcli/dashboard/tui")
  await startTui({
    config,
    onTurnStart: (eventBus, logDir) => {
      new FileLogWriter(logDir).attach(eventBus)
    },
  })
}
