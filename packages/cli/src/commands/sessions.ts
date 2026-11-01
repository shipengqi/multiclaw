import { loadConfig } from "../loader/loadConfig"
import { deletePruneItems, type PruneItem, scanPruneItems } from "./prune"

export interface SessionsCommandOptions {
  config?: string
}

function sessionItems(workDir: string): PruneItem[] {
  return scanPruneItems(workDir).filter((item) => item.kind === "session")
}

/** `multiclaw sessions ls` — list saved sessions, newest first. */
export async function sessionsListCommand(options: SessionsCommandOptions): Promise<void> {
  const config = await loadConfig(options.config)
  const items = sessionItems(config.workDir)
  if (items.length === 0) {
    console.log("No saved sessions.")
    return
  }
  for (const item of items) {
    console.log(`  \x1b[2m${item.id}\x1b[0m  ${item.label}`)
  }
}

/**
 * `multiclaw sessions rm <id>` — delete a session by id or a unique prefix.
 *
 * A prefix is accepted because the ids are UUIDs no one types in full. An
 * ambiguous prefix is refused rather than guessed, so a `rm` never deletes a
 * session the user did not mean.
 */
export async function sessionsRemoveCommand(
  id: string,
  options: SessionsCommandOptions
): Promise<void> {
  const config = await loadConfig(options.config)
  const items = sessionItems(config.workDir)
  const exact = items.find((item) => item.id === id)
  const matches = exact ? [exact] : items.filter((item) => item.id.startsWith(id))

  if (matches.length === 0) {
    console.error(`No session matching "${id}".`)
    process.exitCode = 1
    return
  }
  if (matches.length > 1) {
    console.error(
      `"${id}" matches ${matches.length} sessions — use more of the id:\n${matches
        .map((m) => `  ${m.id}`)
        .join("\n")}`
    )
    process.exitCode = 1
    return
  }

  const { deleted, failed } = deletePruneItems(matches)
  if (deleted.length > 0) {
    console.log(`\x1b[32m✓\x1b[0m Removed session ${matches[0].id}`)
  }
  if (failed.length > 0) {
    console.error(`\x1b[31m✗\x1b[0m Failed to remove ${matches[0].id}: ${failed[0].error}`)
    process.exitCode = 1
  }
}
