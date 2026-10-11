import type { TurnRecord } from "../types/config"

/**
 * How many earlier turns the leader is shown.
 *
 * Deliberately small. The point is to resolve an anaphoric answer — "Postgres",
 * "the second one", "yes" — and that only ever needs the turn or two behind it.
 * A long transcript would spend the leader's attention on work that is already
 * done and written to the workspace, which it can read instead.
 */
export const MAX_CONVERSATION_TURNS = 6

/**
 * Ceiling on the rendered block, in characters.
 *
 * Oldest turns are dropped to stay under it. A budget rather than a turn count
 * alone because a requirement can be a pasted stack trace; six of those would
 * otherwise bury the one turn that actually matters.
 */
export const MAX_CONVERSATION_CHARS = 4000

/** Ceiling on any single requirement or message, in characters. */
const MAX_ENTRY_CHARS = 600

const ELLIPSIS = "…"

/** Trim, then clip to `max`, marking the cut so it cannot read as complete. */
function clip(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}${ELLIPSIS}`
}

/**
 * One turn, addressed from the leader's point of view.
 *
 * "you asked" rather than "the leader asked": the block goes into the leader's
 * own prompt, and the second person is what makes it obvious that those words
 * were its own and that it is expected to act on the answer now.
 */
function entry(turn: TurnRecord, index: number): string {
  const lines = [`${index}. user: ${clip(turn.requirement, MAX_ENTRY_CHARS)}`]
  if (turn.reply) {
    const verb = turn.reply.mode === "ask" ? "asked" : "answered"
    lines.push(`   you ${verb}: ${clip(turn.reply.message, MAX_ENTRY_CHARS)}`)
  }
  return lines.join("\n")
}

/**
 * Render earlier turns into a block for the leader's prompt, or "" when there
 * are none.
 *
 * Empty rather than a placeholder: the leader's template carries `{{…}}` for it,
 * and an unresolved placeholder would be handed to the model as literal text.
 *
 * The newlines belong to the block, not to the template — a section that is not
 * there must not leave its blank lines behind.
 */
export function renderConversation(history: readonly TurnRecord[] | undefined): string {
  if (!history || history.length === 0) return ""

  const recent = history.slice(-MAX_CONVERSATION_TURNS)
  // Numbering stays absolute — "turn 7" is the turn the user can point at in
  // their own scrollback, and renumbering a trimmed window would silently
  // renumber the conversation underneath them.
  const first = history.length - recent.length
  const entries = recent.map((turn, i) => entry(turn, first + i + 1))

  // Oldest-first is the order worth reading, so the block is built forwards and
  // trimmed from the front. Dropping the newest instead would remove the turn
  // this requirement is most likely answering.
  while (entries.length > 1 && entries.join("\n").length > MAX_CONVERSATION_CHARS) {
    entries.shift()
  }

  const body = clip(entries.join("\n"), MAX_CONVERSATION_CHARS)
  return `\n## Conversation so far\n\nEarlier turns of this session, oldest first:\n\n${body}\n`
}
