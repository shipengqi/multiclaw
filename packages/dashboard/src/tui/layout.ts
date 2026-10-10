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

/** Enough to see the palette is a list; more would push the stream off screen. */
export const MAX_MENU_ROWS = 7

/** Queued follow-ups sit above the prompt; more than a few would crowd the stream. */
export const MAX_QUEUE_ROWS = 3

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
  /** Whether a command result is waiting to be shown. */
  notice: boolean
  /** A past turn is open for reading, which costs a banner row. */
  viewing?: boolean
  /** Whether there is a leader or any stage to draw. */
  hasRail: boolean
}

export interface Layout {
  columns: number
  rows: number
  compact: boolean
  showTeam: boolean
  showRail: boolean
  welcome: boolean
  bodyHeight: number
  logViewport: number
  teamWidth: number
  menuRows: number
  queueRows: number
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

  // Every row the chrome takes, so the body can be given whatever is left. This
  // has to be exact: when the column overflows, Yoga shrinks whichever child it
  // can, and an unbudgeted row shows up as a header that silently vanishes.
  const reserved =
    1 + // header
    1 + // rule under the header
    (showRail ? 2 : 0) + // pipeline rail plus the gap above it
    1 + // gap before the body
    (input.notice ? 1 : 0) +
    (input.viewing ? 1 : 0) + // "viewing turn N" banner
    queueRows +
    menuRows +
    1 + // prompt
    1 // hint bar

  const bodyHeight = Math.max(MIN_BODY_ROWS, rows - reserved)

  return {
    columns,
    rows,
    compact,
    showTeam: !compact,
    showRail,
    welcome,
    bodyHeight,
    // The stream spends one of the body's rows on its own header.
    logViewport: Math.max(1, bodyHeight - 1),
    teamWidth: Math.min(30, Math.max(18, Math.floor(columns * 0.24))),
    menuRows,
    queueRows,
  }
}
