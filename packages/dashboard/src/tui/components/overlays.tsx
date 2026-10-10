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

/** The `?` overlay. Replaces the body rather than floating, which keeps it legible. */
export function HelpOverlay({ width }: { width: number }) {
  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1} width={width}>
      <Text dimColor>? keys</Text>
      {HELP_GROUPS.map((group) => (
        <Box key={group.title} flexDirection="column" marginTop={1}>
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
      <Box marginTop={1}>
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
}: {
  turns: TurnView[]
  selected: number
  width: number
}) {
  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1} width={width}>
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
          {turns.map((turn, index) => {
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
        <Text dimColor>↑↓ select · enter open · esc close</Text>
      </Box>
    </Box>
  )
}
