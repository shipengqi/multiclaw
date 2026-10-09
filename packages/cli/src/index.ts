#!/usr/bin/env node
import { Command } from "commander"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { runCommand } from "./commands/run"
import { initCommand } from "./commands/init"
import { serveCommand } from "./commands/serve"
import { upgradeCommand } from "./commands/upgrade"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"))

const program = new Command()

program
  .name("multiclaw")
  .description("Multi-agent orchestration CLI")
  .version(pkg.version, "-v, --version", "Display version number")

program
  .command("init")
  .description("Scaffold a config file (interactive)")
  .action(() => initCommand())

program
  .command("run <requirement>")
  .description("Run an orchestration")
  .option("--config <path>", "Config file path (default: auto-discover ./multiclaw.config.ts)")
  .option("--ui", "Start Dashboard and open in browser")
  .option("--port <port>", "Dashboard port (requires --ui)", (v) => parseInt(v, 10))
  .option("--server-url <url>", "Connect to a running serve process")
  .option("--no-leader", "Skip the leader agent and use the default pipeline")
  .action((requirement, opts) => runCommand(requirement, opts))

program
  .command("serve")
  .description("Start a persistent Dashboard server")
  .option("--port <port>", "Port", (v) => parseInt(v, 10))
  .action((opts) => serveCommand(opts))

program
  .command("upgrade")
  .description("Upgrade multiclaw to the latest version")
  .action(() => upgradeCommand())

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`\x1b[31mError: ${(err as Error).message ?? err}\x1b[0m`)
  process.exit(1)
})
