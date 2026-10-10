import { describe, expect, it } from "vitest"
import { ABORT_ERROR_NAME, abortError, isAbortError } from "./abort"

describe("abort helpers", () => {
  it("creates an error tagged as an abort", () => {
    const err = abortError()
    expect(err.name).toBe(ABORT_ERROR_NAME)
    expect(err.message).toBe("Operation aborted")
  })

  it("accepts a custom message", () => {
    expect(abortError("stopped").message).toBe("stopped")
  })

  it("recognises abort errors", () => {
    expect(isAbortError(abortError())).toBe(true)
    expect(isAbortError(new Error("ordinary"))).toBe(false)
    expect(isAbortError("not an error")).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
  })
})
