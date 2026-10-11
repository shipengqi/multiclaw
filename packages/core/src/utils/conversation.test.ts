import { describe, expect, it } from "vitest"
import type { TurnRecord } from "../types/config"
import { MAX_CONVERSATION_CHARS, MAX_CONVERSATION_TURNS, renderConversation } from "./conversation"

/** The block's heading, which is charged on top of the character budget. */
const HEADING = 80

function turn(requirement: string, reply?: TurnRecord["reply"]): TurnRecord {
  return reply ? { requirement, reply } : { requirement }
}

const asked: TurnRecord["reply"] = { mode: "ask", message: "which database?" }
const answered: TurnRecord["reply"] = { mode: "reply", message: "there is no database yet" }

describe("renderConversation", () => {
  it("renders nothing when there is no history", () => {
    // The leader's template carries the placeholder, so an unresolved one would
    // reach the model as literal `{{conversation}}`.
    expect(renderConversation(undefined)).toBe("")
    expect(renderConversation([])).toBe("")
  })

  it("shows a question and the answer that follows it", () => {
    const block = renderConversation([turn("build a web app", asked), turn("Postgres")])

    expect(block).toContain("1. user: build a web app")
    expect(block).toContain("you asked: which database?")
    expect(block).toContain("2. user: Postgres")
  })

  it("labels an answered turn differently from a question", () => {
    expect(renderConversation([turn("hello", answered)])).toContain(
      "you answered: there is no database yet"
    )
  })

  it("leaves out the leader line for a turn that ran a pipeline", () => {
    const block = renderConversation([turn("add a --json flag")])

    expect(block).toContain("1. user: add a --json flag")
    expect(block).not.toContain("you ")
  })

  it("keeps only the most recent turns", () => {
    const history = Array.from({ length: MAX_CONVERSATION_TURNS + 4 }, (_, i) =>
      turn(`requirement ${i + 1}`)
    )

    const block = renderConversation(history)

    expect(block).not.toContain("requirement 1\n")
    expect(block).not.toContain("requirement 4")
    expect(block).toContain("requirement 5")
    expect(block).toContain(`requirement ${MAX_CONVERSATION_TURNS + 4}`)
  })

  it("numbers turns absolutely, so a trimmed window is not renumbered", () => {
    const history = Array.from({ length: MAX_CONVERSATION_TURNS + 2 }, (_, i) =>
      turn(`requirement ${i + 1}`)
    )

    const block = renderConversation(history)

    // Turns 1 and 2 are dropped, so the window starts at 3 — renumbering it to 1
    // would make the transcript disagree with the console's own turn counter.
    expect(block).toContain("3. user: requirement 3")
    expect(block).not.toContain("1. user: requirement 3")
  })

  it("drops the oldest turns rather than the newest to fit the budget", () => {
    const bulky = (marker: string): TurnRecord => ({
      requirement: `${marker} ${"r".repeat(MAX_CONVERSATION_CHARS)}`,
      reply: { mode: "ask", message: `${marker} ${"m".repeat(MAX_CONVERSATION_CHARS)}` },
    })
    const history = Array.from({ length: MAX_CONVERSATION_TURNS }, (_, i) => bulky(`turn-${i + 1}`))

    const block = renderConversation(history)

    expect(block.length).toBeLessThan(MAX_CONVERSATION_CHARS + HEADING)
    expect(block).toContain(`turn-${MAX_CONVERSATION_TURNS}`)
    // The turn a follow-up answers is the newest one, so it is the last thing
    // that may be thrown away.
    expect(block).not.toContain("turn-1")
  })

  it("clips a single oversized turn instead of dropping the conversation", () => {
    const block = renderConversation([turn("x".repeat(MAX_CONVERSATION_CHARS * 2))])

    expect(block.length).toBeLessThan(MAX_CONVERSATION_CHARS + HEADING)
    expect(block).toContain("1. user:")
    expect(block.endsWith("…\n")).toBe(true)
  })

  it("trims surrounding whitespace on each entry", () => {
    const block = renderConversation([turn("  spaced  ", { mode: "ask", message: "  why?  " })])

    expect(block).toContain("1. user: spaced\n")
    expect(block).toContain("you asked: why?\n")
  })
})
