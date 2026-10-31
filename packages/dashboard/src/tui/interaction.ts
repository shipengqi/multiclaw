/**
 * The two things an agent can stop and ask for, modelled as something the user
 * can *point at* instead of something they have to spell out.
 *
 * Both used to be answered by command — `/approve p4 1`, `/respond q1
 * {"database":"postgres"}` — which put three transformations between reading a
 * question and answering it: remember an internal alias, map a number back onto
 * a list rendered somewhere else, and hand-write JSON that happens to match a
 * schema. None of those are the decision. So the rendered question becomes the
 * thing that is operated on: the option you are looking at is the option you
 * commit, and the field you are editing is the field that receives the
 * keystroke.
 *
 * Pure on purpose. The keyboard rules are the part of this easiest to get
 * subtly wrong — a bare key that both selects and types, a required field that
 * silently submits empty — so they live here, where they can be tested without
 * rendering a terminal.
 */

import type { RuntimePermissionRequest, RuntimeQuestionRequest } from "@multiclawcli/core"
import { truncate } from "./format"
import { stripAnsi } from "./state"

export type PermissionOptionKind = RuntimePermissionRequest["options"][number]["kind"]

/** One offered permission option, with the number the bar advertises for it. */
export interface PermissionChoice {
  /** The key that selects this row, as printed: "1"…"9". */
  key: string
  optionId: string
  label: string
  /** A lasting consequence the label alone does not spell out. */
  note?: string
}

/**
 * Provider text, made safe to draw.
 *
 * Titles and tool inputs arrive from another process and can carry newlines,
 * escapes and ANSI. Collapsing whitespace is not cosmetic here: every row of
 * the bar is one row, so an embedded newline would either be drawn literally or
 * silently shift every row below it.
 */
export function clean(value: string): string {
  // Colours go first: replacing the ESC alone would leave `[31m` sitting in the
  // row as if it were text the provider had written.
  return stripAnsi(value)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const KIND_LABEL: Record<PermissionOptionKind, string> = {
  allow_once: "allow once",
  allow_always: "always",
  reject_once: "deny",
  reject_always: "deny always",
}

/**
 * The offered options, numbered in the order they were offered.
 *
 * Capped at nine because the key is a single digit and a tenth option would
 * advertise a key that does not exist. The provider's own wording is kept: it
 * is what carries the scope ("…and don't ask again for python3 - commands"),
 * and rewriting it would be guessing at a meaning it already states.
 */
export function permissionChoices(request: RuntimePermissionRequest): PermissionChoice[] {
  return request.options.slice(0, 9).map((option, index) => ({
    key: String(index + 1),
    optionId: option.optionId,
    label: clean(option.name) || KIND_LABEL[option.kind],
    // The one option with an effect that outlives this request.
    ...(option.kind === "allow_always" || option.kind === "reject_always"
      ? { note: "this session" }
      : {}),
  }))
}

/** How many impact rows the bar will draw, so the layout can reserve them. */
export const MAX_IMPACT_ROWS = 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function lineCount(text: string): number {
  return text.split("\n").length
}

/**
 * What the tool is about to do that its own one-line title does not say.
 *
 * The bar draws `request.title` first: it is the provider's own summary of the
 * call, and for a shell tool it *is* the command. What it cannot say is how much
 * is behind that first line — the old overlay dumped `input` as JSON and clipped
 * it after three rows, which always landed inside the escape sequences, so the
 * one readable thing was the one thing that had already been said. The facts
 * here are what is genuinely additional: the size of the script, the size of the
 * edit.
 */
export function describeImpact(request: RuntimePermissionRequest, width: number): string[] {
  const input = request.input
  if (!isRecord(input)) return []
  const room = Math.max(8, width)

  const command = typeof input.command === "string" ? input.command : undefined
  if (command !== undefined) {
    const total = lineCount(command)
    return total > 1 ? [truncate(`${total} lines`, room)] : []
  }

  const file = ["path", "file_path", "file", "filename"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string")
  if (file === undefined) return []

  const before = typeof input.old_string === "string" ? lineCount(input.old_string) : undefined
  const after = typeof input.new_string === "string" ? lineCount(input.new_string) : undefined
  if (before !== undefined && after !== undefined) {
    return [truncate(`replaces ${before} line${before === 1 ? "" : "s"} with ${after}`, room)]
  }
  if (typeof input.content === "string") {
    const written = lineCount(input.content)
    return [truncate(`writes ${written} line${written === 1 ? "" : "s"}`, room)]
  }
  return []
}

/**
 * Move the highlighted row, wrapping at both ends.
 *
 * `undefined` means nothing is highlighted yet, and that is deliberate: an
 * `enter` on a bar that already points at something would be a one-keystroke
 * grant for a request the user never read. Starting with no selection makes
 * `enter` alone inert, so committing always takes an explicit move first.
 */
export function moveCursor(
  cursor: number | undefined,
  delta: number,
  total: number
): number | undefined {
  if (total <= 0) return undefined
  if (cursor === undefined) return delta > 0 ? 0 : total - 1
  return (cursor + delta + total) % total
}

/** Jump to a numbered row, or `undefined` when the digit names nothing. */
export function jumpCursor(digit: string, total: number): number | undefined {
  if (!/^[1-9]$/.test(digit)) return undefined
  const index = Number(digit) - 1
  return index < total ? index : undefined
}

/**
 * The requests queued behind the one on screen, named.
 *
 * "2 pending" alone was the old bar's whole account of the others, which told
 * the user that something else was waiting without telling them what — so the
 * count could not be acted on until the front one was decided. Three is the
 * most that stays readable on one row; the rest collapse into a count.
 */
export function waitingLine(rest: readonly RuntimePermissionRequest[]): string | undefined {
  if (rest.length === 0) return undefined
  const named = rest
    .slice(0, 3)
    .map(
      (request) =>
        `${clean(request.agentId)} (${clean(request.toolName ?? request.kind ?? "tool")})`
    )
  const more = rest.length - named.length
  return `also waiting · ${named.join(", ")}${more > 0 ? ` · +${more} more` : ""}`
}

/** Rows the permission bar occupies: header, title, impact, options, hint. */
export function permissionBarRows(
  request: RuntimePermissionRequest,
  width: number,
  rest: readonly RuntimePermissionRequest[] = []
): number {
  const impact = Math.min(MAX_IMPACT_ROWS, describeImpact(request, width).length)
  return 1 + 1 + impact + permissionChoices(request).length + (rest.length > 0 ? 1 : 0) + 1
}

export type FormKind = "choice" | "multi" | "boolean" | "number" | "text"

export interface FormChoice {
  value: string
  title: string
  description?: string
}

export interface FormBounds {
  min?: number
  max?: number
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
}

export interface FormField {
  key: string
  title: string
  description?: string
  required: boolean
  kind: FormKind
  choices: FormChoice[]
  bounds: FormBounds
}

/** A committed field value. Numbers are held as the text typed, converted on submit. */
export type FormValue = string | boolean | string[]

export interface FormState {
  /** Index of the focused field. */
  field: number
  /** Highlighted choice per field, so moving between fields remembers it. */
  picks: Record<string, number>
  values: Record<string, FormValue>
}

function choiceFrom(value: unknown): FormChoice | undefined {
  if (typeof value === "string") return { value, title: value }
  if (!isRecord(value) || typeof value.const !== "string") return undefined
  const title =
    typeof value.title === "string" && value.title !== "" ? clean(value.title) : value.const
  const description = typeof value.description === "string" ? clean(value.description) : undefined
  return { value: value.const, title, ...(description ? { description } : {}) }
}

function fieldChoices(field: Record<string, unknown>): FormChoice[] {
  const items = isRecord(field.items) ? field.items : undefined
  const raw = field.oneOf ?? field.enum ?? items?.anyOf ?? items?.enum
  if (!Array.isArray(raw)) return []
  return raw.map(choiceFrom).filter((choice): choice is FormChoice => choice !== undefined)
}

function bound(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function fieldBounds(field: Record<string, unknown>): FormBounds {
  return {
    min: bound(field.minimum),
    max: bound(field.maximum),
    minItems: bound(field.minItems),
    maxItems: bound(field.maxItems),
    minLength: bound(field.minLength),
    maxLength: bound(field.maxLength),
  }
}

/**
 * The question's schema as a list of fields to edit.
 *
 * Order is the schema's own: a form that reorders its questions is asking them
 * in a different order than the agent wrote them, and the agent wrote them in
 * the order the answer makes sense in.
 */
export function formFields(request: RuntimeQuestionRequest): FormField[] {
  const schema = request.requestedSchema as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  const required = schema.required ?? []
  return Object.entries(schema.properties ?? {}).map(([key, raw]) => {
    const field = isRecord(raw) ? raw : {}
    const choices = fieldChoices(field)
    const type = field.type
    const kind: FormKind =
      type === "boolean"
        ? "boolean"
        : type === "number" || type === "integer"
          ? "number"
          : type === "array"
            ? "multi"
            : choices.length > 0
              ? "choice"
              : "text"
    const title = typeof field.title === "string" && field.title !== "" ? clean(field.title) : key
    const description = typeof field.description === "string" ? clean(field.description) : undefined
    return {
      key,
      title,
      required: required.includes(key),
      kind,
      choices,
      bounds: fieldBounds(field),
      ...(description === undefined ? {} : { description }),
    }
  })
}

/** The human form of a field's limits, or `undefined` when it has none. */
export function boundsText(field: FormField): string | undefined {
  const span = (
    low: number | undefined,
    high: number | undefined,
    unit = ""
  ): string | undefined => {
    if (low !== undefined && high !== undefined) return `${low}–${high}${unit}`
    if (low !== undefined) return `min ${low}${unit}`
    if (high !== undefined) return `max ${high}${unit}`
    return undefined
  }
  const { min, max, minItems, maxItems, minLength, maxLength } = field.bounds
  if (field.kind === "multi") return span(minItems, maxItems)
  if (field.kind === "number") return span(min, max)
  // A picked value is still a string, so its length bounds still apply.
  if (field.kind === "text" || field.kind === "choice") return span(minLength, maxLength, " chars")
  return undefined
}

export function initialForm(): FormState {
  return { field: 0, picks: {}, values: {} }
}

/** The field's value as the row draws it. */
export function formValueText(field: FormField, state: FormState): string {
  const value = state.values[field.key]
  if (value === undefined) return ""
  if (field.kind === "boolean") return value === true ? "yes" : "no"
  const title = (entry: string): string =>
    field.choices.find((choice) => choice.value === entry)?.title ?? entry
  if (field.kind === "multi") {
    const picked = Array.isArray(value) ? value : []
    return picked.map(title).join(", ")
  }
  // A picked value is stored as the schema's `const`, but the row shows the
  // title the provider gave it — the same words as the list under the field.
  const text = typeof value === "string" ? value : ""
  return field.kind === "choice" ? title(text) : text
}

/** The highlighted choice index, clamped to the options that exist. */
export function pickFor(state: FormState, field: FormField): number {
  const pick = state.picks[field.key] ?? 0
  return Math.min(Math.max(0, pick), Math.max(0, field.choices.length - 1))
}

export function movePick(state: FormState, field: FormField, delta: number): FormState {
  const total = field.choices.length
  if (total === 0) return state
  const next = (pickFor(state, field) + delta + total) % total
  return { ...state, picks: { ...state.picks, [field.key]: next } }
}

export function jumpPick(state: FormState, field: FormField, digit: string): FormState {
  if (!/^[1-9]$/.test(digit)) return state
  const index = Number(digit) - 1
  if (index >= field.choices.length) return state
  return { ...state, picks: { ...state.picks, [field.key]: index } }
}

export function toggleChoice(state: FormState, field: FormField): FormState {
  if (field.kind !== "multi" || field.choices.length === 0) return state
  const value = field.choices[pickFor(state, field)].value
  const current = Array.isArray(state.values[field.key])
    ? (state.values[field.key] as string[])
    : []
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value]
  return { ...state, values: { ...state.values, [field.key]: next } }
}

export function toggleBoolean(state: FormState, field: FormField): FormState {
  if (field.kind !== "boolean") return state
  // Unset → yes → no → yes: the first toggle commits an answer, and never
  // commits "no" for someone who only meant to look.
  return {
    ...state,
    values: { ...state.values, [field.key]: state.values[field.key] !== true },
  }
}

/**
 * Take the text in the prompt as the focused field's value.
 *
 * The prompt *is* the editor for a text field — it already owns the caret, the
 * wrapping and the paste handling — so there is no second buffer to keep in
 * sync. The only cost is that the value has to be lifted out of the prompt
 * before the focus moves away, which is what this does.
 */
export function withDraft(fields: FormField[], state: FormState, draft: string): FormState {
  const field = fields[state.field]
  if (!field || (field.kind !== "text" && field.kind !== "number")) return state
  return { ...state, values: { ...state.values, [field.key]: draft } }
}

/**
 * Move the focus, handing back the text the new field should show.
 *
 * Both halves happen together because they are one operation: a caller that
 * saved the draft but forgot to load the next field's value would silently
 * empty a field the user had already answered.
 */
export function focusField(
  fields: FormField[],
  state: FormState,
  index: number
): { state: FormState; draft: string } {
  if (fields.length === 0) return { state, draft: "" }
  const next = Math.min(Math.max(0, index), fields.length - 1)
  const field = fields[next]
  const value = state.values[field.key]
  return {
    state: { ...state, field: next },
    draft: typeof value === "string" ? value : "",
  }
}

/** Commit a highlighted choice into the value, for fields picked rather than typed. */
export function commitField(fields: FormField[], state: FormState): FormState {
  const field = fields[state.field]
  if (field?.kind !== "choice" || field.choices.length === 0) return state
  const value = field.choices[pickFor(state, field)].value
  return { ...state, values: { ...state.values, [field.key]: value } }
}

/** The answer to send, with numbers parsed out of the text they were typed as. */
export function formContent(
  fields: FormField[],
  state: FormState
): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {}
  for (const field of fields) {
    const value = state.values[field.key]
    if (value === undefined) continue
    if (field.kind === "boolean") {
      content[field.key] = value === true
      continue
    }
    if (field.kind === "multi") {
      content[field.key] = Array.isArray(value) ? value : []
      continue
    }
    const text = typeof value === "string" ? value : ""
    if (text.trim() === "") continue
    if (field.kind === "number") {
      const parsed = Number(text.trim())
      if (Number.isFinite(parsed)) content[field.key] = parsed
      continue
    }
    content[field.key] = text
  }
  return content
}

/**
 * Whether the form may be submitted.
 *
 * Checked here rather than left to the core validator so the bar can say *which*
 * field is not ready. The core check still runs on submit — it is the contract
 * with the runtime, and this one is only the part the user is shown.
 */
function fieldComplete(field: FormField, state: FormState): boolean {
  const value = state.values[field.key]
  if (field.kind === "boolean") return typeof value === "boolean"
  if (field.kind === "multi") {
    const picked = Array.isArray(value) ? value : []
    if (value === undefined) return !field.required
    if (field.required && picked.length === 0) return false
    const { minItems, maxItems } = field.bounds
    if (minItems !== undefined && picked.length < minItems) return false
    if (maxItems !== undefined && picked.length > maxItems) return false
    return true
  }
  if (field.kind === "number") {
    const text = typeof value === "string" ? value.trim() : ""
    if (text === "") return !field.required
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return false
    const { min, max } = field.bounds
    if (min !== undefined && parsed < min) return false
    if (max !== undefined && parsed > max) return false
    return true
  }
  // Text and choice are both a string the user supplied, so they share the
  // empty-and-bounded check — a picked value is still subject to its length.
  const text = typeof value === "string" ? value : ""
  if (text.trim() === "") return !field.required
  const { minLength, maxLength } = field.bounds
  if (minLength !== undefined && text.length < minLength) return false
  if (maxLength !== undefined && text.length > maxLength) return false
  return true
}

export function formComplete(fields: FormField[], state: FormState): boolean {
  return fields.every((field) => fieldComplete(field, state))
}

/** Rows a field list may occupy before it scrolls. */
export const MAX_FORM_FIELDS = 6

/** Rows the question form occupies: header, message, fields, detail, hint. */
export function questionBarRows(fields: FormField[]): number {
  return 2 + Math.min(fields.length, MAX_FORM_FIELDS) + 1 + 1
}

/** The one interaction on screen, whichever kind it is. */
export type InteractionLike =
  | { kind: "permission"; request: RuntimePermissionRequest }
  | { kind: "question"; request: RuntimeQuestionRequest }

/** Rows the docked bar asks the layout for, whichever request is in front. */
export function interactionRows(interactions: readonly InteractionLike[], width: number): number {
  const front = interactions[0]
  if (!front) return 0
  if (front.kind === "permission") {
    const rest = interactions
      .slice(1)
      .map((entry) => entry.request)
      .filter((request): request is RuntimePermissionRequest => "options" in request)
    return permissionBarRows(front.request, width, rest)
  }
  return questionBarRows(formFields(front.request))
}
