#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Command } from "commander"
import { doctorCommand } from "./commands/doctor"
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
  // No subcommand opens the interactive console. Subcommands declare their own
  // `--config` so it is parsed after the subcommand name (commander rule).
  .action((options: { config?: string }) => tuiCommand(options))

program
  .command("init")
  .description("Scaffold a config file (interactive)")
  .action(() => initCommand())

program
  .command("run [requirement]")
  .description("Run an orchestration headlessly")
  .option("--config <path>", "Config file path (default: auto-discover ./multiclaw.config.ts)")
  .option("--no-leader", "Batch mode only: skip routing and run the full team")
  .option("--dry-run", "Preview the routed plan without running the pipeline")
  .option(
    "--resume [path]",
    "Resume a previous run, continuing agent sessions (default: the latest)"
  )
  .action((requirement, opts) => runCommand(requirement, opts))

program
  .command("upgrade")
  .description("Upgrade multiclaw to the latest version")
  .action(() => upgradeCommand())

program
  .command("doctor")
  .description("Check which agent providers are installed and ready")
  .option("--config <path>", "Config file path (default: auto-discover ./multiclaw.config.ts)")
  .action((opts: { config?: string }) => doctorCommand(opts.config))

program.parseAsync(process.argv).catch((err: unknown) => {
  // `(err as Error).message` is a cast, not a check: a rejection with `null` or
  // `undefined` would throw a TypeError while trying to report the error.
  const message = err instanceof Error ? err.message : String(err)
  console.error(`\x1b[31mError: ${message}\x1b[0m`)
  process.exit(1)
})
