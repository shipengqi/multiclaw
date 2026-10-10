import * as path from "node:path"
import type { Orchestrator } from "@multiclawcli/core"
import { Orchestrator as OrchestratorImpl, runtimeRegistry } from "@multiclawcli/core"
import { loadConfig } from "../loader/loadConfig"
import { ConsoleReporter } from "../reporters/ConsoleReporter"
import { FileLogWriter } from "../reporters/FileLogWriter"

export interface RunOptions {
  config?: string
  ui?: boolean
  serverUrl?: string
  port?: number
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

  if (options.ui && options.serverUrl) {
    console.warn(
      "\x1b[33mWarning: --ui and --server-url cannot be used together. Using --ui.\x1b[0m"
    )
  }

  if (options.ui) {
    await attachDashboard(orchestrator, config, options)
  } else if (options.serverUrl) {
    await attachRemoteServer(orchestrator, options.serverUrl)
  }

  const result = await orchestrator.run()
  process.exit(result.success ? 0 : 1)
}

async function attachDashboard(
  orchestrator: Orchestrator,
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: RunOptions
): Promise<void> {
  const { DashboardServer } = await import("@multiclawcli/dashboard/server")
  const port = options.port ?? config.dashboard?.port ?? 3210
  const server = new DashboardServer({ port })
  await server.start()
  server.bindEventBus(orchestrator.eventBus)

  const url = `http://localhost:${port}`
  console.log(`\x1b[36mDashboard: ${url}\x1b[0m`)

  if (config.dashboard?.autoOpen ?? true) {
    const { default: open } = await import("open")
    await open(url)
  }
}

async function attachRemoteServer(orchestrator: Orchestrator, serverUrl: string): Promise<void> {
  const { WebSocket } = await import("ws")
  const wsUrl = serverUrl.replace(/^https?/, (p) => (p === "https" ? "wss" : "ws"))
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Connection to serve timed out: ${serverUrl}`)),
      5000
    )
    ws.on("open", () => {
      clearTimeout(timer)
      resolve()
    })
    ws.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  console.log(`\x1b[36mConnected to Dashboard server: ${serverUrl}\x1b[0m`)
  orchestrator.eventBus.subscribe((e) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e))
  })
}
