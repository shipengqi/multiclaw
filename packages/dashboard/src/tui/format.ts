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
