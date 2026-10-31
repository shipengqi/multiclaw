/**
 * Terminal geometry.
 *
 * Kept pure and separate from the components because responsive rules are the
 * part of a TUI that is easiest to get subtly wrong and hardest to eyeball. Every
 * row the console spends is budgeted here, so the arithmetic is testable rather
 * than buried in JSX.
 */

export const MIN_COLUMNS = 40
export const MIN_ROWS = 10

/** Below this the roster is dropped so the stream keeps a usable width. */
export const COMPACT_COLUMNS = 72

/** The rail costs a row; it only earns one when there is vertical room. */
export const RAIL_MIN_ROWS = 16

/**
 * The most rows the pipeline rail is ever allowed to occupy.
 *
 * The rail wraps, so its height depends on how many agents the turn has and how
 * wide the terminal is. Without a cap it could eat the whole screen; with one,
 * the budget stays honest and anything past it is clipped rather than silently
 * swallowed by the body.
 */
export const MAX_RAIL_ROWS = 2

/** Enough to see the palette is a list; more would push the stream off screen. */
export const MAX_MENU_ROWS = 7

/** Queued follow-ups sit above the prompt; more than a few would crowd the stream. */
export const MAX_QUEUE_ROWS = 3

/**
 * The most rows the interaction bar is ever allowed to occupy.
 *
 * An agent blocked on a permission or a question is the one thing on screen
 * worth acting on, so its bar is allowed more room than a queue or a palette —
 * but not unlimited: it is docked *beside* the stream, and a bar tall enough to
 * push the stream out would undo the reason it was docked.
 */
export const MAX_INTERACTION_ROWS = 10

/**
 * The fewest rows worth docking the bar for.
 *
 * Header, title, one option and the hint is the least that can be read and acted
 * on. Below that the bar would be a header with no choices under it, which is
 * worse than leaving the stream alone and deciding by command.
 */
export const MIN_INTERACTION_ROWS = 4

/** Rows that must survive the budget no matter how small the terminal is. */
const MIN_BODY_ROWS = 3

export interface LayoutInput {
  columns: number
  rows: number
  /** Zero means no turn has run yet, which swaps the body for the welcome screen. */
  turn: number
  /** A modal owns the body — help or the history list. */
  overlay: boolean
  /** Rows the command palette is asking for. */
  menuRows: number
  /** Rows the queued follow-ups are asking for. */
  queueRows?: number
  /**
   * Rows the interaction bar is asking for.
   *
   * It docks above the prompt rather than replacing the body, so its rows come
   * out of the same budget as every other piece of chrome — an unbudgeted row
   * here would show up as a stream pane that silently loses its last line.
   */
  interactionRows?: number
  /**
   * Rows the prompt is asking for.
   *
   * The prompt wraps, so a long input makes it grow — one row per line typed
   * past the terminal's width. Left out, it is the one row it used to be, so a
   * caller that has not measured the text keeps the old budget rather than
   * silently reserving nothing.
   */
  promptRows?: number
  /** Whether a command result is waiting to be shown. */
  notice: boolean
  /** A past turn is open for reading, which costs a banner row. */
  viewing?: boolean
  /** Whether there is a leader or any stage to draw. */
  hasRail: boolean
  /**
   * Rendered widths of the rail's cells, widest first is not required — order
   * is what the rail draws. Needed because the rail wraps: its height is a
   * function of the content, so a flat "one row" charge under-budgets it.
   */
  railCells?: number[]
}

export interface Layout {
  columns: number
  rows: number
  compact: boolean
  showTeam: boolean
  showRail: boolean
  /** How many rows the rail will actually occupy once it wraps. */
  railRows: number
  welcome: boolean
  bodyHeight: number
  logViewport: number
  teamWidth: number
  /**
   * Text columns available to the stream pane's *content* — the roster, the
   * rule between the panes and the stream's own left padding already taken out.
   *
   * The stream pre-wraps its output, so it has to know this before Ink lays
   * anything out; there is no way to measure it back out of Yoga. The arithmetic
   * is therefore deliberate about erring small: a row wrapped a column early
   * costs a few characters of width, while a row wrapped a column late would be
   * cut at the pane edge — the bug this exists to prevent.
   */
  streamWidth: number
  menuRows: number
  queueRows: number
  interactionRows: number
}

/**
 * How many rows the rail occupies given the widths of the cells it draws.
 *
 * Approximate on purpose: Yoga's own wrapping depends on margins and on how the
 * terminal renders wide glyphs, and chasing exactness here is not worth it. The
 * number is capped and the rail is clipped, so an under-count costs the last
 * chip rather than collapsing the layout.
 */
export function measureRailRows(cells: number[] | undefined, columns: number): number {
  if (!cells || cells.length === 0) return 0
  if (columns <= 0) return MAX_RAIL_ROWS

  let rows = 1
  let used = 0
  for (const cell of cells) {
    if (used > 0 && used + cell > columns) {
      rows += 1
      if (rows >= MAX_RAIL_ROWS) return MAX_RAIL_ROWS
      used = cell
    } else {
      used += cell
    }
  }
  return rows
}

export function computeLayout(input: LayoutInput): Layout {
  const columns = Math.max(MIN_COLUMNS, input.columns)
  const rows = Math.max(MIN_ROWS, input.rows)

  const compact = columns < COMPACT_COLUMNS
  const welcome = !input.overlay && input.turn === 0
  // The welcome screen already introduces the team, so the rail would only
  // repeat it — and at that point there are no stages to draw anyway. A modal
  // suppresses the rail too: otherwise opening help on the first screen would
  // *add* a rail that was not there a keystroke ago.
  const showRail = !welcome && !input.overlay && rows >= RAIL_MIN_ROWS && input.hasRail
  const menuRows = Math.min(Math.max(0, input.menuRows), MAX_MENU_ROWS)
  const queueRows = Math.min(Math.max(0, input.queueRows ?? 0), MAX_QUEUE_ROWS)
  // At least one row: the prompt is always on screen, even while it is empty.
  const promptRows = Math.max(1, input.promptRows ?? 1)
  // At least one row when there is a rail at all: a caller that does not measure
  // the cells gets the old flat assumption rather than silently reserving nothing.
  const railRows = showRail
    ? Math.min(MAX_RAIL_ROWS, Math.max(1, measureRailRows(input.railCells, columns)))
    : 0

  // Everything except the interaction bar, so the bar can be given only what is
  // actually left. Without this clamp a tall bar on a short terminal pushes the
  // total past `rows`, and what Ink drops is the bottom of the tree — the prompt
  // and the hint bar, which are the two rows the user is typing into.
  const chrome =
    1 + // header
    1 + // rule under the header
    (railRows > 0 ? railRows + 1 : 0) + // pipeline rail plus the gap above it
    1 + // gap before the body
    (input.notice ? 1 : 0) +
    (input.viewing ? 1 : 0) + // "viewing turn N" banner
    queueRows +
    menuRows +
    promptRows +
    1 // hint bar
  const barRoom = Math.max(0, rows - chrome - MIN_BODY_ROWS - 1) // -1 for the gap above it
  const interactionRows =
    barRoom < MIN_INTERACTION_ROWS
      ? 0
      : Math.min(Math.max(0, input.interactionRows ?? 0), MAX_INTERACTION_ROWS, barRoom)

  // Every row the chrome takes, so the body can be given whatever is left. This
  // has to be exact: when the column overflows, Yoga shrinks whichever child it
  // can, and an unbudgeted row shows up as a header that silently vanishes.
  const reserved = chrome + (interactionRows > 0 ? interactionRows + 1 : 0)

  const bodyHeight = Math.max(MIN_BODY_ROWS, rows - reserved)
  const showTeam = !compact
  const teamWidth = Math.min(30, Math.max(18, Math.floor(columns * 0.24)))
  // Columns the stream cannot draw text in: the roster, the rule between the
  // panes, and the stream's own one-column left padding. The roster's right
  // padding is already inside `teamWidth`.
  const streamChrome = (showTeam ? teamWidth + 1 : 0) + 1
  const streamWidth = Math.max(1, columns - streamChrome - 1)

  return {
    columns,
    rows,
    compact,
    showTeam,
    showRail,
    railRows,
    welcome,
    bodyHeight,
    // The stream spends one of the body's rows on its own header.
    logViewport: Math.max(1, bodyHeight - 1),
    teamWidth,
    streamWidth,
    menuRows,
    queueRows,
    interactionRows,
  }
}
