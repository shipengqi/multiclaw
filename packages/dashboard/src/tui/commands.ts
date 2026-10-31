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
  /**
   * What this command's first argument completes against, if anything.
   *
   * Declared as data rather than matched on the name in `App`, so "this command
   * takes a completer" is one fact in one place: a second such command needs no
   * edit to the console's key handling.
   */
  completes?: "agent"
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "agents", description: "List the configured team", availability: "always" },
  {
    name: "focus",
    args: "<id>",
    description: "Focus an agent by id",
    availability: "always",
    completes: "agent",
  },
  { name: "clear", description: "Clear the focused agent's log", availability: "always" },
  {
    name: "history",
    description: "Browse finished turns",
    availability: "always",
  },
  {
    name: "verbose",
    description: "Toggle tool detail in the stream",
    availability: "always",
  },
  {
    name: "retry",
    args: "[id]",
    description: "Re-run a failed agent (or all of them)",
    availability: "idle",
  },
  {
    name: "replay",
    args: "[turn]",
    description: "Run an earlier turn again",
    availability: "idle",
  },
  {
    name: "fork",
    args: "[turn]",
    description: "Edit an earlier turn's requirement",
    availability: "always",
  },
  {
    name: "export",
    args: "[turn] [path]",
    description: "Export a finished turn as Markdown",
    availability: "always",
  },
  {
    name: "search",
    args: "<text>",
    description: "Search the focused stream",
    availability: "always",
  },
  {
    name: "latest",
    description: "Jump the stream to latest output",
    availability: "always",
  },
  {
    name: "cancel",
    description: "Cancel the running turn and its queue",
    availability: "running",
  },
  {
    name: "task",
    args: "<requirement>",
    description: "Start a new task with fresh agent sessions",
    availability: "idle",
  },
  {
    name: "steer",
    args: "<text>",
    description: "Send a message into the agents running right now",
    availability: "running",
  },
  {
    name: "answer",
    args: "<text>",
    description: "Answer the leader's pending question",
    availability: "idle",
  },
  {
    name: "pause",
    description: "Pause queued turns, not the active agent",
    availability: "always",
  },
  { name: "continue", description: "Resume queued turns after a checkpoint", availability: "idle" },
  {
    name: "respond",
    args: "<question id> <JSON object>",
    description: "Respond to a structured tool question",
    availability: "always",
  },
  {
    name: "skip",
    args: "<question id>",
    description: "Decline a structured tool question",
    availability: "always",
  },
  {
    name: "dismiss",
    args: "<question id>",
    description: "Cancel a structured tool question",
    availability: "always",
  },
  {
    name: "approve",
    args: "<request id> <option number>",
    description: "Choose an offered permission option explicitly",
    availability: "always",
  },
  {
    name: "deny",
    args: "<request id>",
    description: "Deny a pending permission request",
    availability: "always",
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
 * Whether a command may run in the current phase.
 *
 * `availableCommands` decides what the palette *offers*; this is the same rule
 * applied to *running*, because typing a command out bypasses the palette
 * entirely. An unknown name is not "unavailable" — it is let through so the
 * caller's `default:` branch can report it.
 */
export function canRun(name: string, running: boolean): boolean {
  const command = COMMANDS.find((c) => c.name === name)
  if (!command) return true
  return availableCommands(running).includes(command)
}

/**
 * Why a command may not run in the current phase, or `undefined` when it may.
 *
 * The mirror of {@link canRun}, and the message names the phase the command
 * *wants* rather than just saying it is unavailable: the two directions mean
 * different things to the user. A mid-run `/replay` has to read as "wait for the
 * turn to finish", while an idle `/cancel` has to read as "this only applies to
 * a running turn" — one string for both would leave the user without the fact
 * they need to act on. An unknown name has no reason; it is let through so the
 * caller's `default:` branch can report it.
 */
export function unavailableReason(name: string, running: boolean): string | undefined {
  const command = COMMANDS.find((c) => c.name === name)
  if (!command || availableCommands(running).includes(command)) return undefined
  return running
    ? `/${name} waits for the current turn to finish`
    : `/${name} only applies while a turn is running`
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

/**
 * One row of the palette, whether it lists commands or their arguments.
 *
 * The label carries the leading slash (commands) or is a bare id (arguments),
 * so the renderer draws one shape for both panels and never needs to know which
 * it is showing.
 */
export interface PaletteRow {
  key: string
  label: string
  description: string
}

/** The palette rows for a command list, in the order given. */
export function paletteRows(commands: readonly CommandSpec[]): PaletteRow[] {
  return commands.map((command) => ({
    key: command.name,
    label: command.args ? `/${command.name} ${command.args}` : `/${command.name}`,
    description: command.description,
  }))
}

/**
 * The command whose first argument is being typed, and what has been typed so
 * far — or `undefined` when no argument completer applies.
 *
 * The mirror image of {@link menuQuery}: that one closes the moment a space is
 * typed, this one opens there. They are mutually exclusive, so the two palettes
 * can never be open at once.
 *
 * Only the first argument is recognised, which is all any current command needs
 * — a command with two completable arguments would extend this, not the caller.
 */
export function argQuery(text: string): { command: CommandSpec; partial: string } | undefined {
  if (!isCommandLine(text)) return undefined
  const match = /^(\S+)\s+(\S*)$/.exec(text)
  if (!match) return undefined
  const command = COMMANDS.find((c) => c.name === match[1].slice(1))
  if (!command?.completes) return undefined
  return { command, partial: match[2] }
}

/**
 * Agent ids matching a partial id, case-insensitively, capped at `limit`.
 *
 * An empty partial lists the whole roster (up to the cap), so `/focus ` alone is
 * a way to see who is available rather than an empty panel.
 */
export function completeAgents(partial: string, ids: readonly string[], limit = 8): string[] {
  const query = partial.toLowerCase()
  const matches = query ? ids.filter((id) => id.toLowerCase().startsWith(query)) : [...ids]
  return matches.slice(0, limit)
}

/**
 * Turn a typed agent id into the id it names, or the reason it does not.
 *
 * An exact id always wins; otherwise a unique prefix resolves, and an ambiguous
 * prefix reports every candidate so the user can see what to disambiguate
 * between. `/focus` and `/retry` share this so the two commands accept ids the
 * same way.
 */
export function resolveAgentId(
  input: string,
  ids: readonly string[]
): { id: string } | { error: string } {
  if (ids.includes(input)) return { id: input }
  const query = input.toLowerCase()
  const hits = ids.filter((id) => id.toLowerCase().startsWith(query))
  if (hits.length === 1) return { id: hits[0] }
  if (hits.length === 0) return { error: `unknown agent: ${input}` }
  return { error: `ambiguous: ${hits.join(", ")}` }
}
