/**
 * The `/` command palette.
 *
 * Slash commands are how every agent CLI in this space exposes operations that
 * are not worth a keybinding. They also solve the console's hardest input
 * problem: a bare key cannot be both "type this" and "do that", but a *prefix*
 * can, because the user has already committed to a mode by typing it.
 */

/** When a command may be run. */
export type Availability = "always" | "running" | "idle"

export interface CommandSpec {
  /** Without the leading slash. */
  name: string
  /** Argument hint shown next to the name, e.g. `<agent>`. */
  args?: string
  description: string
  availability: Availability
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "agents", description: "List the configured team", availability: "always" },
  {
    name: "focus",
    args: "<id>",
    description: "Focus an agent by id",
    availability: "always",
  },
  { name: "clear", description: "Clear the focused agent's log", availability: "always" },
  {
    name: "history",
    description: "Browse finished turns",
    availability: "always",
  },
  {
    name: "cancel",
    description: "Cancel the running turn and its queue",
    availability: "running",
  },
  { name: "help", description: "Show the key map", availability: "always" },
  { name: "quit", description: "Exit the console", availability: "always" },
]

export interface ParsedCommand {
  name: string
  args: string[]
}

/** Commands that make sense in the current phase. */
export function availableCommands(running: boolean): CommandSpec[] {
  const phase: Availability = running ? "running" : "idle"
  return COMMANDS.filter((c) => c.availability === "always" || c.availability === phase)
}

/**
 * Commands matching what has been typed after the slash.
 *
 * Name prefixes outrank description hits: someone typing `/ag` wants `/agents`,
 * not whichever command happens to mention "agent" in its blurb.
 */
export function matchCommands(query: string, running: boolean): CommandSpec[] {
  const q = query.trim().toLowerCase()
  const pool = availableCommands(running)
  if (!q) return pool

  const byName: CommandSpec[] = []
  const byDescription: CommandSpec[] = []
  for (const command of pool) {
    if (command.name.startsWith(q)) byName.push(command)
    else if (command.description.toLowerCase().includes(q)) byDescription.push(command)
  }
  return [...byName, ...byDescription]
}

/** True once the line has committed to command mode. */
export function isCommandLine(text: string): boolean {
  return text.startsWith("/")
}

/**
 * The partial name the palette should filter on, or `undefined` when the
 * palette should stay closed.
 *
 * It closes as soon as a space is typed: at that point the user is writing
 * arguments, and a list that keeps re-filtering under their cursor is noise.
 */
export function menuQuery(text: string): string | undefined {
  if (!isCommandLine(text)) return undefined
  const rest = text.slice(1)
  return /\s/.test(rest) ? undefined : rest
}

/** Split a submitted line into a command name and its arguments. */
export function parseCommand(text: string): ParsedCommand | undefined {
  if (!isCommandLine(text)) return undefined
  const [name = "", ...args] = text.slice(1).trim().split(/\s+/)
  return name ? { name, args } : undefined
}
