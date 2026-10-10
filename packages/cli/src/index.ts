#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Command } from "commander"
import { initCommand } from "./commands/init"
import { runCommand } from "./commands/run"
import { tuiCommand } from "./commands/tui"
import { upgradeCommand } from "./commands/upgrade"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"))

const program = new Command()

program
  .name("multiclaw")
  .description("Multi-agent orchestration CLI")
  .version(pkg.version, "-v, --version", "Display version number")
  .option("--config <path>", "Config file path (default: auto-discover ./multiclaw.config.ts)")
  // No subcommand opens the interactive console.
  .action((options: { config?: string }) => tuiCommand(options))

program
  .command("init")
  .description("Scaffold a config file (interactive)")
  .action(() => initCommand())

program
  .command("run <requirement>")
  .description("Run an orchestration headlessly")
  .option("--config <path>", "Config file path (default: auto-discover ./multiclaw.config.ts)")
  .option("--no-leader", "Skip the leader agent and use the default pipeline")
  .action((requirement, opts) => runCommand(requirement, opts))

program
  .command("upgrade")
  .description("Upgrade multiclaw to the latest version")
  .action(() => upgradeCommand())

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`\x1b[31mError: ${(err as Error).message ?? err}\x1b[0m`)
  process.exit(1)
})
