import { describe, expect, it } from "vitest"
import type { TurnOutcome, TurnRecord } from "../types/config"
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

  it.each<TurnOutcome["execution"]>(["success", "failed", "cancelled", "interrupted", "unknown"])(
    "renders execution %s without a reply",
    (execution) => {
      const block = renderConversation([
        {
          requirement: "run the pipeline",
          outcome: { execution, completedAgents: ["builder", "tester"], failedAgents: [] },
        },
      ])

      expect(block).toContain(`   execution: ${execution}\n`)
      expect(block).toContain("   completed: builder, tester\n")
      expect(block).toContain("   failed: none\n")
      expect(block).toContain("   acceptance: not configured\n")
    }
  )

  it.each<NonNullable<TurnOutcome["acceptance"]>["status"]>([
    "approved",
    "changes_required",
    "failed",
    "cancelled",
  ])("renders acceptance %s separately from agent failures", (status) => {
    const block = renderConversation([
      {
        requirement: "run the pipeline",
        outcome: {
          execution: "failed",
          completedAgents: [],
          failedAgents: [{ agentId: "builder", reason: "compile error" }, { agentId: "tester" }],
          acceptance: { status, reason: "review reason" },
        },
      },
    ])

    expect(block).toContain("   completed: none\n")
    expect(block).toContain("   failed: builder (compile error), tester\n")
    expect(block).toContain(`   acceptance: ${status} (review reason)\n`)
    expect(block.split("\n").find((line) => line.includes("failed:"))).not.toContain(
      "review reason"
    )
    expect(block.split("\n").find((line) => line.includes("acceptance:"))).not.toContain(
      "compile error"
    )
  })

  it("renders acceptance without a reason", () => {
    expect(
      renderConversation([
        {
          requirement: "done",
          outcome: {
            execution: "success",
            completedAgents: [],
            failedAgents: [],
            acceptance: { status: "approved" },
          },
        },
      ])
    ).toContain("   acceptance: approved\n")
  })

  it.each([asked, answered])("preserves reply output even when an outcome exists", (reply) => {
    const original = turn("  hello  ", reply)
    expect(
      renderConversation([
        {
          ...original,
          outcome: { execution: "failed", completedAgents: ["builder"], failedAgents: [] },
        },
      ])
    ).toBe(renderConversation([original]))
  })

  it("preserves the exact legacy output without an outcome", () => {
    expect(renderConversation([turn("  build  "), turn("hello", answered)])).toBe(
      "\n## Conversation so far\n\nEarlier turns of this session, oldest first:\n\n" +
        "1. user: build\n2. user: hello\n   you answered: there is no database yet\n"
    )
  })

  it("clips combined ids and reasons and keeps the newest outcome within the existing budgets", () => {
    const history: TurnRecord[] = Array.from({ length: MAX_CONVERSATION_TURNS + 2 }, (_, i) => ({
      requirement: `turn-${i + 1} ${"r".repeat(5000)}`,
      outcome: {
        execution: "interrupted",
        completedAgents: Array.from({ length: 2000 }, (_, j) => `agent-${j}-${"c".repeat(1000)}`),
        failedAgents: Array.from({ length: 2000 }, (_, j) => ({
          agentId: `failed-${j}-${"f".repeat(400)}`,
          reason: `failure-${"e".repeat(1000)}`,
        })),
        acceptance: { status: "failed", reason: `acceptance-${"a".repeat(5000)}` },
      },
    }))
    const block = renderConversation(history)
    const summaryLines = block
      .split("\n")
      .filter((line) => /^ {3}(execution|completed|failed|acceptance):/.test(line))

    expect(summaryLines.length).toBeGreaterThanOrEqual(4)
    for (const line of summaryLines) expect(line.length).toBeLessThanOrEqual(600)
    for (const label of ["completed", "failed", "acceptance"]) {
      expect(
        summaryLines
          .filter((line) => line.startsWith(`   ${label}:`))
          .every((line) => line.endsWith("…"))
      ).toBe(true)
    }
    expect(block.length).toBeLessThan(MAX_CONVERSATION_CHARS + HEADING)
    expect(block.split("\n\n").pop()?.trim().length).toBeLessThanOrEqual(4000)
    expect(block).toContain("8. user: turn-8")
    expect(block).not.toContain("turn-1")
    expect(block).not.toContain("agent-1999")
    expect(block).not.toContain("failed-1999")
    expect(block).toContain("   acceptance: failed (acceptance-")
    expect(MAX_CONVERSATION_TURNS).toBe(6)
    expect(MAX_CONVERSATION_CHARS).toBe(4000)
  })

  it("bounds summaries made from many short agent ids", () => {
    const block = renderConversation([
      {
        requirement: "many agents",
        outcome: {
          execution: "success",
          completedAgents: Array.from({ length: 10000 }, (_, i) => `agent-${i}`),
          failedAgents: Array.from({ length: 10000 }, (_, i) => ({ agentId: `failed-${i}` })),
        },
      },
    ])
    for (const label of ["completed", "failed"]) {
      const line = block.split("\n").find((line) => line.startsWith(`   ${label}:`))
      expect(line).toBeDefined()
      expect(line?.length).toBeLessThanOrEqual(600)
      expect(line?.endsWith("…")).toBe(true)
    }
    expect(block).not.toContain("agent-9999")
    expect(block).not.toContain("failed-9999")
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
