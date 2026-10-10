import { Box, Text } from "ink"
import type { CommandSpec } from "../commands"
import { padRight } from "../format"
import { COLOR, GLYPH } from "../theme"

/**
 * The prompt line.
 *
 * The terminal's own cursor is hidden while the console owns the screen, so the
 * caret has to be drawn. It sits *between* the text before and after it rather
 * than always at the end — that is what makes arrow-key editing legible.
 *
 * The caret cell is always exactly one column wide, in both blink phases. That
 * matters on an empty line: the ghost text starts where the caret is, so a
 * caret that *added* a cell while visible would shove the placeholder one
 * column sideways twice a second. Instead the caret is painted *onto* the ghost
 * text's first character, which is what a real block cursor does.
 */
export function Prompt({
  value,
  cursor,
  caretVisible,
  placeholder,
}: {
  value: string
  cursor: number
  caretVisible: boolean
  placeholder: string
}) {
  const ghost = value === ""
  const before = value.slice(0, cursor)
  // Empty line → the ghost text supplies the cell; otherwise it is the
  // character under the cursor. Falling back to a space keeps the cell at the
  // end of a typed line from vanishing when the blink is off.
  const cell = ghost ? placeholder.slice(0, 1) : value.slice(cursor, cursor + 1)
  const tail = ghost ? placeholder.slice(1) : value.slice(cursor + 1)

  return (
    <Box flexShrink={0}>
      <Text color={COLOR.accent}>{GLYPH.caret} </Text>
      <Text dimColor={ghost}>{before}</Text>
      {/* A sibling rather than a nested <Text>: Ink merges styles downward and
          cannot un-inherit them, so a nested caret would stay dimmed with the
          ghost text and the block would wash out. The caret also has to match
          its neighbours' brightness when the blink is off — dim on ghost text,
          plain on typed text — or that one cell flickers. */}
      <Text inverse={caretVisible} dimColor={!caretVisible && ghost}>
        {cell || " "}
      </Text>
      <Text dimColor={ghost}>{tail}</Text>
    </Box>
  )
}

/**
 * The `/` palette, rendered directly above the prompt.
 *
 * Keeping it attached to the line being typed — rather than in a floating box —
 * means the filtered list and the query are always read together, which is how
 * fzf-style pickers work.
 */
export function CommandMenu({ commands, selected }: { commands: CommandSpec[]; selected: number }) {
  const nameWidth = Math.max(
    1,
    ...commands.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0))
  )

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {commands.map((command, index) => {
        const active = index === selected
        const label = command.args ? `${command.name} ${command.args}` : command.name
        return (
          <Text
            key={command.name}
            color={active ? COLOR.accent : undefined}
            dimColor={!active}
            wrap="truncate-end"
          >
            {active ? GLYPH.caret : " "} /{padRight(label, nameWidth)} {command.description}
          </Text>
        )
      })}
    </Box>
  )
}
