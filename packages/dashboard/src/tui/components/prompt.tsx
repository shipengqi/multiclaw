import { Box, Text } from "ink"
import type { PaletteRow } from "../commands"
import { displayWidth, padRight, truncate } from "../format"
import { COLOR, GLYPH } from "../theme"

/** What the prompt starts every input with, and what a wrapped row indents by. */
const MARKER = `${GLYPH.caret} `
/** Columns the marker occupies, so a wrapped row can leave exactly that gap. */
export const MARKER_WIDTH = displayWidth(MARKER)
const INDENT = " ".repeat(MARKER_WIDTH)

/**
 * How many rows a long input may occupy.
 *
 * The prompt grows with the text, and the body gives up a row for each one it
 * takes — so without a ceiling a pasted document would squeeze the stream out
 * of existence. Past this the prompt scrolls instead of growing.
 */
export const MAX_PROMPT_ROWS = 5

/** One row of the prompt, already broken to the width it will be drawn at. */
export interface PromptLine {
  text: string
  /**
   * Where the caret sits inside `text`, as an index into it, or `undefined`
   * when the caret is on another row.
   *
   * An index rather than a column because a wide character is one index and two
   * columns: splitting the row by column would cut a CJK character in half.
   */
  caret?: number
}

/**
 * Break the input into the rows it will actually be drawn on.
 *
 * Broken by *character*, not by word: a terminal input line has no words to
 * respect, and typing past the last column simply continues on the next row.
 * Word-wrapping here would move the text under the user's fingers — a space
 * typed at the end of a row would push a whole word down and take the caret
 * with it.
 *
 * Every character is kept, in order, across the rows: nothing is dropped at a
 * break, which is what lets the caret be tracked as an index into a row.
 */
export function promptLines(value: string, cursor: number, width: number): PromptLine[] {
  // Newlines are drawn as a single-cell glyph rather than a real line break:
  // the prompt is one input, and `\n` → glyph is 1:1, so `cursor` — which
  // indexes the original `value` — still points at the right cell in `shown`.
  //
  // That 1:1 property is a precondition the *caller* guarantees: `App.insert`
  // normalises every line ending to `\n`, so the `value` reaching here never
  // contains `\r`. Clearing `\r` below is defensive only — and it is
  // deliberately NOT 1:1 (it shortens `shown`), so if a `\r` ever did arrive,
  // `cursor` would no longer line up. The fix would be to stop one upstream,
  // not to paper over it here.
  const shown = value.replace(/\r/g, "").replace(/\n/g, GLYPH.newline)
  const limit = Math.max(1, width)
  const lines: PromptLine[] = [{ text: "" }]
  let col = 0
  let offset = 0

  const breakRow = () => {
    lines.push({ text: "" })
    col = 0
  }

  for (const char of shown) {
    const charWidth = displayWidth(char)
    // The character goes where the caret is, so it has to break first: a wide
    // character with one column left moves down rather than being cut in two,
    // and the caret has to follow it there.
    if (col > 0 && col + charWidth > limit) breakRow()
    const line = lines[lines.length - 1]
    if (offset === cursor) line.caret = line.text.length
    line.text += char
    col += charWidth
    offset += char.length
  }

  // A caret at the end sits one cell past the last character. When that cell is
  // past the last column it belongs to a fresh row — which is exactly where a
  // terminal puts it, and where the next keystroke will land.
  if (cursor >= offset) {
    if (col >= limit) breakRow()
    const line = lines[lines.length - 1]
    line.caret = line.text.length
  }
  return lines
}

/**
 * How many rows the prompt is asking for, capped at what it will actually draw.
 *
 * Exported because the layout has to know before Ink lays anything out: the
 * body is given whatever the chrome leaves, and an unbudgeted prompt row shows
 * up as a stream pane that silently loses its last line.
 */
export function promptRowCount(value: string, cursor: number, width: number): number {
  return Math.min(MAX_PROMPT_ROWS, promptLines(value, cursor, width).length)
}

/**
 * The prompt.
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
 *
 * The rows are broken here rather than by Ink. Ink would wrap the text happily,
 * but the caret is a *sibling* of the text, not part of it — so a wrapped line
 * left the caret stranded at the right end of the first row while the rest of
 * the text carried on underneath it. Breaking the line first puts the caret on
 * the row the text actually reached.
 */
export function Prompt({
  value,
  cursor,
  caretVisible,
  placeholder,
  width,
}: {
  value: string
  cursor: number
  caretVisible: boolean
  placeholder: string
  /** Columns the whole prompt line may occupy, marker included. */
  width: number
}) {
  const textWidth = Math.max(1, width - MARKER_WIDTH)
  const lines = promptLines(value, cursor, textWidth)
  // `ghost` stays keyed off the original value: an empty prompt is the one case
  // that shows the placeholder, and a value of "\n" is not empty.
  const ghost = value === ""
  // Truncated rather than wrapped: the placeholder is a hint, and a hint that
  // pushed the prompt to two rows would move everything under the user's eyes
  // the moment they started typing.
  const hint = truncate(placeholder, textWidth)

  // Scrolled so the caret stays in view. It sits at the bottom of the window
  // while typing, which is where the next character goes.
  const caretRow = Math.max(
    0,
    lines.findIndex((line) => line.caret !== undefined)
  )
  const start =
    lines.length <= MAX_PROMPT_ROWS
      ? 0
      : Math.max(0, Math.min(caretRow - (MAX_PROMPT_ROWS - 1), lines.length - MAX_PROMPT_ROWS))

  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.slice(start, start + MAX_PROMPT_ROWS).map((line, index) => {
        const caret = line.caret
        // Empty line → the ghost text supplies the cell; otherwise it is the
        // character under the caret. Falling back to a space keeps the cell at
        // the end of a typed line from vanishing when the blink is off.
        const rest = caret === undefined ? "" : line.text.slice(caret)
        const cell = [...(ghost ? hint : rest)][0] ?? " "
        const tail = ghost ? [...hint].slice(1).join("") : rest.slice(cell.length)

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a text row has no identity beyond its position — the whole prompt is rebuilt on every keystroke anyway
          <Box key={start + index} flexShrink={0}>
            {/* Only the first row of the input carries the marker; the rest
                indent by its width so the text stays in one column. A prompt
                scrolled past its start shows the indent alone rather than
                claiming a middle row is the beginning. */}
            <Text color={COLOR.accent}>{start + index === 0 ? MARKER : INDENT}</Text>
            {caret === undefined ? (
              <Text dimColor={ghost}>{line.text}</Text>
            ) : (
              <>
                <Text dimColor={ghost}>{line.text.slice(0, caret)}</Text>
                {/* A sibling rather than a nested <Text>: Ink merges styles
                    downward and cannot un-inherit them, so a nested caret would
                    stay dimmed with the ghost text and the block would wash
                    out. The caret also has to match its neighbours' brightness
                    when the blink is off — dim on ghost text, plain on typed
                    text — or that one cell flickers. */}
                <Text inverse={caretVisible} dimColor={!caretVisible && ghost}>
                  {cell}
                </Text>
                <Text dimColor={ghost}>{tail}</Text>
              </>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The palette, rendered directly above the prompt.
 *
 * Keeping it attached to the line being typed — rather than in a floating box —
 * means the filtered list and the query are always read together, which is how
 * fzf-style pickers work.
 *
 * It takes rows rather than commands so the command list and an argument
 * completer (see `argQuery`) draw through one path: both reduce to a key, a
 * label and a description, and the label already carries whatever prefix it
 * needs.
 */
export function CommandMenu({ rows, selected }: { rows: PaletteRow[]; selected: number }) {
  const labelWidth = Math.max(1, ...rows.map((row) => row.label.length))

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rows.map((row, index) => {
        const active = index === selected
        return (
          <Text
            key={row.key}
            color={active ? COLOR.accent : undefined}
            dimColor={!active}
            wrap="truncate-end"
          >
            {active ? GLYPH.caret : " "} {padRight(row.label, labelWidth)} {row.description}
          </Text>
        )
      })}
    </Box>
  )
}
