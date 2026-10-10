import { describe, expect, it } from "vitest"
import { parseLeaderDecision } from "./leaderDecision"

describe("parseLeaderDecision", () => {
  it("reads a run plan", () => {
    expect(parseLeaderDecision('{"mode":"run","run":["a","b"]}')).toEqual({
      mode: "run",
      run: ["a", "b"],
    })
  })

  // The mode field arrived after the shape did, so an older leader — or a model
  // that simply forgets — still gets its plan honoured.
  it("treats a bare run plan as a run", () => {
    expect(parseLeaderDecision('{"run":["a"]}')).toEqual({ mode: "run", run: ["a"] })
  })

  it("reads a reply and an ask", () => {
    expect(parseLeaderDecision('{"mode":"reply","message":"hello"}')).toEqual({
      mode: "reply",
      message: "hello",
    })
    expect(parseLeaderDecision('{"mode":"ask","message":"which db?"}')).toEqual({
      mode: "ask",
      message: "which db?",
    })
  })

  it("trims the message", () => {
    expect(parseLeaderDecision('{"mode":"reply","message":"  hi  "}')).toEqual({
      mode: "reply",
      message: "hi",
    })
  })

  it("finds the object inside prose or fences", () => {
    const text = 'Sure!\n```json\n{"mode":"reply","message":"hi"}\n```\nDone.'
    expect(parseLeaderDecision(text)).toEqual({ mode: "reply", message: "hi" })
  })

  it("skips earlier objects that are not decisions", () => {
    const text = '{"meta":{"note":"}"},"ok":true}\nand then {"mode":"run","run":["b"]}'
    expect(parseLeaderDecision(text)).toEqual({ mode: "run", run: ["b"] })
  })

  it("returns undefined when there is nothing to parse", () => {
    expect(parseLeaderDecision("I could not decide.")).toBeUndefined()
    expect(parseLeaderDecision("")).toBeUndefined()
  })

  it("rejects malformed plans rather than half-reading them", () => {
    expect(parseLeaderDecision('{"mode":"run","run":"a"}')).toBeUndefined()
    expect(parseLeaderDecision('{"mode":"run","run":[1,2]}')).toBeUndefined()
    expect(parseLeaderDecision('{"mode":"run"}')).toBeUndefined()
    expect(parseLeaderDecision('{"mode":"reply"}')).toBeUndefined()
    expect(parseLeaderDecision('{"mode":"reply","message":"   "}')).toBeUndefined()
    expect(parseLeaderDecision('{"mode":"dance","run":["a"]}')).toBeUndefined()
  })

  it("keeps looking past an empty message for a later decision", () => {
    const text = '{"mode":"reply","message":""}\n{"mode":"run","run":["a"]}'
    expect(parseLeaderDecision(text)).toEqual({ mode: "run", run: ["a"] })
  })

  it("accepts an empty run list — the caller decides that it means nothing to do", () => {
    expect(parseLeaderDecision('{"mode":"run","run":[]}')).toEqual({ mode: "run", run: [] })
  })
})
