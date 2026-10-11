import { Box, Text } from "ink"
import { formatDuration, padRight, truncate } from "../format"
import { progress, type TurnView } from "../state"
import { COLOR, GLYPH, STATUS } from "../theme"

interface HelpGroup {
  title: string
  rows: Array<[keys: string, description: string]>
}

/**
 * Grouped the way the user meets them: what the prompt does, then the panes,
 * then the command layer. Anything not listed here does not exist.
 */
export const HELP_GROUPS: readonly HelpGroup[] = [
  {
    title: "prompt",
    rows: [
      ["enter", "Run the requirement"],
      ["enter (busy)", "Queue it to run next"],
      ["esc", "Clear the line, close an overlay"],
      ["← → home end", "Move the caret"],
    ],
  },
  {
    title: "panes",
    rows: [
      ["tab  ⇧tab", "Next / previous agent"],
      ["↑ ↓", "Scroll the stream one line"],
      ["pgup pgdn", "Scroll the stream a page"],
      ["ctrl+l", "Clear the focused log"],
      ["esc", "Stop reading a past turn"],
    ],
  },
  {
    title: "commands",
    rows: [
      ["/", "Command menu"],
      ["/history", "Browse finished turns"],
      ["?", "This help"],
      ["ctrl+c", "Cancel the turn and its queue · again to quit"],
    ],
  },
]

const KEY_COLUMN = 16

/**
 * One turn in the history list: the outcome row, the requirement row, and the
 * gap between turns.
 */
const TURN_ROWS = 3

/** Header, its gap, the list's gap and the footer. */
const HISTORY_CHROME_ROWS = 4

/** How many turns fit in a body of `maxRows`. Never fewer than one. */
export function historyCapacity(maxRows: number): number {
  return Math.max(1, Math.floor((maxRows - HISTORY_CHROME_ROWS) / TURN_ROWS))
}

/**
 * The first turn to draw, given the one the cursor is on.
 *
 * The list can be longer than the body, so without this the cursor walks off the
 * bottom and `enter` opens a turn the user cannot see — which is exactly when
 * the list is worth opening.
 */
export function historyWindowStart(selected: number, total: number, capacity: number): number {
  const maxStart = Math.max(0, total - capacity)
  // Keep the selection on the last row when it moves past the bottom, and on the
  // first when it moves back above it.
  return Math.min(Math.max(0, Math.min(selected, selected - capacity + 1)), maxStart)
}

/** Rows the help screen occupies, with or without the gaps between groups. */
export function helpRows(compact = false): number {
  const gap = compact ? 0 : 1
  const groups = HELP_GROUPS.reduce((total, group) => total + gap + 1 + group.rows.length, 0)
  return 1 + gap + groups + gap + 1
}

/**
 * The `?` overlay. Replaces the body rather than floating, which keeps it legible.
 *
 * `flexShrink={0}` so a body smaller than the content clips it rather than
 * folding the rows into each other — the body does the clipping, and overlap is
 * strictly worse than a missing row.
 *
 * When even the compact form does not fit, what gets clipped is the bottom, so
 * the spacing between groups is the first thing to go: on a 24-row terminal the
 * difference is whether "esc or ? to close" survives.
 */
export function HelpOverlay({ width, maxRows }: { width: number; maxRows: number }) {
  const compact = helpRows(false) > maxRows
  const gap = compact ? 0 : 1

  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} paddingTop={1} width={width}>
      <Text dimColor>? keys</Text>
      {HELP_GROUPS.map((group) => (
        <Box key={group.title} flexDirection="column" marginTop={gap}>
          <Text dimColor>{group.title}</Text>
          {group.rows.map(([keys, description]) => (
            <Box key={keys}>
              <Text color={COLOR.accent}>{padRight(keys, KEY_COLUMN)}</Text>
              <Text dimColor wrap="truncate-end">
                {description}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={gap}>
        <Text dimColor>esc or ? to close</Text>
      </Box>
    </Box>
  )
}

/**
 * How a finished turn ended, in the same words the footer uses.
 *
 * A turn that ended in a reply is not a "done" — nothing was built — so it gets
 * its own phrasing rather than being folded into success.
 */
function outcome(turn: TurnView): { text: string; color: string } {
  if (turn.reply) {
    return turn.reply.mode === "ask"
      ? { text: `${GLYPH.ask} needs input`, color: COLOR.warn }
      : { text: `${STATUS.success.glyph} answered`, color: COLOR.ok }
  }
  if (turn.phase !== "complete") return { text: "interrupted", color: COLOR.warn }
  return turn.success
    ? { text: `${STATUS.success.glyph} done`, color: COLOR.ok }
    : { text: `${STATUS.failed.glyph} failed`, color: COLOR.error }
}

/**
 * The finished turns, newest first.
 *
 * Two rows per turn on purpose: the requirement is the thing a reader is
 * scanning for, and folding it onto the same line as the outcome would truncate
 * exactly the part that identifies the turn.
 *
 * Only turns a newer turn has superseded are listed — the one being run is
 * already on screen, so listing it would offer to show the user what they are
 * looking at.
 */
export function HistoryOverlay({
  turns,
  selected,
  width,
  maxRows,
}: {
  turns: TurnView[]
  selected: number
  width: number
  /** Rows available in the body. The list is windowed against this. */
  maxRows: number
}) {
  const capacity = historyCapacity(maxRows)
  const start = historyWindowStart(selected, turns.length, capacity)
  const visible = turns.slice(start, start + capacity)
  const range =
    turns.length > capacity
      ? ` · showing ${start + 1}–${start + visible.length} of ${turns.length}`
      : ""

  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} paddingTop={1} width={width}>
      <Box justifyContent="space-between">
        <Text dimColor>HISTORY</Text>
        <Text dimColor>{turns.length} earlier</Text>
      </Box>

      {turns.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No earlier turns yet.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((turn, offset) => {
            const index = start + offset
            const focused = index === selected
            const state = outcome(turn)
            const { done, total } = progress(turn)
            const time =
              turn.totalDuration === undefined ? "" : ` · ${formatDuration(turn.totalDuration)}`
            return (
              <Box key={turn.turn} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                <Box>
                  <Text color={focused ? COLOR.accent : undefined}>
                    {focused ? `${GLYPH.caret} ` : "  "}
                  </Text>
                  <Text bold={focused} color={focused ? COLOR.accent : undefined}>
                    turn {turn.turn}
                  </Text>
                  <Text color={state.color}> · {state.text}</Text>
                  <Text dimColor>
                    {time} · {done}/{total} agents
                  </Text>
                </Box>
                <Text dimColor wrap="truncate-end">
                  {"    "}
                  {truncate(turn.requirement ?? "(no requirement)", Math.max(8, width - 6))}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{`↑↓ select · enter open · esc close${range}`}</Text>
      </Box>
    </Box>
  )
}
