import { assertRuntimesAvailable } from "../lib"
import { loadConfig } from "../loader/loadConfig"
import { FileLogWriter } from "../reporters/FileLogWriter"

export interface TuiCommandOptions {
  config?: string
}

export async function tuiCommand(options: TuiCommandOptions): Promise<void> {
  const config = await loadConfig(options.config)

  await assertRuntimesAvailable(config)

  const { startTui } = await import("@multiclawcli/dashboard/tui")
  await startTui({
    config,
    onTurnStart: (eventBus, logDir) => {
      new FileLogWriter(logDir).attach(eventBus)
    },
  })
}
