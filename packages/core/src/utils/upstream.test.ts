import { describe, expect, it } from "vitest"
import {
  MAX_UPSTREAM_CHARS,
  MAX_UPSTREAM_ENTRY_CHARS,
  renderUpstreamOutputs,
  type UpstreamOutput,
} from "./upstream"

/** The block's own framing, stripped to isolate the entry. */
const HEADER = "\n## What upstream produced\n\n"

/**
 * The body of the single entry in a block, with the bullet's own label and the
 * 2-space indent stripped.
 *
 * Lets a test measure the compacted text against the per-entry ceiling without
 * re-deriving the label's width.
 */
function bodyOf(block: string): string {
  const prefixEnd = block.indexOf(":\n  ") + ":\n  ".length
  return block.slice(prefixEnd, -1)
}

/** The whole rendered bullet — attribution line, indent and body. */
function entryOf(block: string): string {
  return block.slice(HEADER.length, -1)
}

function output(id: string, text: string): UpstreamOutput {
  return { agentId: id, name: id, output: text }
}

describe("renderUpstreamOutputs", () => {
  it("renders nothing when there is no upstream", () => {
    // Every built-in task template carries the placeholder, so an unresolved
    // one would reach the model as literal `{{upstreamOutputs}}`.
    expect(renderUpstreamOutputs([])).toBe("")
  })

  it("renders one output under the producer that wrote it", () => {
    const block = renderUpstreamOutputs([
      { agentId: "architect", name: "Architect", output: "Use Postgres for storage." },
    ])

    expect(block.startsWith("\n## What upstream produced\n\n")).toBe(true)
    expect(block).toContain("- Architect (architect):")
    expect(block).toContain("Use Postgres for storage.")
  })

  it("compacts an oversized output by keeping its head and its tail", () => {
    const head = "HEAD".repeat(60)
    const middle = "M".repeat(1200)
    const tail = "TAIL".repeat(60)

    const block = renderUpstreamOutputs([output("a", head + middle + tail)])
    const body = bodyOf(block)

    expect(body.length).toBeLessThanOrEqual(MAX_UPSTREAM_ENTRY_CHARS)
    // The ceiling covers the whole rendered bullet, not just the body.
    expect(entryOf(block).length).toBeLessThanOrEqual(MAX_UPSTREAM_ENTRY_CHARS)
    // Both ends survive — a hard cut would have dropped one of them.
    expect(body).toContain("HEAD")
    expect(body).toContain("TAIL")

    // The marker names the real number of characters that were elided, so the
    // reader can tell how much is missing rather than trusting the cut.
    const match = body.match(/… \((\d+) characters elided\) …/)
    expect(match).not.toBeNull()
    const marker = (match as RegExpMatchArray)[0]
    const elided = Number((match as RegExpMatchArray)[1])
    const markerStart = body.indexOf(marker)
    const keptHead = body.slice(0, markerStart)
    const keptTail = body.slice(markerStart + marker.length)

    expect(elided).toBe((head + middle + tail).length - (keptHead.length + keptTail.length))
    // And the surviving halves really are the original's two ends.
    expect((head + middle + tail).startsWith(keptHead)).toBe(true)
    expect((head + middle + tail).endsWith(keptTail)).toBe(true)
  })

  it("drops the oldest outputs to stay under the block budget", () => {
    const outputs = Array.from({ length: 10 }, (_, i) =>
      output(`agent-${i}`, `ENTRY-${i} ${"x".repeat(700)}`)
    )

    const block = renderUpstreamOutputs(outputs)

    // The budget covers the whole rendered block, heading included.
    expect(block.length).toBeLessThanOrEqual(MAX_UPSTREAM_CHARS)
    // The newest output is the most relevant, so it is the last to be dropped.
    expect(block).toContain("ENTRY-9")
    expect(block).not.toContain("ENTRY-0")
  })

  // The budget is the size of what is actually injected, so the heading and the
  // trailing newline count against it. This input's entries alone fit the budget
  // — a budget that ignored its own framing would keep all eight and return a
  // block that is 28 characters over the constant.
  it("keeps the whole rendered block within the budget", () => {
    const outputs = Array.from({ length: 8 }, (_, i) => output(`agent-${i}`, "x".repeat(476)))

    // 8 × (23-char label + 476) + 7 separators = 3999, under the budget — but
    // the full block, with its 29-character framing, is 4028.
    expect(renderUpstreamOutputs(outputs).length).toBeLessThanOrEqual(MAX_UPSTREAM_CHARS)
  })

  it("indents the continuation lines of a multi-line output", () => {
    const block = renderUpstreamOutputs([
      output("tester", "FAIL: two tests\n  at foo.test.ts:12\n  at bar.test.ts:4"),
    ])

    // One bullet's body, not three bullets that were never produced.
    expect(block).toContain("  FAIL: two tests\n    at foo.test.ts:12\n    at bar.test.ts:4")
  })

  // The per-entry ceiling covers the rendered bullet, so the 2-space indent on
  // every continuation line counts against it. This body fits on its own, but
  // its 141 newlines become 282 extra characters once indented.
  it("keeps a multi-line entry within the ceiling after its indent is added", () => {
    const manyLines = Array.from({ length: 142 }, (_, i) => `l${i % 10}`).join("\n")
    const block = renderUpstreamOutputs([output("a", manyLines)])

    // The body alone passes; only the rendered entry is at risk.
    expect(manyLines.length).toBeLessThanOrEqual(MAX_UPSTREAM_ENTRY_CHARS)
    expect(entryOf(block).length).toBeLessThanOrEqual(MAX_UPSTREAM_ENTRY_CHARS)
  })

  // Dense newlines drive the recompute's `budget - 2N` negative, where `compact`
  // floors its keep at zero and returns only the marker. It must not throw, and
  // the rendered entry must still fit.
  it("stays within the ceiling when the indent cost exceeds the budget", () => {
    const dense = `a${"\n".repeat(289)}a${"\n".repeat(289)}a${"\n".repeat(289)}a`
    const entry = entryOf(renderUpstreamOutputs([output("a", dense)]))

    expect(entry.length).toBeLessThanOrEqual(MAX_UPSTREAM_ENTRY_CHARS)
    // The degenerate path really was taken: only the elision marker survives.
    expect(entry).toContain("characters elided")
  })
})
