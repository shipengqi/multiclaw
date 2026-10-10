import { describe, expect, it } from "vitest"
import { circled, elapsedSince, formatDuration, padRight, truncate } from "./format"

describe("truncate", () => {
  it("leaves text that fits alone", () => {
    expect(truncate("abc", 5)).toBe("abc")
    expect(truncate("abcde", 5)).toBe("abcde")
  })

  it("replaces the last cell with an ellipsis", () => {
    expect(truncate("abcdef", 5)).toBe("abcd…")
  })

  it("collapses to nothing at zero width or below", () => {
    expect(truncate("abc", 0)).toBe("")
    expect(truncate("abc", -3)).toBe("")
  })
})

describe("formatDuration", () => {
  it("uses tenths of a second below a minute", () => {
    expect(formatDuration(0)).toBe("0.0s")
    expect(formatDuration(4200)).toBe("4.2s")
    expect(formatDuration(59_900)).toBe("59.9s")
  })

  it("switches to minutes with zero-padded seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 00s")
    expect(formatDuration(64_000)).toBe("1m 04s")
  })

  it("switches to hours with zero-padded minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m")
    expect(formatDuration(3_720_000)).toBe("1h 02m")
  })

  it("refuses to print a nonsense duration", () => {
    expect(formatDuration(-1)).toBe("—")
    expect(formatDuration(Number.NaN)).toBe("—")
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—")
  })
})

describe("circled", () => {
  it("maps stage numbers to markers", () => {
    expect(circled(1)).toBe("①")
    expect(circled(10)).toBe("⑩")
  })

  it("falls back past twenty stages", () => {
    expect(circled(21)).toBe("(21)")
  })
})

describe("padRight", () => {
  it("pads to the requested column", () => {
    expect(padRight("ab", 5)).toBe("ab   ")
  })

  it("never truncates", () => {
    expect(padRight("abcdef", 3)).toBe("abcdef")
  })
})

describe("elapsedSince", () => {
  it("measures forward", () => {
    expect(elapsedSince(1000, 3500)).toBe(2500)
  })

  it("never goes negative", () => {
    expect(elapsedSince(5000, 1000)).toBe(0)
  })

  it("has no answer without a start", () => {
    expect(elapsedSince(undefined, 1000)).toBeUndefined()
  })
})
