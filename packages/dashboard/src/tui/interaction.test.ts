import type { RuntimePermissionRequest, RuntimeQuestionRequest } from "@multiclawcli/core"
import { describe, expect, it } from "vitest"
import {
  boundsText,
  clean,
  commitField,
  describeImpact,
  focusField,
  formComplete,
  formContent,
  formFields,
  formValueText,
  initialForm,
  interactionRows,
  jumpCursor,
  jumpPick,
  moveCursor,
  movePick,
  permissionBarRows,
  permissionChoices,
  pickFor,
  questionBarRows,
  toggleBoolean,
  toggleChoice,
  waitingLine,
  withDraft,
} from "./interaction"

function permission(overrides: Partial<RuntimePermissionRequest> = {}): RuntimePermissionRequest {
  return {
    agentId: "backend",
    runId: "run-1",
    seq: 0,
    sessionId: "session-1",
    requestId: "request-1",
    toolCallId: "tool-1",
    title: "Bash: python3 - <<'EOF'",
    toolName: "Bash",
    input: { command: "python3 - <<'EOF'\nprint(1)\nEOF" },
    options: [
      { optionId: "a", name: "Yes", kind: "allow_once" },
      {
        optionId: "b",
        name: "Yes, and don't ask again for python3 - commands",
        kind: "allow_always",
      },
      { optionId: "c", name: "No", kind: "reject_once" },
    ],
    ...overrides,
  }
}

function question(schema: unknown, message = "Choose a database"): RuntimeQuestionRequest {
  return {
    agentId: "backend",
    runId: "run-1",
    seq: 0,
    sessionId: "session-1",
    requestId: "question-1",
    message,
    requestedSchema: schema as RuntimeQuestionRequest["requestedSchema"],
  }
}

const DATABASE = question({
  type: "object",
  required: ["database"],
  properties: {
    database: {
      type: "string",
      title: "Database",
      oneOf: [
        { const: "postgres", title: "Postgres", description: "Relational storage" },
        { const: "sqlite", title: "SQLite" },
      ],
    },
    notes: { type: "string", title: "Notes", minLength: 2, maxLength: 30 },
    features: {
      type: "array",
      title: "Features",
      items: { type: "string", enum: ["search", "cache"] },
    },
    count: { type: "integer", title: "Count", minimum: 1, maximum: 5 },
    dryRun: { type: "boolean", title: "Dry run" },
  },
})

describe("provider text", () => {
  it("collapses escapes and newlines so a row stays one row", () => {
    expect(clean("  a\n\tb   c  ")).toBe("a b c")
    expect(clean("\u001b[31mred\u001b[0m")).toBe("red")
  })
})

describe("permissionChoices", () => {
  it("numbers the offered options and keeps the provider's own wording", () => {
    const choices = permissionChoices(permission())
    expect(choices.map((choice) => choice.key)).toEqual(["1", "2", "3"])
    expect(choices[1].label).toBe("Yes, and don't ask again for python3 - commands")
  })

  it("marks only the options whose effect outlives the request", () => {
    const choices = permissionChoices(permission())
    expect(choices[0].note).toBeUndefined()
    expect(choices[1].note).toBe("this session")
    expect(choices[2].note).toBeUndefined()
  })

  it("falls back to the option kind when the provider sends no name", () => {
    const choices = permissionChoices(
      permission({ options: [{ optionId: "a", name: "  ", kind: "reject_always" }] })
    )
    expect(choices[0]).toEqual({
      key: "1",
      optionId: "a",
      label: "deny always",
      note: "this session",
    })
  })

  it("never advertises a key it cannot print", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      optionId: `o${index}`,
      name: `option ${index}`,
      kind: "allow_once" as const,
    }))
    expect(permissionChoices(permission({ options: many }))).toHaveLength(9)
  })
})

describe("describeImpact", () => {
  it("counts the lines behind the title's first line", () => {
    expect(describeImpact(permission(), 80)).toEqual(["3 lines"])
  })

  it("says nothing extra when the title already says everything", () => {
    expect(describeImpact(permission({ input: { command: "cargo check" } }), 80)).toEqual([])
  })

  it("describes an edit by how much it replaces", () => {
    const edit = permission({
      input: { path: "src/a.rs", old_string: "one\ntwo", new_string: "one\ntwo\nthree\nfour" },
    })
    expect(describeImpact(edit, 80)).toEqual(["replaces 2 lines with 4"])
  })

  it("describes a write by its size", () => {
    const write = permission({ input: { path: "src/a.rs", content: "one\ntwo" } })
    expect(describeImpact(write, 80)).toEqual(["writes 2 lines"])
  })

  it("stays silent rather than dumping the payload", () => {
    expect(describeImpact(permission({ input: undefined }), 80)).toEqual([])
    expect(describeImpact(permission({ input: "raw" }), 80)).toEqual([])
    expect(describeImpact(permission({ input: { path: "src/a.rs" } }), 80)).toEqual([])
    expect(describeImpact(permission({ input: { query: "x" } }), 80)).toEqual([])
  })
})

describe("permission selection", () => {
  it("starts with nothing selected, so enter alone cannot grant anything", () => {
    expect(moveCursor(undefined, 1, 3)).toBe(0)
    expect(moveCursor(undefined, -1, 3)).toBe(2)
  })

  it("wraps at both ends", () => {
    expect(moveCursor(0, -1, 3)).toBe(2)
    expect(moveCursor(2, 1, 3)).toBe(0)
    expect(moveCursor(0, 1, 3)).toBe(1)
  })

  it("has no cursor when there is nothing to choose", () => {
    expect(moveCursor(undefined, 1, 0)).toBeUndefined()
  })

  it("jumps only to a numbered row that exists", () => {
    expect(jumpCursor("1", 3)).toBe(0)
    expect(jumpCursor("3", 3)).toBe(2)
    expect(jumpCursor("4", 3)).toBeUndefined()
    expect(jumpCursor("0", 3)).toBeUndefined()
    expect(jumpCursor("x", 3)).toBeUndefined()
  })
})

describe("waitingLine", () => {
  it("is absent when nothing else is waiting", () => {
    expect(waitingLine([])).toBeUndefined()
  })

  it("names the requests behind the one on screen", () => {
    const rest = [
      permission({ agentId: "architect" }),
      permission({ agentId: "reviewer", toolName: "Edit" }),
    ]
    expect(waitingLine(rest)).toBe("also waiting · architect (Bash), reviewer (Edit)")
  })

  it("collapses past three into a count", () => {
    const rest = Array.from({ length: 5 }, (_, index) => permission({ agentId: `a${index}` }))
    expect(waitingLine(rest)).toContain("+2 more")
  })
})

describe("bar heights", () => {
  it("reserves header, title, impact, one row per option and the hint", () => {
    expect(permissionBarRows(permission(), 80)).toBe(1 + 1 + 1 + 3 + 1)
    expect(permissionBarRows(permission(), 80, [permission({ agentId: "x" })])).toBe(
      1 + 1 + 1 + 3 + 1 + 1
    )
  })

  it("reserves a row per field plus the detail and hint rows", () => {
    expect(questionBarRows(formFields(DATABASE))).toBe(2 + 5 + 1 + 1)
  })

  it("asks for nothing when nothing is pending", () => {
    expect(interactionRows([], 80)).toBe(0)
    expect(interactionRows([{ kind: "permission", request: permission() }], 80)).toBe(
      permissionBarRows(permission(), 80)
    )
  })
})

describe("formFields", () => {
  const fields = formFields(DATABASE)

  it("reads each field's kind from the schema", () => {
    expect(fields.map((field) => [field.key, field.kind])).toEqual([
      ["database", "choice"],
      ["notes", "text"],
      ["features", "multi"],
      ["count", "number"],
      ["dryRun", "boolean"],
    ])
  })

  it("carries required, titles, descriptions and bounds", () => {
    expect(fields[0].required).toBe(true)
    expect(fields[1].required).toBe(false)
    expect(fields[0].title).toBe("Database")
    expect(fields[0].choices[0]).toEqual({
      value: "postgres",
      title: "Postgres",
      description: "Relational storage",
    })
    expect(fields[1].bounds).toEqual({ minLength: 2, maxLength: 30 })
    expect(fields[3].bounds).toEqual({ min: 1, max: 5 })
  })

  it("falls back to the key when a field has no title", () => {
    const bare = formFields(question({ type: "object", properties: { note: { type: "string" } } }))
    expect(bare[0].title).toBe("note")
  })

  it("reads choices from an enum and from a titled anyOf", () => {
    const listed = formFields(
      question({
        type: "object",
        properties: {
          plain: { type: "string", enum: ["a", "b"] },
          titled: { type: "array", items: { anyOf: [{ const: "c", title: "C" }] } },
        },
      })
    )
    expect(listed[0].choices.map((choice) => choice.value)).toEqual(["a", "b"])
    expect(listed[1].kind).toBe("multi")
    expect(listed[1].choices[0]).toEqual({ value: "c", title: "C" })
  })
})

describe("boundsText", () => {
  const [database, notes, features, count, dryRun] = formFields(DATABASE)

  it("names the limit that actually applies to the field", () => {
    expect(boundsText(notes)).toBe("2–30 chars")
    expect(boundsText(features)).toBeUndefined()
    expect(boundsText(count)).toBe("1–5")
    expect(boundsText(dryRun)).toBeUndefined()
    // A picked value is still a string, so its length bounds still apply.
    expect(boundsText(database)).toBeUndefined()
  })

  it("reads one-sided limits", () => {
    const [open] = formFields(
      question({ type: "object", properties: { n: { type: "integer", minimum: 0 } } })
    )
    expect(boundsText(open)).toBe("min 0")
  })
})

describe("form state", () => {
  const fields = formFields(DATABASE)

  it("shows an unset field as empty and a boolean as unset", () => {
    const state = initialForm()
    expect(formValueText(fields[1], state)).toBe("")
    expect(formValueText(fields[4], state)).toBe("")
    expect(formValueText(fields[4], toggleBoolean(state, fields[4]))).toBe("yes")
    expect(
      formValueText(fields[4], toggleBoolean(toggleBoolean(state, fields[4]), fields[4]))
    ).toBe("no")
  })

  it("shows a picked choice by its title, not by the value it submits", () => {
    const state = commitField(fields, movePick(initialForm(), fields[0], 1))
    expect(state.values.database).toBe("sqlite")
    expect(formValueText(fields[0], state)).toBe("SQLite")
  })

  it("lists a multi field's picks by their titles", () => {
    const state = toggleChoice(initialForm(), fields[2])
    expect(formValueText(fields[2], state)).toBe("search")
    const both = toggleChoice(movePick(state, fields[2], 1), fields[2])
    expect(formValueText(fields[2], both)).toBe("search, cache")
    // The toggle follows the highlight, which the move left on `cache`.
    expect(formValueText(fields[2], toggleChoice(both, fields[2]))).toBe("search")
  })

  it("keeps a highlight per field", () => {
    const state = movePick(initialForm(), fields[0], 1)
    expect(pickFor(state, fields[0])).toBe(1)
    expect(jumpPick(state, fields[0], "1").picks).toEqual({ database: 0 })
    // A digit past the last choice is not a jump.
    expect(jumpPick(state, fields[0], "9")).toEqual(state)
  })

  it("lifts the prompt into the focused field and back out again", () => {
    const onNotes = focusField(fields, initialForm(), 1).state
    expect(withDraft(fields, onNotes, "hello").values.notes).toBe("hello")
    // A field that is picked rather than typed has no draft to take.
    const picked = withDraft(fields, movePick(initialForm(), fields[0], 1), "stray")
    expect(picked.values.database).toBeUndefined()
  })

  it("loads the next field's value when the focus moves", () => {
    const state = { ...initialForm(), values: { notes: "saved" } }
    const moved = focusField(fields, state, 1)
    expect(moved.state.field).toBe(1)
    expect(moved.draft).toBe("saved")
    // Out-of-range indices clamp rather than throwing.
    expect(focusField(fields, state, 99).state.field).toBe(fields.length - 1)
    expect(focusField([], state, 0).draft).toBe("")
  })

  it("commits the highlighted choice and nothing else", () => {
    const state = movePick(initialForm(), fields[0], 1)
    expect(commitField(fields, state).values.database).toBe("sqlite")
    expect(commitField(fields, state).values.notes).toBeUndefined()
  })
})

describe("form submission", () => {
  const fields = formFields(DATABASE)

  function filled() {
    let state = commitField(fields, movePick(initialForm(), fields[0], 1))
    state = { ...state, values: { ...state.values, notes: "hello" } }
    state = toggleChoice(state, fields[2])
    state = { ...state, values: { ...state.values, count: "3" } }
    return toggleBoolean(state, fields[4])
  }

  it("sends typed numbers as numbers and drops fields left empty", () => {
    expect(formContent(fields, filled())).toEqual({
      database: "sqlite",
      notes: "hello",
      features: ["search"],
      count: 3,
      dryRun: true,
    })
  })

  it("is not complete until every required field has a value", () => {
    expect(formComplete(fields, initialForm())).toBe(false)
    expect(formComplete(fields, filled())).toBe(true)
  })

  it("enforces the bounds the schema declared", () => {
    const tooShort = { ...filled(), values: { ...filled().values, notes: "x" } }
    expect(formComplete(fields, tooShort)).toBe(false)
    const tooBig = { ...filled(), values: { ...filled().values, count: "9" } }
    expect(formComplete(fields, tooBig)).toBe(false)
    const notANumber = { ...filled(), values: { ...filled().values, count: "abc" } }
    expect(formComplete(fields, notANumber)).toBe(false)
  })

  it("treats an optional field left empty as answered", () => {
    const required = formFields(
      question({ type: "object", required: ["name"], properties: { name: { type: "string" } } })
    )
    expect(formComplete(required, { ...initialForm(), values: { name: "ok" } })).toBe(true)
    expect(formComplete(required, initialForm())).toBe(false)
  })

  it("holds a multi field to its item limits", () => {
    const limited = formFields(
      question({
        type: "object",
        required: ["pick"],
        properties: {
          pick: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 2 },
        },
      })
    )
    const one = toggleChoice(initialForm(), limited[0])
    expect(formComplete(limited, one)).toBe(false)
    expect(formComplete(limited, toggleChoice(movePick(one, limited[0], 1), limited[0]))).toBe(true)
  })
})
