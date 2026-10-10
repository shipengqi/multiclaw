import { describe, expect, it } from "vitest"
import { extractJsonObjects } from "./json"

describe("extractJsonObjects", () => {
  it("returns an empty array when there is no JSON", () => {
    expect(extractJsonObjects("no json here")).toEqual([])
  })

  it("parses a bare object", () => {
    expect(extractJsonObjects('{"run":["a"]}')).toEqual([{ run: ["a"] }])
  })

  it("parses an object embedded in prose", () => {
    expect(extractJsonObjects('Sure! {"run": ["a","b"]} done')).toEqual([{ run: ["a", "b"] }])
  })

  it("handles nested braces", () => {
    expect(extractJsonObjects('{"a":{"b":{"c":1}}}')).toEqual([{ a: { b: { c: 1 } } }])
  })

  it("ignores braces and escapes inside strings", () => {
    expect(extractJsonObjects('{"note":"a } brace \\" and {","run":[]}')).toEqual([
      { note: 'a } brace " and {', run: [] },
    ])
  })

  it("skips invalid candidates and finds a later valid object", () => {
    expect(extractJsonObjects('{ not json } then {"run":["x"]}')).toEqual([{ run: ["x"] }])
  })

  it("finds multiple top-level objects", () => {
    expect(extractJsonObjects('{"a":1} and {"b":2}')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it("ignores an unterminated object", () => {
    expect(extractJsonObjects('{"run": ["a"')).toEqual([])
  })

  it("does not return nested objects separately", () => {
    expect(extractJsonObjects('{"outer":{"inner":1},"tail":2}')).toEqual([
      { outer: { inner: 1 }, tail: 2 },
    ])
  })
})
