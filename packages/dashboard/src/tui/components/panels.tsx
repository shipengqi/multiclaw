import type { LeaderMessage } from "@multiclawcli/core"
import { Box, Text } from "ink"
import { formatCost, formatDuration, formatTokens, padRight, truncate } from "../format"
import { type AgentView, agentElapsed, progress, type TurnView, visibleLog } from "../state"
import { COLOR, GLYPH, STATUS } from "../theme"

/**
 * What the right-hand column of a roster row shows.
 *
 * Live clocks while an agent runs, the frozen duration once it stops — mixing
 * the two would make the column jitter as agents complete.
 */
function rightColumn(agent: AgentView, now: number): { text: string; color?: string } {
  if (agent.status === "retrying" && agent.retry) {
    return { text: `retry ${agent.retry.attempt}/${agent.retry.max}`, color: COLOR.warn }
  }
  const elapsed = agentElapsed(agent, now)
  if (elapsed !== undefined) return { text: formatDuration(elapsed) }
  if (agent.status === "skipped") return { text: "skipped" }
  return { text: "—" }
}

function TeamRow({
  agent,
  focused,
  now,
  spinner,
}: {
  agent: AgentView
  focused: boolean
  now: number
  spinner: string
}) {
  const style = STATUS[agent.status]
  const glyph = agent.status === "running" ? spinner : style.glyph
  const right = rightColumn(agent, now)
  return (
    <Box justifyContent="space-between">
      <Box flexShrink={1}>
        {/* One Text, so the row truncates from the tail: the name is what has to
            survive a narrow panel, and the per-turn title is what gives way
            first. A separate middle box would fight the row's `space-between`
            and stop the clock on the right from staying right-aligned. */}
        <Text
          color={focused ? COLOR.accent : style.color}
          dimColor={!focused && style.dim}
          bold={focused}
          wrap="truncate-end"
        >
          {focused ? `${GLYPH.caret} ` : "  "}
          {glyph} {agent.icon ? `${agent.icon} ` : ""}
          {agent.name}
          {/* The per-turn title, when the leader's plan has assigned one. No
              orphan separator when it is absent. */}
          {agent.taskTitle ? <Text dimColor> {agent.taskTitle}</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={right.color} dimColor={right.color === undefined}>
          {right.text}
        </Text>
      </Box>
    </Box>
  )
}

/** The roster: one row per agent, with the focused one called out by a caret. */
export function TeamPanel({
  turn,
  width,
  now,
  spinner,
}: {
  turn: TurnView
  width: number
  now: number
  spinner: string
}) {
  const ids = Object.keys(turn.agents)
  const { done, total } = progress(turn)

  return (
    <Box flexDirection="column" width={width} flexShrink={0} paddingRight={1}>
      <Box justifyContent="space-between">
        <Text dimColor>TEAM</Text>
        <Text dimColor>
          {done}/{total}
        </Text>
      </Box>
      {ids.length === 0 ? (
        <Text dimColor>no agents configured</Text>
      ) : (
        ids.map((id) => (
          <TeamRow
            key={id}
            agent={turn.agents[id]}
            focused={turn.focusId === id}
            now={now}
            spinner={spinner}
          />
        ))
      )}
    </Box>
  )
}

/**
 * A one-column vertical rule between the two panes.
 *
 * Drawn as a left border rather than a column of `│` characters: the border is
 * laid out by Yoga and always matches the row's height, whereas a hand-counted
 * column of glyphs overflows into the footer the moment the two disagree.
 */
export function Divider() {
  return (
    <Box
      flexShrink={0}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderLeft
      borderColor={COLOR.muted}
    />
  )
}

/**
 * The focused agent's output.
 *
 * The header carries the three things a reader needs before the text: whose
 * output this is, what it is running on, and whether the pane is still tailing
 * or parked. Output itself is rendered at normal brightness — the chrome is what
 * should recede, not the agent's work.
 */
export function StreamPanel({
  turn,
  height,
  width,
  now,
  spinner,
}: {
  turn: TurnView
  height: number
  width: number
  now: number
  spinner: string
}) {
  const agent = turn.focusId ? turn.agents[turn.focusId] : undefined
  const viewport = Math.max(1, height - 1)
  const window = visibleLog(turn, viewport, width)
  const style = agent ? STATUS[agent.status] : undefined
  const elapsed = agent ? agentElapsed(agent, now) : undefined

  return (
    <Box flexDirection="column" flexGrow={1} height={height} paddingLeft={1}>
      <Box justifyContent="space-between">
        <Box flexShrink={1}>
          {/* One Text so the header truncates as a unit: a long task title
              shaves the header instead of wrapping onto a second row, which
              would push the log viewport past its height budget. The right-hand
              group keeps `flexShrink={0}`, so the elapsed time and the live
              marker are never the thing that gets cut. */}
          <Text wrap="truncate-end">
            <Text bold>{agent?.name ?? "—"}</Text>
            {agent?.model ? <Text dimColor> · {agent.model}</Text> : null}
            {agent && style ? (
              <>
                <Text dimColor> · </Text>
                <Text color={style.color} dimColor={style.dim}>
                  {agent.status === "running" ? `${spinner} ${style.label}` : style.label}
                </Text>
              </>
            ) : null}
            {/* The per-turn title, when the leader's plan has assigned one. No
                orphan separator when it is absent. */}
            {agent?.taskTitle ? <Text dimColor> · {agent.taskTitle}</Text> : null}
            {/* Context usage, only when the runtime reported both halves — a
                lone numerator would read as a broken fraction. */}
            {agent?.usage?.contextTokens !== undefined && agent.usage.contextSize !== undefined ? (
              <Text dimColor>
                {" "}
                · ctx {formatTokens(agent.usage.contextTokens)}/
                {formatTokens(agent.usage.contextSize)}
              </Text>
            ) : null}
            {/* Cost, only when the provider priced itself. */}
            {agent?.costUsd !== undefined ? (
              <Text dimColor> · {formatCost(agent.costUsd)}</Text>
            ) : null}
          </Text>
        </Box>
        <Box flexShrink={0}>
          {/* The trailing space lives here, not on the follow marker, so an
              agent with no elapsed time does not get a stray leading gap. */}
          {elapsed === undefined ? null : <Text dimColor>{formatDuration(elapsed)} </Text>}
          <Text color={window.following ? COLOR.accent : COLOR.warn}>
            {window.following ? GLYPH.live : `${GLYPH.paused} ${window.scrolledBack}↑`}
          </Text>
        </Box>
      </Box>

      {window.rows.length === 0 ? (
        <Text dimColor>{turn.phase === "running" ? "waiting for output…" : "no output yet"}</Text>
      ) : (
        // The tail, already wrapped to `width` by `visibleLog` — the pane draws
        // rows, and one log line is several of them. `visibleLog` also picks
        // which rows, so the content here is exactly the pane's height and the
        // oldest rows are the ones already gone: nothing is left to clip, which
        // is why this box is not bottom-pinned. Pinning it would only leave a
        // gap under the header whenever an agent has not said much yet.
        //
        // Rows are rendered with `truncate-end` rather than letting Ink wrap
        // them again: they are supposed to fit, and if `width` was ever
        // optimistic the failure should be a shaved row, not a re-wrap that
        // overflows the pane and pushes the newest output out of sight.
        //
        // `flexShrink={0}` stops Yoga compressing the rows into each other,
        // and `overflow="hidden"` is the backstop if any of the above is ever
        // wrong.
        <Box flexDirection="column" flexShrink={0} height={viewport} overflow="hidden">
          {window.rows.map((row, index) => (
            // Rows are an append-only tail; position is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional log tail
            <Box key={index} flexShrink={0}>
              <Text wrap="truncate-end">{row}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

/**
 * A turn the leader answered instead of planning.
 *
 * It takes the body for the same reason the welcome screen does: there is no
 * pipeline to watch, and the words are the entire result. Splitting the space
 * with two panes that have nothing to say would only shrink the one thing worth
 * reading. The rail above still names the leader, so the source is not lost.
 */
export function ReplyPanel({ reply, width }: { reply: LeaderMessage; width: number }) {
  const asking = reply.mode === "ask"
  return (
    // `flexShrink={0}`: the body must clip this, not compress it. A shrunken
    // column box folds its own text rows into each other before the body ever
    // gets a chance to hide the overflow.
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} paddingTop={1} width={width}>
      <Text color={asking ? COLOR.warn : COLOR.accent} bold>
        {asking ? GLYPH.ask : GLYPH.leader} {asking ? "the team needs a decision" : "answered"}
      </Text>
      {/* One Text, so Ink wraps it to the pane — a long answer stays readable
          instead of being truncated at the first newline. */}
      <Box marginTop={1}>
        <Text>{reply.message}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {asking ? "Answer below and press enter." : "Type a requirement and press enter."}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * A turn that stopped with an error, shown in full.
 *
 * The status line has one row and truncates, which is the wrong shape for the
 * errors that matter here: a jiti load failure or an ACP protocol error is
 * several lines, and squeezing it to one leaves the user nothing to act on. So
 * the error takes the body, the same way a reply does, and lets Ink wrap it.
 */
export function ErrorPanel({ message, width }: { message: string; width: number }) {
  return (
    // `flexShrink={0}` — see ReplyPanel. A compressed column box folds its own
    // text rows into each other before the body gets a chance to clip them.
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} paddingTop={1} width={width}>
      <Text color={COLOR.error} bold>
        {GLYPH.warn} the run stopped
      </Text>
      {/* One Text, so Ink wraps the whole message: multi-line errors keep their
          own line breaks instead of being flattened onto one row. */}
      <Box marginTop={1}>
        <Text color={COLOR.error}>{message}</Text>
      </Box>
    </Box>
  )
}

/**
 * The first screen.
 *
 * A console that opens to a blank pane wastes the one moment where the user has
 * nothing else to read. The roster is already in the config — including the
 * `description` of what each agent is for — so the welcome screen can say who is
 * on the team and what each of them does.
 *
 * It marks the focused agent with the same `›` caret the team panel uses. Without
 * it, `tab` looked broken here: the hint bar advertised `tab switch` while the
 * one roster on screen ignored the focus entirely.
 */
export function WelcomePanel({ turn, width }: { turn: TurnView; width: number }) {
  const agents = Object.values(turn.agents)
  const leaderId = turn.leaderIds[0]
  const nameWidth = Math.min(24, Math.max(8, ...agents.map((a) => a.name.length)) + 2)

  return (
    // `flexShrink={0}` — see ReplyPanel. Compressing the roster folds one agent's
    // description onto the next row's, which reads as a corrupted screen.
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} paddingTop={1} width={width}>
      <Text color={COLOR.accent} bold>
        {GLYPH.brand} multiclaw
      </Text>
      <Box marginTop={1}>
        <Text dimColor>A team of agents, one prompt away.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {agents.map((agent) => {
          const focused = turn.focusId === agent.id
          const leader = agent.id === leaderId
          return (
            <Box key={agent.id}>
              <Box flexShrink={0}>
                <Text color={focused ? COLOR.accent : undefined}>
                  {focused ? `${GLYPH.caret} ` : "  "}
                </Text>
                <Text color={leader ? COLOR.accent : COLOR.muted}>
                  {leader ? GLYPH.leader : GLYPH.agent}
                </Text>
                <Text bold={focused} color={focused ? COLOR.accent : undefined}>
                  {" "}
                  {padRight(truncate(agent.name, nameWidth - 2), nameWidth - 1)}
                </Text>
              </Box>
              <Box flexShrink={1}>
                <Text dimColor wrap="truncate-end">
                  {agent.taskTitle ?? agent.description ?? ""}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Type a requirement and press enter.</Text>
      </Box>
    </Box>
  )
}
