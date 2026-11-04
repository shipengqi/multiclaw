import { Box, Text } from "ink"
import { COMMANDS } from "../commands"
import { formatAgo, padRight, truncate } from "../format"
import type { SessionMeta } from "../sessions"
import { COLOR, GLYPH } from "../theme"

interface HelpGroup {
  title: string
  rows: Array<[keys: string, description: string]>
}

/**
 * Grouped the way the user meets them: what the prompt does, then the panes,
 * then the command layer.
 *
 * The command layer lists only keys that are *not* slash commands — `/`, `?`,
 * `ctrl+c` — plus a single derived line counting the commands. It deliberately
 * does not enumerate them: the list would drift from `COMMANDS` the moment a
 * command is added, and it would not fit (see `helpRows`). The `/` palette is
 * built from `COMMANDS` itself, so it can never drift, and that is where the
 * enumeration belongs.
 */
export const HELP_GROUPS: readonly HelpGroup[] = [
  {
    title: "prompt",
    rows: [
      ["enter", "Run the requirement"],
      ["enter (busy)", "Queue only; the bar above decides tools and questions"],
      ["esc", "Clear the line, close an overlay"],
      ["← → home end", "Move the caret"],
      ["ctrl+v / alt+⌫", "Paste clipboard / remove last image"],
    ],
  },
  {
    title: "panes",
    rows: [
      ["tab", "Next agent"],
      ["⇧tab", "Toggle permission mode"],
      ["↑ ↓", "Scroll the stream one line"],
      ["pgup pgdn", "Scroll the stream a page"],
      ["ctrl+l", "Clear the current turn's output"],
    ],
  },
  {
    title: "commands",
    rows: [
      ["/", "Command menu"],
      ["?", "This help"],
      ["ctrl+c", "Cancel turn and queue · idle exits after cleanup"],
      ["/<command>", `All ${COMMANDS.length} commands — type / to browse`],
    ],
  },
]

const KEY_COLUMN = 16

/** Rows per list item in an overlay (2 content rows + 1 gap). */
const ITEM_ROWS = 3

/** Header, its gap, the list's gap and the footer. */
const OVERLAY_CHROME_ROWS = 4

/** How many items fit in a body of `maxRows`. Never fewer than one. */
export function overlayCapacity(maxRows: number): number {
  return Math.max(1, Math.floor((maxRows - OVERLAY_CHROME_ROWS) / ITEM_ROWS))
}

/**
 * The first item to draw, given the one the cursor is on.
 *
 * A generic list window — nothing here is specific to history — so the command
 * palette uses it too. The list can be longer than the body, so without this the
 * cursor walks off the bottom and `enter` opens a row the user cannot see —
 * which is exactly when the list is worth opening.
 */
export function listWindowStart(selected: number, total: number, capacity: number): number {
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
    <Box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={2}
      paddingTop={compact ? 0 : 1}
      width={width}
    >
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
 * The session picker: every session in the workspace, newest activity first.
 *
 * Switches between whole sessions — the thing a restart, a `/new`, or opening
 * the console again all create. The one the console is attached to is marked,
 * because "which am I on" is the first question the list has to answer.
 */
export function SessionsOverlay({
  sessions,
  selected,
  currentId,
  width,
  maxRows,
  now,
}: {
  sessions: SessionMeta[]
  selected: number
  currentId: string | undefined
  width: number
  /** Rows available in the body. The list is windowed against this. */
  maxRows: number
  now: number
}) {
  const capacity = overlayCapacity(maxRows)
  const start = listWindowStart(selected, sessions.length, capacity)
  const visible = sessions.slice(start, start + capacity)
  const range =
    sessions.length > capacity
      ? ` · showing ${start + 1}–${start + visible.length} of ${sessions.length}`
      : ""

  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} paddingTop={1} width={width}>
      <Box justifyContent="space-between">
        <Text dimColor>SESSIONS</Text>
        <Text dimColor>
          {sessions.length} total{range}
        </Text>
      </Box>

      {sessions.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No sessions yet.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((session, offset) => {
            const index = start + offset
            const focused = index === selected
            const current = session.id === currentId
            const count = session.turnCount
            return (
              <Box key={session.id} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                <Box>
                  <Text color={focused ? COLOR.accent : undefined}>
                    {focused ? `${GLYPH.caret} ` : "  "}
                  </Text>
                  <Text bold={focused} color={focused ? COLOR.accent : undefined}>
                    {current ? "● " : ""}
                    {truncate(session.title || "(untitled session)", Math.max(8, width - 30))}
                  </Text>
                </Box>
                <Text dimColor>
                  {"    "}
                  {count} turn{count === 1 ? "" : "s"} · {formatAgo(session.lastActiveAt, now)}
                  {current ? " · current" : ""}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ select · enter open · d delete · esc close</Text>
      </Box>
    </Box>
  )
}
