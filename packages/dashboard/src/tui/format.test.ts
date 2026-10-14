import { describe, expect, it } from "vitest"
import {
  circled,
  displayWidth,
  elapsedSince,
  formatCost,
  formatDuration,
  formatTokens,
  padRight,
  truncate,
  wrapLine,
} from "./format"

/** Chinese closing punctuation, which may not begin a row (避头尾). */
const CLOSERS_START = /^[。，、；：？！）］｝」』】》〉”’…—·]/

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

describe("formatTokens", () => {
  it("keeps small counts exact", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(950)).toBe("950")
  })

  it("abbreviates thousands and millions with one decimal", () => {
    expect(formatTokens(45_200)).toBe("45.2k")
    expect(formatTokens(200_000)).toBe("200k")
    expect(formatTokens(1_200_000)).toBe("1.2M")
  })

  it("refuses to print a nonsense count", () => {
    expect(formatTokens(-1)).toBe("—")
    expect(formatTokens(Number.NaN)).toBe("—")
  })
})

describe("formatCost", () => {
  it("prints a normal cost to the cent", () => {
    expect(formatCost(0.42)).toBe("$0.42")
    expect(formatCost(1.23)).toBe("$1.23")
  })

  it("prints zero as zero", () => {
    expect(formatCost(0)).toBe("$0.00")
  })

  it("flags a sub-cent cost rather than rounding it away to nothing", () => {
    expect(formatCost(0.004)).toBe("<$0.01")
  })

  it("refuses to print a nonsense cost", () => {
    expect(formatCost(-1)).toBe("—")
    expect(formatCost(Number.NaN)).toBe("—")
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

describe("displayWidth", () => {
  // The whole reason `wrapLine` cannot use `text.length`: a CJK character is one
  // code unit and two columns, so a Chinese line sized by length would be handed
  // to Ink twice as wide as the pane.
  it("counts a CJK character as two columns", () => {
    expect(displayWidth("中")).toBe(2)
    expect(displayWidth("中文")).toBe(4)
    expect(displayWidth("中a")).toBe(3)
  })

  it("counts an ASCII string as its length", () => {
    expect(displayWidth("abc")).toBe(3)
    expect(displayWidth("")).toBe(0)
  })
})

describe("wrapLine", () => {
  it("leaves a line that fits as a single row", () => {
    expect(wrapLine("hello world", 20)).toEqual(["hello world"])
  })

  it("keeps an empty line as one empty row", () => {
    expect(wrapLine("", 10)).toEqual([""])
  })

  it("breaks at spaces rather than mid-word", () => {
    expect(wrapLine("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"])
  })

  // A path, a hash or a minified JSON blob has no space to break at, so the only
  // option left is to split it by width.
  it("splits a word with no break opportunity", () => {
    expect(wrapLine("abcdefgh", 3)).toEqual(["abc", "def", "gh"])
  })

  it("never returns a row wider than the limit", () => {
    const text = "the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnop"
    for (const width of [1, 5, 12, 40]) {
      for (const row of wrapLine(text, width)) {
        expect(displayWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })

  // Wrapping is a layout operation, not an editing one: dropping or duplicating
  // a character would corrupt the agent's output in a way nobody would notice.
  it("keeps every non-space character, in order", () => {
    const text = "the quick brown fox jumps over the lazy dog"
    const joined = wrapLine(text, 7).join(" ")
    expect(joined.replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "))
  })

  it("preserves indentation and runs of spaces", () => {
    expect(wrapLine("    indented", 20)).toEqual(["    indented"])
    expect(wrapLine("a  b", 20)).toEqual(["a  b"])
  })

  it("sizes rows by display width, so CJK wraps on columns not code units", () => {
    // Six characters, twelve columns: only three fit in a six-column row.
    expect(wrapLine("中中中中中中", 6)).toEqual(["中中中", "中中中"])
  })

  // A Chinese sentence has no spaces in it, so it arrives as one "word". Pushing
  // that word whole onto the next row left most of the row before it empty —
  // which, with English and Chinese mixed as they usually are, meant a ragged
  // gap on every line that happened to end with a long Chinese run.
  it("breaks a wide-character run to fill the row instead of leaving a gap", () => {
    const line = "And a CJK line: 这是一段中文说明文字用来验证按显示宽度折行是否正确。"
    const rows = wrapLine(line, 60)
    expect(rows[0].startsWith("And a CJK line: 这是一")).toBe(true)
    expect(displayWidth(rows[0])).toBe(60)
    // Filling the row is still not allowed to lose anything.
    expect(rows.join("").replace(/ /g, "")).toBe(line.replace(/ /g, ""))
  })

  // The other half of that rule: a wide-character script may be broken anywhere,
  // but an English word, an identifier or a number may not. They keep moving
  // whole, even when splitting them would have filled the row.
  it("does not break a narrow word just to fill the row", () => {
    expect(wrapLine("aaa bbbbbbbbbbbb", 10)).toEqual(["aaa", "bbbbbbbbbb", "bb"])
  })

  it("keeps a narrow run inside a mixed word whole", () => {
    // The break lands between the CJK characters, not inside the identifier.
    expect(wrapLine("中文abcdefghij中文", 10)).toEqual(["中文", "abcdefghij", "中文"])
  })

  // 避头尾: a break in front of a Chinese comma would start the next row with
  // punctuation, which reads as a broken sentence. The row is given up short
  // rather than stranding it.
  it("never starts a row with closing punctuation", () => {
    const line =
      "The leader said: 请把 `streamWidth` 加到 `computeLayout` 里，然后让 `visibleLog` 切片。"
    for (const row of wrapLine(line, 60)) {
      expect(CLOSERS_START.test(row)).toBe(false)
    }
  })

  it("treats a zero or negative width as one column", () => {
    expect(wrapLine("ab", 0)).toEqual(["a", "b"])
    expect(wrapLine("ab", -5)).toEqual(["a", "b"])
  })
})
