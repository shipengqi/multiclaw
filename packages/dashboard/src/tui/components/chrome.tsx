import type { AgentStatus } from "@multiclawcli/core"
import { Box, Text } from "ink"
import type { ReactNode } from "react"
import { circled } from "../format"
import { MAX_QUEUE_ROWS } from "../layout"
import type { AgentView, TurnView } from "../state"
import { COLOR, GLYPH, STATUS } from "../theme"

/**
 * Identity on the left, live context on the right — the same split htop uses.
 *
 * Chrome never shrinks. When the column overflows, Yoga squeezes whichever child
 * it can, and a header that silently disappears is worse than a clipped log.
 */
export function Header({ name, right }: { name: string; right: string }) {
  return (
    <Box justifyContent="space-between" flexShrink={0}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={COLOR.accent} bold>
            {GLYPH.brand} multiclaw
          </Text>
          {name ? <Text dimColor> · {name}</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{right}</Text>
      </Box>
    </Box>
  )
}

/** A horizontal rule. Cheap separation without spending two rows on a box border. */
export function Rule({ width }: { width: number }) {
  return (
    <Box flexShrink={0}>
      <Text color={COLOR.muted} dimColor>
        {"─".repeat(Math.max(0, width))}
      </Text>
    </Box>
  )
}

interface ChipProps {
  agent?: AgentView
  fallbackName: string
  spinner: string
}

function Chip({ agent, fallbackName, spinner }: ChipProps) {
  const status: AgentStatus = agent?.status ?? "pending"
  const style = STATUS[status]
  const glyph = status === "running" ? spinner : style.glyph
  return (
    <Box marginRight={1}>
      <Text color={style.color} dimColor={style.dim}>
        {glyph} {agent?.icon ? `${agent.icon} ` : ""}
        {agent?.name ?? fallbackName}
      </Text>
    </Box>
  )
}

/**
 * The team's shape at a glance: who runs before the pipeline, then each stage in
 * order.
 *
 * The `──▸` connector and the ①②③ markers are borrowed from build tools and CI
 * UIs, where "this happens, then that" is already read as a left-to-right flow.
 */
export function PipelineRail({ turn, spinner }: { turn: TurnView; spinner: string }) {
  if (turn.leaderIds.length === 0 && turn.stages.length === 0) return null

  const items: ReactNode[] = []

  for (const id of turn.leaderIds) {
    items.push(
      <Chip key={`leader-${id}`} agent={turn.agents[id]} fallbackName={id} spinner={spinner} />
    )
  }

  turn.stages.forEach((stage, index) => {
    items.push(
      <Text key={`flow-${stage.stageIndex}`} dimColor>
        {` ${GLYPH.connector} `}
      </Text>,
      <Text key={`stage-${stage.stageIndex}`} dimColor>
        {circled(index + 1)}{" "}
      </Text>
    )
    for (const agent of stage.agents) {
      items.push(
        <Chip
          key={agent.id}
          agent={turn.agents[agent.id]}
          fallbackName={agent.name}
          spinner={spinner}
        />
      )
    }
  })

  return <Box flexWrap="wrap">{items}</Box>
}

/**
 * The footer.
 *
 * The right side lists only the keys that do something *right now*, which is how
 * a console teaches its own keymap without printing a manual.
 */
export function HintBar({ status, keys }: { status: ReactNode; keys: string }) {
  return (
    <Box justifyContent="space-between" flexShrink={0}>
      <Box flexShrink={1}>{status}</Box>
      <Box flexShrink={0}>
        <Text dimColor>{keys}</Text>
      </Box>
    </Box>
  )
}

/**
 * Follow-ups typed while the team was still working.
 *
 * It sits directly above the prompt because that is where the text was typed, and
 * the rows are in run order — the first one is what happens next. The overflow
 * count is spelled out rather than implied, since the whole point of the strip is
 * that nothing the user typed gets silently dropped.
 */
export function QueueStrip({ items, max = MAX_QUEUE_ROWS }: { items: string[]; max?: number }) {
  if (items.length === 0 || max <= 0) return null

  const shown = items.slice(0, max)
  const hidden = items.length - shown.length

  return (
    <Box flexDirection="column" flexShrink={0}>
      {shown.map((text, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a queue may hold the same sentence twice, so position is what tells the rows apart
        <Text key={`${index}-${text}`} wrap="truncate-end">
          <Text color={COLOR.warn}>{index === 0 ? `${GLYPH.queued} ` : "  "}</Text>
          <Text dimColor={index > 0}>{text}</Text>
          {hidden > 0 && index === shown.length - 1 ? (
            <Text dimColor>{` (+${hidden} more)`}</Text>
          ) : null}
        </Text>
      ))}
    </Box>
  )
}
