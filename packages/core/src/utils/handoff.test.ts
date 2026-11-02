import { describe, expect, it } from "vitest"
import { parseHandoff } from "./handoff"

describe("terminal handoff protocol", () => {
  const valid = '<multiclaw-handoff>{"reason":" other role "}</multiclaw-handoff>'
  it("accepts one terminal control line after narration", () => {
    expect(parseHandoff("Investigated scope.\n" + valid)).toEqual({ reason: "other role" })
  })
  it("accepts a multiline terminal JSON object", () => {
    expect(
      parseHandoff('<multiclaw-handoff>\n{"reason":"another role"}\n</multiclaw-handoff>')
    ).toEqual({ reason: "another role" })
  })
  it.each([
    '<multiclaw-handoff>{"reason":""}</multiclaw-handoff>',
    "<multiclaw-handoff>{oops}</multiclaw-handoff>",
    "<multiclaw-handoff>",
    valid + "\n" + valid,
  ])("rejects malformed or competing terminal controls", (text) => {
    expect(parseHandoff(text)).toHaveProperty("error")
  })
  it.each([
    "I might hand this back later.",
    "Example: " + valid,
    valid + "\nThat was an example.",
    String.fromCharCode(96).repeat(3) + "\n" + valid + "\n" + String.fromCharCode(96).repeat(3),
    "> " + valid,
    valid +
      "\n" +
      String.fromCharCode(96).repeat(3) +
      "\nquoted\n" +
      String.fromCharCode(96).repeat(3),
  ])("does not interpret prose or examples as control", (text) => {
    expect(parseHandoff(text)).toBeUndefined()
  })
})
