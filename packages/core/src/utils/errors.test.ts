import { describe, expect, it } from "vitest"
import { isPermanent, PermanentError } from "./errors"

describe("PermanentError", () => {
  it("is classified as permanent", () => {
    expect(isPermanent(new PermanentError("nope"))).toBe(true)
  })

  it("keeps the message it was given", () => {
    // `AgentResult.error` is `(err as Error).message`, so the message is part of
    // the result contract and must survive the classification untouched.
    expect(new PermanentError("Failed to start opencode: ENOENT").message).toBe(
      "Failed to start opencode: ENOENT"
    )
  })

  it("carries a distinguishing name", () => {
    expect(new PermanentError("x").name).toBe("PermanentError")
  })

  it("is an Error, so existing `err.message` handling still works", () => {
    expect(new PermanentError("x")).toBeInstanceOf(Error)
  })

  it("does not classify a plain Error as permanent", () => {
    expect(isPermanent(new Error("transient"))).toBe(false)
  })

  it("does not classify a non-error as permanent", () => {
    expect(isPermanent("boom")).toBe(false)
    expect(isPermanent(undefined)).toBe(false)
    expect(isPermanent(null)).toBe(false)
  })
})
