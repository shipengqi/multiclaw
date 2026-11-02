import type { RuntimePermissionRequest, RuntimeQuestionRequest } from "@multiclawcli/core"
import { Box, Text } from "ink"
import { truncate } from "../format"
import {
  boundsText,
  clean,
  describeImpact,
  type FormField,
  type FormState,
  formValueText,
  MAX_FORM_FIELDS,
  permissionChoices,
  pickFor,
  waitingLine,
} from "../interaction"
import { COLOR, GLYPH } from "../theme"
import { listWindowStart } from "./overlays"

/**
 * The bar the console docks above the prompt when an agent is blocked on the
 * user.
 *
 * It is *docked* rather than a body overlay on purpose. The old screens replaced
 * the stream with the question, which took away the one thing needed to answer
 * it — what the agent had been doing up to the point it asked. Approval is a
 * decision made *about* the stream, so it belongs next to it, not instead of it.
 *
 * Everything here is one row per fact and clipped by the caller, which is why
 * the row count in `interaction.ts` only has to be an upper bound.
 */
export function PermissionBar({
  request,
  others,
  cursor,
  released,
  width,
  maxRows = Number.POSITIVE_INFINITY,
}: {
  request: RuntimePermissionRequest
  /** Requests behind this one, shown so "2 waiting" is not a bare number. */
  others: readonly RuntimePermissionRequest[]
  /** Highlighted option, or `undefined` when nothing has been picked yet. */
  cursor: number | undefined
  /** The user asked for the keyboard back; escape returns to its options. */
  released: boolean
  width: number
  maxRows?: number
}) {
  const choices = permissionChoices(request)
  const capacity = Math.max(1, Math.min(choices.length, maxRows - 3))
  const start = listWindowStart(cursor ?? 0, choices.length, capacity)
  const extra = Math.max(0, maxRows - 3 - capacity)
  const impact = describeImpact(request, Math.max(8, width - 6)).slice(0, extra)
  const also = extra > impact.length ? waitingLine(others) : undefined
  const tool = clean(request.toolName ?? request.kind ?? "tool")

  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} width={width}>
      <Text bold color={COLOR.warn} wrap="truncate-end">
        {`permission · ${clean(request.agentId)} · ${tool}${others.length > 0 ? ` · ${others.length + 1} waiting` : ""}`}
      </Text>
      <Text wrap="truncate-end">{`  ${truncate(clean(request.title), Math.max(8, width - 4))}`}</Text>
      {impact.map((line) => (
        <Text key={line} dimColor wrap="truncate-end">
          {`  ${line}`}
        </Text>
      ))}
      {choices.slice(start, start + capacity).map((choice, index) => {
        const active = start + index === cursor
        return (
          <Text
            key={choice.optionId}
            color={active ? COLOR.accent : undefined}
            dimColor={!active}
            wrap="truncate-end"
          >
            {`${active ? GLYPH.caret : " "} ${choice.key}  ${choice.label}${choice.note ? `  · ${choice.note}` : ""}`}
          </Text>
        )
      })}
      {also === undefined ? null : (
        <Text dimColor wrap="truncate-end">
          {`  ${also}`}
        </Text>
      )}
      {maxRows < 4 ? null : (
        <Text dimColor wrap="truncate-end">
          {released
            ? "  typing · esc to return to permission options"
            : "  ↑↓ or 1-9 choose · enter confirm · esc to type instead"}
        </Text>
      )}
    </Box>
  )
}

/**
 * The question, as a form.
 *
 * Fields are edited in the prompt, while choice fields use the arrow keys.
 * Submit, skip and cancel are explicit actions after the last field.
 */
export function QuestionForm({
  request,
  others,
  fields,
  form,
  draft,
  width,
  maxRows = Number.POSITIVE_INFINITY,
}: {
  request: RuntimeQuestionRequest
  others: readonly RuntimeQuestionRequest[]
  fields: FormField[]
  form: FormState
  /** Text in the prompt, which is the focused text field's editor. */
  draft: string
  width: number
  maxRows?: number
}) {
  const focused = fields[form.field]
  const titleWidth = Math.min(
    24,
    Math.max(4, ...fields.map((field) => field.title.length + (field.required ? 2 : 0)))
  )
  const actions = ["Submit answers", "Skip question", "Cancel request"]
  const actionIndex = form.field - fields.length
  const compact = maxRows < 7
  const capacity = compact
    ? focused
      ? 1
      : 0
    : Math.min(fields.length, MAX_FORM_FIELDS, maxRows - 5)
  const start = listWindowStart(
    Math.min(form.field, fields.length - 1),
    fields.length,
    Math.max(1, capacity)
  )
  const visible = fields.slice(start, start + capacity)
  const range =
    fields.length > capacity && focused ? ` · field ${form.field + 1}/${fields.length}` : ""
  const detail =
    focused && (!compact || maxRows >= 5) ? detailLines(focused, width).slice(0, 1) : []

  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={2} width={width}>
      <Text bold color={COLOR.warn} wrap="truncate-end">
        {`question · ${clean(request.agentId)}${others.length > 0 ? ` · ${others.length + 1} waiting` : ""}`}
      </Text>
      <Text wrap="truncate-end">{clean(request.message)}</Text>
      {visible.map((field, offset) => {
        const index = start + offset
        const active = index === form.field
        const marker = field.required ? " *" : ""
        const value = fieldValue(field, form, draft, index === form.field)
        return (
          <Text
            key={field.key}
            color={active ? COLOR.accent : undefined}
            dimColor={!active}
            wrap="truncate-end"
          >
            {`${active ? GLYPH.caret : " "} ${`${field.title}${marker}`.padEnd(titleWidth)}  ${value}`}
          </Text>
        )
      })}
      {detail.map((line) => (
        <Text key={line} dimColor wrap="truncate-end">
          {`  ${line}`}
        </Text>
      ))}
      {compact && focused ? null : (
        <Text color={actionIndex >= 0 ? COLOR.accent : undefined} wrap="truncate-end">
          {compact || width < 72
            ? actionIndex >= 0
              ? `› ${actions[actionIndex]}`
              : "tab to submit / skip / cancel"
            : actions
                .map((label, index) => (actionIndex === index ? "› " : "  ") + label)
                .join(" · ")}
        </Text>
      )}
      {maxRows < 4 ? null : (
        <Text dimColor wrap="truncate-end">
          {`  tab next · ↑↓ pick · space toggle · enter next${range} · esc clear`}
        </Text>
      )}
    </Box>
  )
}

/**
 * The field's value as its row draws it.
 *
 * The focused text field reads the prompt instead of the committed value,
 * because that is where its characters actually are until the focus moves.
 */
function fieldValue(field: FormField, form: FormState, draft: string, focused: boolean): string {
  // A focused choice shows what is highlighted, so the row and the list below it
  // agree before anything is committed.
  if (focused && field.kind === "choice" && field.choices.length > 0) {
    return field.choices[pickFor(form, field)].title
  }
  const editing = focused && (field.kind === "text" || field.kind === "number")
  const text = editing ? draft : formValueText(field, form)
  if (text !== "") return text
  if (field.kind === "boolean") return "(unset)"
  return "(empty)"
}

/** One row under the field list: what the focused field offers, or what it means. */
function detailLines(field: FormField, width: number): string[] {
  const room = Math.max(8, width - 6)
  const limits = boundsText(field)
  const suffix = limits === undefined ? "" : ` · ${limits}`

  if (field.choices.length > 0) {
    // No marker on the picked one: the field row above already names it, and a
    // second mark would compete with the caret that means "this is the field".
    const listed = field.choices
      .map(
        (choice, index) =>
          `${index + 1} ${choice.title}${choice.description ? ` — ${choice.description}` : ""}`
      )
      .join("  ")
    return [truncate(`${listed}${suffix}`, room)]
  }

  const editing = field.kind === "text" || field.kind === "number"
  const hint = field.description ?? (editing ? "type below, enter to continue" : "")
  if (hint === "") return limits === undefined ? [] : [`${limits}`]
  return [truncate(`${hint}${suffix}`, room)]
}
