import { assertRuntimesAvailable } from "../lib"
import { loadConfig } from "../loader/loadConfig"
import { FileLogWriter } from "../reporters/FileLogWriter"

export interface TuiCommandOptions {
  config?: string
  /** Start a fresh session instead of continuing the most recent one. */
  new?: boolean
  /** Resume a session: a specific id, or `true` to open the picker. */
  resume?: string | boolean
}

/** Translate the CLI flags into the console's launch choice. */
function initialSession(options: TuiCommandOptions) {
  if (options.new) return { kind: "new" as const }
  if (options.resume !== undefined) {
    return {
      kind: "resume" as const,
      ...(typeof options.resume === "string" ? { id: options.resume } : {}),
    }
  }
  return { kind: "new" as const }
}

export async function tuiCommand(options: TuiCommandOptions): Promise<void> {
  const config = await loadConfig(options.config)

  await assertRuntimesAvailable(config)

  const { startTui } = await import("@multiclawcli/dashboard/tui")
  await startTui({
    config,
    initialSession: initialSession(options),
    onTurnStart: (eventBus, logDir) => {
      const writer = new FileLogWriter(logDir)
      const detach = writer.attach(eventBus)
      return async () => {
        try {
          await writer.drain()
        } finally {
          detach()
        }
      }
    },
  })
}
