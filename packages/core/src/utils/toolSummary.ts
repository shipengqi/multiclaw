/**
 * One-line summaries of an agent's tool activity.
 *
 * A tool call or result is a glance, not a transcript: the stream pane wants a
 * single scannable row per tool, and the raw payloads are frequently multi-line
 * (a whole file, a command's output). These helpers reduce any payload to one
 * truncated line and are deliberately total — a summary is diagnostics and must
 * never be the reason a run fails.
 */

/**
 * How many columns of a summary are kept before it is truncated.
 *
 * Chosen to roughly fill a wide stream pane without wrapping, so one tool is one
 * row. Past this the row stops being scannable and starts crowding the agent's
 * prose out of view.
 */
const MAX_SUMMARY_COLUMNS = 120

/** Stringify a value without ever throwing — a circular structure is the trap. */
function stringifySafe(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    // `JSON.stringify` throws on a circular reference (and on a BigInt). A tool
    // summary is not worth a failed run, so fall back to the value's own string
    // form, which is still useful and cannot throw.
    return String(value)
  }
}

/** Reduce any value to its first line, truncated to {@link MAX_SUMMARY_COLUMNS}. */
function firstLineTruncated(value: unknown): string {
  const text = stringifySafe(value)
  const newline = text.indexOf("\n")
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  if (firstLine.length <= MAX_SUMMARY_COLUMNS) return firstLine
  return `${firstLine.slice(0, MAX_SUMMARY_COLUMNS - 1)}…`
}

/**
 * Whether a tool call was given any arguments.
 *
 * "No arguments yet" reaches us as `{}` (or missing) rather than as
 * `undefined`: ACP announces a call before its input has finished streaming.
 * Both mean the same thing to a reader — there is nothing to show yet — so the
 * two are collapsed here instead of at every call site.
 */
export function hasToolArgs(input: unknown): boolean {
  if (input === undefined || input === null) return false
  if (typeof input !== "object" || Array.isArray(input)) return true
  return Object.keys(input).length > 0
}

/** One-line summary of a tool call's input. `input` is untrusted and may be circular. */
export function summarizeToolInput(input: unknown): string {
  // An empty object would render as the literal `{}`, which tells a reader
  // nothing and reads as a bug. Empty means "say nothing".
  return hasToolArgs(input) ? firstLineTruncated(input) : ""
}

/** One-line summary of a tool result's output, which may be a string or a value. */
export function summarizeToolOutput(output: unknown): string {
  return firstLineTruncated(output)
}
