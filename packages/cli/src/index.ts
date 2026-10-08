#!/usr/bin/env node
import { Command } from "commander"
import { runCommand } from "./commands/run"
import { initCommand } from "./commands/init"
import { serveCommand } from "./commands/serve"

const program = new Command()

program
  .name("multiclaw")
  .description("Multi-agent orchestration CLI")
  .version("0.1.0")

program
  .command("init")
  .description("Scaffold a config file")
  .option(
    "--preset <name>",
    "Built-in preset: simple (default) | backend | fullstack",
    "simple"
  )
  .action((opts) => initCommand(opts))

program
  .command("run <requirement>")
  .description("Run an orchestration")
  .option("--config <path>", "Config file path (default: auto-discover ./multiclaw.config.ts)")
  .option("--ui", "Start Dashboard and open in browser")
  .option("--port <port>", "Dashboard port (requires --ui)", (v) => parseInt(v, 10))
  .option("--server-url <url>", "Connect to a running serve process")
  .action((requirement, opts) => runCommand(requirement, opts))

program
  .command("serve")
  .description("Start a persistent Dashboard server")
  .option("--port <port>", "Port", (v) => parseInt(v, 10))
  .action((opts) => serveCommand(opts))

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`\x1b[31mError: ${(err as Error).message ?? err}\x1b[0m`)
  process.exit(1)
})
