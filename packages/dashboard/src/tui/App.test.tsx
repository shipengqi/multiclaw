import { describe, expect, it } from "vitest"
import { App } from "./App"
import { stripAnsi } from "./state"
import { DEMO, driveFrame, PRESET, renderFrame } from "./test-helpers"

function welcome(columns = 100, rows = 30): Promise<string> {
  return renderFrame(<App config={DEMO} />, columns, rows).then(stripAnsi)
}

describe("App", () => {
  it("opens on a welcome screen rather than a blank pane", async () => {
    const frame = await welcome()
    expect(frame).toContain("A team of agents, one prompt away.")
    expect(frame).toContain("Type a requirement and press enter.")
  })

  it("names the team and what each agent is for", async () => {
    const frame = await welcome()
    expect(frame).toContain("◆ multiclaw")
    expect(frame).toContain("dev-team")
    expect(frame).toContain("Leader")
    expect(frame).toContain("plans the pipeline")
    expect(frame).toContain("Architect")
    expect(frame).toContain("designs the solution")
    expect(frame).toContain("Developer")
    expect(frame).toContain("writes the code")
  })

  it("never renders an empty roster, even before the first turn", async () => {
    expect(await welcome()).not.toContain("no agents configured")
  })

  // Regression: the roster read only `taskTitle`, which the leader's task plan
  // fills in per turn. The built-in presets declare no task title, so a team
  // built from them — as `examples/dev-team` is — showed a blank column.
  it("names what each agent is for on the first screen", async () => {
    const frame = stripAnsi(await renderFrame(<App config={PRESET} />))
    expect(frame).toContain("routes the request")
    expect(frame).toContain("designs the architecture")
    expect(frame).toContain("builds the API")
    expect(frame).toContain("verifies the behaviour")
    expect(frame).toContain("reviews the code")
  })

  // Regression: `tab` did nothing visible here, because the welcome roster was
  // the one list on screen that ignored `focusId`.
  it("moves the roster caret when tab is pressed", async () => {
    const before = stripAnsi(await renderFrame(<App config={DEMO} />))
    const after = stripAnsi(await driveFrame(<App config={DEMO} />, { keys: ["\t"], settleMs: 0 }))
    expect(before).toContain("› ◆ Leader")
    expect(after).toContain("› ◇ Architect")
    expect(after).not.toContain("› ◆ Leader")
  })

  it("reports the turn and the phase in the header", async () => {
    expect(await welcome()).toContain("turn 0 · ready")
  })

  it("reports the team size in the footer", async () => {
    expect(await welcome()).toContain("ready · 3 agents")
  })

  it("advertises only the keys that work on an empty prompt", async () => {
    expect(await welcome()).toContain("tab switch · / commands · ? help")
  })

  it("shows the prompt placeholder", async () => {
    expect(await welcome()).toContain("describe what the team should do…")
  })

  // Regression: the caret used to be an extra cell that disappeared when the
  // blink was off, so the placeholder jumped a column twice a second.
  it("sits the caret on the placeholder rather than in front of it", async () => {
    expect(await welcome()).toContain("› describe what the team should do…")
  })

  it("draws a caret, since the terminal's own cursor is hidden", async () => {
    expect(await renderFrame(<App config={DEMO} />)).toContain("\u001b[7m")
  })

  it("rules the full width of the terminal", async () => {
    expect(await welcome(60, 30)).toContain("─".repeat(60))
  })

  it("still lays out on a terminal far below the design size", async () => {
    expect(await welcome(20, 5)).toContain("multiclaw")
  })

  // The chrome is budgeted by row count, and when that budget is wrong Yoga
  // silently squeezes a child to nothing — historically the header. Every one of
  // these three has to survive at every size.
  it.each([
    [120, 40],
    [100, 30],
    [80, 24],
    [72, 24],
    [60, 20],
    [40, 10],
  ])("keeps the header, prompt and footer on a %ix%i terminal", async (columns, rows) => {
    const frame = await welcome(columns, rows)
    expect(frame).toContain("◆ multiclaw")
    expect(frame).toContain("describe what the team should do…")
    expect(frame).toContain("tab switch")
  })
})
