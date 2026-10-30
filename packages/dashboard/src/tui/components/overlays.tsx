import type { RuntimePermissionRequest, RuntimeQuestionRequest } from "@multiclawcli/core"
import { Box, Text } from "ink"
import { COMMANDS } from "../commands"
import { formatDuration, padRight, truncate, wrapLine } from "../format"
import { progress, stripAnsi, type TurnView } from "../state"
import { COLOR, GLYPH, STATUS } from "../theme"

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
      ["enter (busy)", "Queue only; /approve tools, /respond questions"],
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
      ["?", "This help"],
      ["ctrl+c", "Cancel turn and queue · idle exits after cleanup"],
      ["/<command>", `All ${COMMANDS.length} commands — type / to browse`],
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

export function PermissionOverlay({
  request,
  shortId,
  queued,
  width,
  maxRows,
}: {
  request: RuntimePermissionRequest
  shortId: string
  queued: number
  width: number
  maxRows: number
}) {
  const clean = (value: string) => stripAnsi(value).replace(/\p{Cc}/gu, " ")
  const input =
    request.input === undefined ? "(no input)" : (JSON.stringify(request.input) ?? "(no input)")
  const inputRows = Math.max(1, Math.min(3, maxRows - request.options.length - 7))
  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} width={width}>
      <Text bold color={COLOR.warn} wrap="truncate-end">
        {`PERMISSION ${shortId} · ${queued} pending · ${clean(request.agentId)}`}
      </Text>
      <Text wrap="truncate-end">{clean(request.title)}</Text>
      <Text dimColor wrap="truncate-end">
        {`request ${clean(request.requestId)} · ${clean(request.toolName ?? request.kind ?? request.toolCallId)}`}
      </Text>
      <Text color={COLOR.accent} wrap="truncate-end">
        {`/approve ${shortId} <number> · /deny ${shortId}`}
      </Text>
      <Text dimColor wrap="truncate-end">
        Ordinary text queues a follow-up; it never grants permission.
      </Text>
      <Box height={inputRows} overflow="hidden" flexShrink={0}>
        <Text>{`input: ${clean(input)}`}</Text>
      </Box>
      {request.options.map((option, index) => (
        <Text key={option.optionId} wrap="truncate-end">
          {`${index + 1}. ${clean(option.name)} (${option.kind})`}
        </Text>
      ))}
    </Box>
  )
}

export function questionLines(request: RuntimeQuestionRequest, width: number): string[] {
  const lines = [request.message, `request ${request.requestId}`]
  for (const [key, field] of Object.entries(request.requestedSchema.properties ?? {})) {
    const schema = field as Record<string, unknown>
    const items = schema.items as Record<string, unknown> | undefined
    const choices = (schema.oneOf ?? schema.enum ?? items?.anyOf ?? items?.enum) as
      | Array<string | { const: string; title?: string; description?: string }>
      | undefined
    lines.push(
      `${key}${request.requestedSchema.required?.includes(key) ? " *" : ""}: ${typeof schema.title === "string" ? schema.title : key} (${field.type})`
    )
    if (typeof schema.description === "string") lines.push(schema.description)
    const limits = [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "uniqueItems",
    ]
      .filter((limit) => schema[limit] !== undefined && schema[limit] !== null)
      .map((limit) => `${limit}=${schema[limit]}`)
    if (limits.length) lines.push(limits.join(" · "))
    for (const choice of choices ?? []) {
      lines.push(
        typeof choice === "string"
          ? JSON.stringify(choice)
          : `${JSON.stringify(choice.const)} — ${choice.title ?? choice.const}${choice.description ? `: ${choice.description}` : ""}`
      )
    }
  }
  return lines.flatMap((line) =>
    wrapLine(stripAnsi(line).replace(/\p{Cc}/gu, " "), Math.max(1, width - 2))
  )
}

export function QuestionOverlay({
  request,
  shortId,
  queued,
  width,
  maxRows,
  offset,
}: {
  request: RuntimeQuestionRequest
  shortId: string
  queued: number
  width: number
  maxRows: number
  offset: number
}) {
  const lines = questionLines(request, width)
  const capacity = Math.max(1, maxRows - 4)
  const start = Math.min(offset, Math.max(0, lines.length - capacity))
  const visible = lines.slice(start, start + capacity)
  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} width={width}>
      <Text bold color={COLOR.warn} wrap="truncate-end">
        {`QUESTION ${shortId} · ${queued} pending · ${stripAnsi(request.agentId)}`}
      </Text>
      <Text color={COLOR.accent} wrap="truncate-end">{`/respond ${shortId} <JSON object>`}</Text>
      <Text
        dimColor
        wrap="truncate-end"
      >{`/skip ${shortId} declines · /dismiss ${shortId} cancels`}</Text>
      {visible.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: immutable text rows are identified by their absolute form offset.
        <Text key={`${start + index}-${line}`} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Text
        dimColor
        wrap="truncate-end"
      >{`↑↓ / pgup pgdn form · ${start + 1}–${start + visible.length}/${lines.length} · ordinary text queues`}</Text>
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
  // A turn that never finished reads the same whether it was still running when
  // it was snapshotted or recovered from the journal after a restart: it was
  // stopped, and it is neither a success nor a failure.
  if (turn.interrupted || turn.phase !== "complete") {
    return { text: "interrupted", color: COLOR.warn }
  }
  if (turn.acceptance) {
    switch (turn.acceptance.status) {
      case "approved":
        return { text: `${STATUS.success.glyph} approved`, color: COLOR.ok }
      case "changes_required":
        return { text: `${GLYPH.warn} changes required`, color: COLOR.warn }
      case "failed":
        return { text: `${STATUS.failed.glyph} acceptance failed`, color: COLOR.error }
      case "cancelled":
        return { text: `${STATUS.cancelled.glyph} acceptance cancelled`, color: COLOR.warn }
    }
  }
  if (turn.cancelled) return { text: `${STATUS.cancelled.glyph} cancelled`, color: COLOR.warn }
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
  const start = listWindowStart(selected, turns.length, capacity)
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
