import { AgentSessionManager, type EventBus, type MultiClawConfig } from "@multiclawcli/core"
import { render } from "ink"
import { createElement } from "react"
import { App } from "./App"

export type { AppProps } from "./App"
export * from "./layout"
export * from "./state"

export interface TuiOptions {
  config: MultiClawConfig
  /** Attach per-turn reporters (e.g. a file log writer) here. */
  onTurnStart?: (eventBus: EventBus, logDir: string) => void | (() => void | Promise<void>)
}

/**
 * Render the interactive team console.
 *
 * Runs on the alternate screen buffer so the app owns the viewport and the
 * user's scrollback survives. The buffer is always restored — including when
 * rendering throws — otherwise the terminal is left unusable.
 */
export async function startTui(options: TuiOptions): Promise<void> {
  if (process.stdout.isTTY !== true) {
    throw new Error(
      'The interactive TUI needs a TTY. Use `multiclaw run "<requirement>"` for headless execution.'
    )
  }

  const restore = () => process.stdout.write("\x1b[?25h\x1b[?1049l")
  process.stdout.write("\x1b[?1049h\x1b[?25l")
  process.on("exit", restore)

  const sessions = new AgentSessionManager()
  let cleanup: (() => Promise<void>) | undefined
  const onCleanupReady = (callback: () => Promise<void>) => {
    cleanup = callback
  }
  try {
    const app = render(createElement(App, { ...options, sessions, onCleanupReady }), {
      exitOnCtrlC: false,
    })
    await app.waitUntilExit()
  } finally {
    try {
      if (cleanup) await cleanup()
      else await sessions.close()
    } finally {
      process.off("exit", restore)
      restore()
    }
  }
}
