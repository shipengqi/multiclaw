import type { SupplementReport } from "@multiclawcli/core"
import stringWidth from "string-width"

/**
 * Truncate to `max` columns, ending in an ellipsis when it does not fit.
 *
 * Counts code units rather than grapheme clusters, which is what Ink's own
 * `wrap="truncate-end"` does; matching it keeps hand-truncated and
 * Ink-truncated strings the same width.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * How many terminal columns a string occupies.
 *
 * Deliberately not `text.length`: a CJK character is one code unit and *two*
 * columns, so counting code units would size a Chinese line at half the pane
 * and hand it to Ink to cut — the same truncation bug in a new place. Emoji and
 * combining marks are wrong for the same reason.
 */
export function displayWidth(text: string): number {
  return stringWidth(text)
}

/**
 * Break one line of text into the rows a terminal will actually spend on it.
 *
 * Word-wrapped, because the stream pane carries an agent's prose as often as it
 * carries log lines, and breaking mid-word would make the leader's reasoning
 * harder to read than the truncation this replaced. A word with no space inside
 * it — a path, a hash, a minified JSON blob — has nowhere to break, so it is
 * split by width instead.
 *
 * Scripts that use wide characters get the rule they actually have: they put no
 * spaces between words, so a whole Chinese sentence arrives as one "word" and
 * would be pushed onto the next row whole, leaving the row before it mostly
 * empty. They may be broken between any two characters instead, so they fill
 * what is left. Narrow runs — English words, identifiers, numbers — are still
 * atomic, which is what keeps this a no-op for output that has no CJK in it.
 *
 * Every returned row is at most `width` columns, which is what lets the caller
 * count rows and trust the count.
 */
export function wrapLine(line: string, width: number): string[] {
  const limit = Math.max(1, width)
  if (line === "") return [""]

  const rows: string[] = []
  let row = ""
  // Tracked separately from `row` because an empty row and a row that has not
  // been started yet are different: splitting on " " yields empty words for runs
  // of spaces, and those must keep their separator rather than restart the row.
  let empty = true

  const flush = () => {
    if (!empty) rows.push(row)
    row = ""
    empty = true
  }

  /** Give a word that has no room left on this row its own rows. */
  const overflow = (word: string) => {
    const chunks = splitByWidth(word, limit)
    // Every chunk but the last fills a row by itself; the last one opens the
    // next row, where the following words can still join it.
    for (const chunk of chunks.slice(0, -1)) rows.push(chunk)
    row = chunks[chunks.length - 1]
    empty = row === ""
  }

  for (const word of line.split(" ")) {
    const candidate = empty ? word : `${row} ${word}`
    if (displayWidth(candidate) <= limit) {
      row = candidate
      empty = false
      continue
    }
    // The word does not fit as it stands. A wide-character script can still
    // take the rest of this row; anything else is pushed whole.
    const head = breakableHead(empty ? "" : row, word, limit)
    if (head === 0) {
      flush()
      overflow(word)
      continue
    }
    rows.push(empty ? word.slice(0, head) : `${row} ${word.slice(0, head)}`)
    overflow(word.slice(head))
  }

  flush()
  return rows
}

/**
 * Characters that may not begin a row.
 *
 * A Chinese comma or full stop belongs to the sentence in front of it, so a row
 * starting with one reads as a broken sentence — 避头尾, the rule Chinese
 * typesetting uses for exactly this. Only the closers are listed: they are the
 * ones a break in front of them would strand, and a break is only ever offered
 * in front of a character.
 */
const CLOSERS = "。，、；：？！）］｝」』】》〉”’…—·"

/**
 * How many leading characters of `word` fit on a row already holding `row`.
 *
 * Only positions next to a wide character are offered, because that is where
 * the script's own breaks are: a Chinese sentence may be broken between any two
 * characters, while a run of narrow ones — an English word, an identifier, a
 * number — may not, and splitting those mid-word is the thing word-wrapping
 * exists to avoid. Zero means the word cannot usefully be broken here at all.
 */
function breakableHead(row: string, word: string, limit: number): number {
  const chars = [...word]
  // The separator the word would have been joined with, if the row is not fresh.
  let used = row === "" ? 0 : displayWidth(row) + 1
  let head = 0
  for (let i = 0; i < chars.length; i++) {
    const charWidth = displayWidth(chars[i])
    if (used + charWidth > limit) break
    used += charWidth
    const next = chars[i + 1]
    // A break here would put punctuation at the start of the next row.
    if (next !== undefined && CLOSERS.includes(next)) continue
    // A break is allowed after a wide character, and before one.
    if (charWidth >= 2 || (next !== undefined && displayWidth(next) >= 2)) head = i + 1
  }
  return head
}

/**
 * Split a word with no break opportunities into `width`-column chunks.
 *
 * Always returns at least one chunk — an empty word yields `[""]` — so callers
 * can take the last one as the row to keep building on.
 */
function splitByWidth(text: string, width: number): string[] {
  const chunks: string[] = []
  let chunk = ""
  // Carried rather than re-measured: `displayWidth` on a growing string would
  // make this quadratic, and the buffer it runs on is capped at 8k characters.
  let used = 0
  for (const char of text) {
    const charWidth = displayWidth(char)
    if (chunk !== "" && used + charWidth > width) {
      chunks.push(chunk)
      chunk = char
      used = charWidth
    } else {
      chunk += char
      used += charWidth
    }
  }
  chunks.push(chunk)
  return chunks
}

/**
 * Human duration, used for every time column in the console.
 *
 * One formatter everywhere is what makes the columns comparable — the eye can
 * scan a stack of durations only if they share a shape.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`

  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"

/** Stage markers read as an ordered sequence at a glance; past twenty, fall back. */
export function circled(n: number): string {
  return CIRCLED[n - 1] ?? `(${n})`
}

/** Pad to a fixed column so sibling rows line up. */
export function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}

/** Elapsed time of a run that is still in flight, or its total once it has ended. */
export function elapsedSince(startedAt: number | undefined, now: number): number | undefined {
  if (startedAt === undefined) return undefined
  return Math.max(0, now - startedAt)
}

/** One decimal place, with a trailing ".0" dropped: 45.2 → "45.2", 200 → "200". */
function oneDecimal(value: number): string {
  const fixed = value.toFixed(1)
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed
}

/**
 * A compact token count, for a column that must stay narrow.
 *
 * `45200 → "45.2k"`, `950 → "950"`, `1_200_000 → "1.2M"`. Below a thousand the
 * exact number is short enough to show; above it the decimal is what the eye
 * reads, so the digits past it are dropped.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—"
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${oneDecimal(n / 1_000)}k`
  return `${oneDecimal(n / 1_000_000)}M`
}

/**
 * A USD cost, at the precision a session total is read at.
 *
 * `0.42 → "$0.42"`, `0 → "$0.00"`, and anything under a cent as `"<$0.01"` rather
 * than rounding it away to "$0.00" — a real but tiny cost must not read as free.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "—"
  if (usd === 0) return "$0.00"
  if (usd < 0.01) return "<$0.01"
  return `$${usd.toFixed(2)}`
}

/**
 * What to tell the user after a mid-turn message.
 *
 * Reports are per agent and each carries its own reason, so the sentence names
 * agents rather than summarising an outcome: "steered architect · leader was
 * between turns" tells the user what happened to whom, while "steering failed"
 * tells them nothing they can act on.
 *
 * `error` and `idle` must never be collapsed: the first is a delivery that went
 * wrong, the second is a message that arrived at the wrong moment. Calling the
 * first the second would tell the user to simply wait when they should be
 * looking at a failure.
 *
 * When nothing was delivered the caller queues the text, so the sentence says
 * so — otherwise the user is left believing their message is inside the turn
 * they are watching.
 */
export function describeSteering(reports: readonly SupplementReport[]): string {
  const names = (list: readonly SupplementReport[]) =>
    list.map((report) => report.agentId).join(", ")
  const of = (status: SupplementReport["status"]) =>
    reports.filter((report) => report.status === status)
  const injected = of("injected")
  const idle = of("idle")
  const unsupported = of("unsupported")
  const failed = of("error")
  const why = failed.find((report) => report.error)?.error ?? "unknown error"

  if (injected.length > 0) {
    const parts = [`steered ${names(injected)}`]
    if (idle.length > 0) {
      parts.push(`${names(idle)} ${idle.length === 1 ? "was" : "were"} between turns`)
    }
    if (unsupported.length > 0) parts.push(`${names(unsupported)} cannot take mid-turn input`)
    // No "queued" here on purpose: part of the message did land, so replaying it
    // as the next turn would say everything twice.
    if (failed.length > 0) parts.push(`${names(failed)} could not take it: ${why}`)
    return parts.join(" · ")
  }
  if (failed.length > 0) return `could not reach ${names(failed)}: ${why} — queued as a follow-up`
  if (unsupported.length > 0) {
    return "no running agent can take mid-turn input — queued as a follow-up"
  }
  return "no agent was mid-turn — queued as a follow-up"
}
