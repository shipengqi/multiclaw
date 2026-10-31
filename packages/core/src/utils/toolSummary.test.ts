import { describe, expect, it } from "vitest"
import { hasToolArgs, summarizeToolInput, summarizeToolOutput } from "./toolSummary"

describe("summarizeToolInput", () => {
  it("renders an object as one JSON line", () => {
    expect(summarizeToolInput({ command: "pnpm test" })).toBe('{"command":"pnpm test"}')
  })

  it("keeps only the first line of a multi-line string", () => {
    expect(summarizeToolInput("first\nsecond\nthird")).toBe("first")
  })

  it("truncates a very long summary to about one line's worth", () => {
    const summary = summarizeToolInput({ path: "x".repeat(500) })
    expect(summary.length).toBeLessThanOrEqual(120)
    expect(summary.endsWith("…")).toBe(true)
  })

  it("never throws on a circular structure", () => {
    const circular: Record<string, unknown> = { name: "loop" }
    circular.self = circular
    // `JSON.stringify` throws here; the summary must still be a usable string
    // rather than taking the run down.
    expect(() => summarizeToolInput(circular)).not.toThrow()
    expect(typeof summarizeToolInput(circular)).toBe("string")
  })

  it("treats absent input as an empty summary", () => {
    expect(summarizeToolInput(undefined)).toBe("")
    expect(summarizeToolInput(null)).toBe("")
  })

  it("treats an empty object as no arguments rather than the literal {}", () => {
    // ACP announces a tool call before its input has streamed, so `{}` is what
    // "not yet" looks like. Rendering it as `› Read {}` reads as a bug.
    expect(summarizeToolInput({})).toBe("")
  })
})

describe("hasToolArgs", () => {
  it("is false for a missing or empty argument list", () => {
    expect(hasToolArgs(undefined)).toBe(false)
    expect(hasToolArgs(null)).toBe(false)
    expect(hasToolArgs({})).toBe(false)
  })

  it("is true once any argument has arrived", () => {
    expect(hasToolArgs({ file_path: "src/App.tsx" })).toBe(true)
    // A non-object input is an argument in its own right, not an absence.
    expect(hasToolArgs("pnpm test")).toBe(true)
    expect(hasToolArgs([])).toBe(true)
  })
})

describe("summarizeToolOutput", () => {
  it("returns a plain string's first line unchanged", () => {
    expect(summarizeToolOutput("all green")).toBe("all green")
    expect(summarizeToolOutput("line one\nline two")).toBe("line one")
  })

  it("stringifies a non-string output", () => {
    expect(summarizeToolOutput({ message: "boom" })).toBe('{"message":"boom"}')
  })

  it("never throws on a circular structure", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => summarizeToolOutput(circular)).not.toThrow()
  })
})
