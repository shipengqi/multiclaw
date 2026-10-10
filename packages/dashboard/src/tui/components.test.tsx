import type { AgentResult, MultiClawConfig, StageInfo } from "@multiclawcli/core"
import { Text } from "ink"
import { describe, expect, it } from "vitest"
import { COMMANDS } from "./commands"
import { Header, HintBar, PipelineRail, QueueStrip, Rule } from "./components/chrome"
import { HelpOverlay, HistoryOverlay } from "./components/overlays"
import { ReplyPanel, StreamPanel, TeamPanel, WelcomePanel } from "./components/panels"
import { CommandMenu, Prompt } from "./components/prompt"
import {
  createInitialState,
  initialState,
  reduceEvent,
  stripAnsi,
  type TuiState,
  type TurnView,
  tuiReducer,
} from "./state"
import { DEMO, renderFrame } from "./test-helpers"

const TS = "2026-01-01T00:00:00.000Z"
/** Four seconds after the turn began, so every live clock reads 4.2s. */
const NOW = Date.parse(TS) + 4200

const STAGES: StageInfo[] = [
  {
    stageIndex: 0,
    agents: [{ id: "architect", name: "Architect", icon: "◇", model: "sonnet-4" }],
  },
  { stageIndex: 1, agents: [{ id: "dev", name: "Developer", icon: "◇", model: "sonnet-4" }] },
]

function result(agentId: string, patch: Partial<AgentResult> = {}): AgentResult {
  return {
    agentId,
    agentName: agentId,
    status: "success",
    output: "",
    duration: 3100,
    attempts: 1,
    startTime: TS,
    endTime: TS,
    ...patch,
  }
}

/**
 * A turn in flight: the leader has already finished, the architect is mid-stream
 * with enough output that the pane has to scroll.
 */
function midRun(): TuiState {
  let state = createInitialState(DEMO)
  state = reduceEvent(state, {
    type: "agent:start",
    timestamp: TS,
    payload: { agentId: "leader", agentName: "Leader", icon: "◆" },
  })
  state = reduceEvent(state, { type: "agent:complete", timestamp: TS, payload: result("leader") })
  state = reduceEvent(state, {
    type: "orchestration:start",
    timestamp: TS,
    payload: { name: "dev-team", totalAgents: 2, stages: STAGES },
  })
  state = reduceEvent(state, {
    type: "agent:start",
    timestamp: TS,
    payload: { agentId: "architect", agentName: "Architect", icon: "◇", model: "sonnet-4" },
  })
  return reduceEvent(state, {
    type: "agent:output",
    timestamp: TS,
    payload: {
      agentId: "architect",
      chunk:
        'Read packages/core/orchestrator.ts\nGrep "withTimeout"\nEdit timeout.ts\nRead AgentRunner.ts\nBash pnpm test\n',
    },
  })
}

describe("Header", () => {
  it("carries the console name, the project and the live context", async () => {
    const frame = stripAnsi(await renderFrame(<Header name="dev-team" right="turn 2 · 12.3s" />))
    expect(frame).toContain("◆ multiclaw")
    expect(frame).toContain("dev-team")
    expect(frame).toContain("turn 2 · 12.3s")
  })

  it("copes with an unnamed project", async () => {
    expect(stripAnsi(await renderFrame(<Header name="" right="ready" />))).toContain("◆ multiclaw")
  })
})

describe("Rule", () => {
  it("spans the requested width", async () => {
    expect(stripAnsi(await renderFrame(<Rule width={40} />))).toContain("─".repeat(40))
  })

  it("draws nothing at zero width", async () => {
    expect(stripAnsi(await renderFrame(<Rule width={0} />)).trim()).toBe("")
  })
})

describe("HintBar", () => {
  it("keeps the status on the left and the keys on the right", async () => {
    const frame = stripAnsi(
      await renderFrame(
        <HintBar status={<Text color="cyan">running</Text>} keys="tab switch" />,
        40
      )
    )
    expect(frame).toContain("running")
    expect(frame).toContain("tab switch")
  })
})

describe("PipelineRail", () => {
  it("draws the leader, then each stage in order, joined by a flow marker", async () => {
    const frame = stripAnsi(await renderFrame(<PipelineRail turn={midRun()} spinner="⠋" />))
    expect(frame).toContain("Leader")
    expect(frame).toContain("①")
    expect(frame).toContain("Architect")
    expect(frame).toContain("②")
    expect(frame).toContain("Developer")
    expect(frame).toContain("──▸")
  })

  it("marks the running agent with the live spinner frame", async () => {
    expect(stripAnsi(await renderFrame(<PipelineRail turn={midRun()} spinner="⠹" />))).toContain(
      "⠹"
    )
  })

  it("renders nothing when there is no pipeline to draw", async () => {
    const empty = createInitialState({ ...DEMO, leader: undefined, agents: [] })
    expect(stripAnsi(await renderFrame(<PipelineRail turn={empty} spinner="⠋" />)).trim()).toBe("")
  })
})

describe("TeamPanel", () => {
  it("lists every agent with a status glyph and a time", async () => {
    const frame = stripAnsi(
      await renderFrame(<TeamPanel turn={midRun()} width={30} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("TEAM")
    expect(frame).toContain("1/3")
    expect(frame).toContain("Leader")
    expect(frame).toContain("3.1s")
    expect(frame).toContain("Architect")
    expect(frame).toContain("Developer")
    expect(frame).toContain("—")
  })

  it("points a caret at the focused agent", async () => {
    const frame = stripAnsi(
      await renderFrame(<TeamPanel turn={midRun()} width={30} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("›")
  })

  it("shows a live clock for the running agent, not the frozen one", async () => {
    const frame = stripAnsi(
      await renderFrame(<TeamPanel turn={midRun()} width={30} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("4.2s")
  })

  it("counts progress as agents settle", async () => {
    const state = reduceEvent(midRun(), {
      type: "agent:complete",
      timestamp: TS,
      payload: result("architect", { duration: 800 }),
    })
    const frame = stripAnsi(
      await renderFrame(<TeamPanel turn={state} width={30} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("2/3")
  })

  it("replaces the clock with a retry counter while an agent is between attempts", async () => {
    const state = reduceEvent(midRun(), {
      type: "agent:retrying",
      timestamp: TS,
      payload: {
        agentId: "architect",
        agentName: "Architect",
        attempt: 2,
        maxAttempts: 3,
        error: "flaky",
      },
    })
    const frame = stripAnsi(
      await renderFrame(<TeamPanel turn={state} width={30} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("retry 2/3")
  })
})

describe("StreamPanel", () => {
  it("heads the pane with the agent, its model, its state and the live marker", async () => {
    const frame = stripAnsi(
      await renderFrame(<StreamPanel turn={midRun()} height={8} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("Architect")
    expect(frame).toContain("sonnet-4")
    expect(frame).toContain("running")
    expect(frame).toContain("▼")
  })

  // Regression: the duration was concatenated straight onto the status label,
  // so a running agent read as `running4.2s`.
  it("puts a space between the status label and the elapsed time", async () => {
    const frame = stripAnsi(
      await renderFrame(<StreamPanel turn={midRun()} height={8} now={NOW} spinner="⠋" />)
    )
    // The duration is right-aligned, so the gap is wide — but it must exist.
    expect(frame).toMatch(/running\s+4\.2s\s▼/)
    expect(frame).not.toContain("running4.2s")
  })

  // The header is the only place the pane proves it filled its width: a pane
  // sized by its content would leave the marker floating mid-row.
  it("right-aligns the header against the pane's right edge", async () => {
    const frame = stripAnsi(
      await renderFrame(<StreamPanel turn={midRun()} height={8} now={NOW} spinner="⠋" />)
    )
    const header = frame.split("\n").find((line) => line.includes("▼")) ?? ""
    expect(header.length).toBe(100)
    expect(header.endsWith("▼")).toBe(true)
  })

  it("renders the agent's output verbatim", async () => {
    const frame = stripAnsi(
      await renderFrame(<StreamPanel turn={midRun()} height={8} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("Read packages/core/orchestrator.ts")
    expect(frame).toContain('Grep "withTimeout"')
  })

  it("swaps the live marker for a parked one once the user scrolls back", async () => {
    const scrolled = tuiReducer(midRun(), { type: "stream:scroll", delta: 1, viewport: 3 })
    const frame = stripAnsi(
      await renderFrame(<StreamPanel turn={scrolled} height={4} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("⏸")
    expect(frame).not.toContain("▼")
    // The line that scrolled out of the window is gone from the pane.
    expect(frame).not.toContain("Read packages/core/orchestrator.ts")
  })

  it("says it is waiting rather than showing an empty pane", async () => {
    const state = midRun()
    const quiet: TuiState = {
      ...state,
      agents: { ...state.agents, architect: { ...state.agents.architect, logs: "" } },
    }
    const frame = stripAnsi(
      await renderFrame(<StreamPanel turn={quiet} height={8} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("waiting for output…")
  })

  it("copes with nothing focused at all", async () => {
    const state = { ...midRun(), focusId: undefined }
    const frame = stripAnsi(
      await renderFrame(<StreamPanel turn={state} height={6} now={NOW} spinner="⠋" />)
    )
    expect(frame).toContain("—")
  })
})

describe("WelcomePanel", () => {
  const view = (config: MultiClawConfig, width = 80) =>
    renderFrame(<WelcomePanel turn={createInitialState(config)} width={width} />).then(stripAnsi)

  /** A team declared the way the built-in presets do: a role, but no task yet. */
  const withRoles: MultiClawConfig = {
    ...DEMO,
    leader: undefined,
    agents: [
      {
        id: "a",
        name: "Architect",
        description: "designs the architecture",
        systemPrompt: "",
        taskPrompt: "",
      },
      {
        id: "b",
        name: "Tester",
        description: "verifies the behaviour",
        systemPrompt: "",
        taskPrompt: "",
      },
    ],
  }

  it("introduces the team and each agent's job", async () => {
    const frame = await view(DEMO)
    expect(frame).toContain("◆ multiclaw")
    expect(frame).toContain("A team of agents, one prompt away.")
    expect(frame).toContain("plans the pipeline")
    expect(frame).toContain("designs the solution")
    expect(frame).toContain("writes the code")
  })

  it("marks the leader apart from the pipeline agents", async () => {
    const frame = await view(DEMO)
    expect(frame).toContain("◆")
    expect(frame).toContain("◇")
  })

  it("tells the user how to start", async () => {
    expect(await view(DEMO)).toContain("Type a requirement and press enter.")
  })

  it("copes with a team that has no task titles", async () => {
    const bare: MultiClawConfig = {
      ...DEMO,
      leader: undefined,
      agents: [{ id: "a", name: "Alpha", systemPrompt: "", taskPrompt: "" }],
    }
    expect(await view(bare)).toContain("Alpha")
  })

  // Regression: the roster only read `taskTitle`, which the orchestrator fills
  // in per turn from the leader's plan. Before the first turn there is no plan,
  // and the built-in presets never set it — so every row rendered a blank.
  it("falls back to the agent's role when no task title has been assigned", async () => {
    const frame = await view(withRoles)
    expect(frame).toContain("designs the architecture")
    expect(frame).toContain("verifies the behaviour")
  })

  it("prefers the assigned task title over the static role", async () => {
    const frame = await view({
      ...DEMO,
      leader: undefined,
      agents: [
        {
          id: "a",
          name: "Architect",
          description: "designs the architecture",
          taskTitle: "Design the Todo API",
          systemPrompt: "",
          taskPrompt: "",
        },
      ],
    })
    expect(frame).toContain("Design the Todo API")
    expect(frame).not.toContain("designs the architecture")
  })

  // Regression: `tab` looked broken on this screen — the hint bar advertised
  // `tab switch` while the only roster on screen ignored the focus entirely.
  it("points a caret at the focused agent, and only at that one", async () => {
    const frame = await view(DEMO)
    expect(frame.split("›").length - 1).toBe(1)
    expect(frame).toContain("› ◆ Leader")
  })

  it("moves the caret when the focus moves", async () => {
    const state = tuiReducer(createInitialState(DEMO), { type: "focus:cycle", delta: 1 })
    const frame = stripAnsi(await renderFrame(<WelcomePanel turn={state} width={80} />))
    expect(frame).toContain("› ◇ Architect")
    expect(frame).not.toContain("› ◆ Leader")
  })

  it("truncates the role instead of overflowing a narrow pane", async () => {
    const frame = await view(
      {
        ...DEMO,
        leader: undefined,
        agents: [
          {
            id: "a",
            name: "Backend Developer",
            description: "designs the architecture",
            systemPrompt: "",
            taskPrompt: "",
          },
        ],
      },
      40
    )
    expect(frame).toContain("designs the")
    expect(frame).toContain("…")
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(40)
  })
})

describe("ReplyPanel", () => {
  it("shows the leader's answer and invites the next requirement", async () => {
    const frame = stripAnsi(
      await renderFrame(<ReplyPanel reply={{ mode: "reply", message: "Hi there." }} width={80} />)
    )
    expect(frame).toContain("answered")
    expect(frame).toContain("Hi there.")
    expect(frame).toContain("Type a requirement and press enter.")
  })

  it("frames a question as a decision to make, not an answer", async () => {
    const frame = stripAnsi(
      await renderFrame(
        <ReplyPanel reply={{ mode: "ask", message: "Which database?" }} width={80} />
      )
    )
    expect(frame).toContain("the team needs a decision")
    expect(frame).toContain("Which database?")
    expect(frame).toContain("Answer below and press enter.")
    expect(frame).not.toContain("answered")
  })

  it("wraps a long answer instead of truncating it", async () => {
    const message = Array.from({ length: 6 }, (_, i) => `word${i}`).join(" ")
    const frame = stripAnsi(
      await renderFrame(<ReplyPanel reply={{ mode: "reply", message }} width={40} />)
    )
    // Every word survives, so nothing is silently cut off.
    for (let i = 0; i < 6; i++) expect(frame).toContain(`word${i}`)
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(40)
  })
})

describe("HistoryOverlay", () => {
  const turn = (n: number, patch: Partial<TurnView> = {}): TurnView => ({
    ...initialState,
    turn: n,
    phase: "complete",
    requirement: `requirement ${n}`,
    ...patch,
  })

  it("says so when there is nothing to browse", async () => {
    const frame = stripAnsi(
      await renderFrame(<HistoryOverlay turns={[]} selected={0} width={80} />)
    )
    expect(frame).toContain("0 earlier")
    expect(frame).toContain("No earlier turns yet.")
  })

  it("shows each turn's outcome, cost and requirement", async () => {
    const frame = stripAnsi(
      await renderFrame(
        <HistoryOverlay
          turns={[
            turn(2, { success: true, totalDuration: 4200, agents: {} }),
            turn(1, { success: false, totalDuration: 900 }),
          ]}
          selected={0}
          width={80}
        />
      )
    )
    expect(frame).toContain("2 earlier")
    expect(frame).toContain("turn 2")
    expect(frame).toContain("✓ done")
    expect(frame).toContain("4.2s")
    expect(frame).toContain("turn 1")
    expect(frame).toContain("✗ failed")
    expect(frame).toContain("requirement 1")
  })

  // A turn that ended in words did not "finish" a pipeline, and the list has to
  // be able to tell the two apart.
  it("names a reply as an answer and a question as a decision", async () => {
    const frame = stripAnsi(
      await renderFrame(
        <HistoryOverlay
          turns={[
            turn(3, { reply: { mode: "ask", message: "which db?" } }),
            turn(2, { reply: { mode: "reply", message: "hi" } }),
          ]}
          selected={0}
          width={80}
        />
      )
    )
    expect(frame).toContain("? needs input")
    expect(frame).toContain("✓ answered")
  })

  it("marks only the selected row with a caret", async () => {
    const frame = stripAnsi(
      await renderFrame(<HistoryOverlay turns={[turn(2), turn(1)]} selected={1} width={80} />)
    )
    expect(frame.split("›").length - 1).toBe(1)
    expect(frame).toContain("› turn 1")
  })

  it("keeps every row inside the pane", async () => {
    const frame = stripAnsi(
      await renderFrame(
        <HistoryOverlay
          turns={[turn(1, { requirement: "x".repeat(200) })]}
          selected={0}
          width={40}
        />
      )
    )
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(40)
  })
})

describe("HelpOverlay", () => {
  it("groups keys by where they apply", async () => {
    const frame = stripAnsi(await renderFrame(<HelpOverlay width={80} />))
    expect(frame).toContain("? keys")
    expect(frame).toContain("prompt")
    expect(frame).toContain("panes")
    expect(frame).toContain("commands")
  })

  it("documents the keys the console actually implements", async () => {
    const frame = stripAnsi(await renderFrame(<HelpOverlay width={80} />))
    for (const key of ["enter", "esc", "tab", "pgup pgdn", "ctrl+l", "/"]) {
      expect(frame).toContain(key)
    }
  })

  it("says how to close itself", async () => {
    expect(stripAnsi(await renderFrame(<HelpOverlay width={80} />))).toContain("esc or ? to close")
  })
})

describe("CommandMenu", () => {
  it("shows each command with its description", async () => {
    const frame = stripAnsi(
      await renderFrame(<CommandMenu commands={[...COMMANDS]} selected={0} />)
    )
    expect(frame).toContain("/agents")
    expect(frame).toContain("List the configured team")
  })

  it("shows an argument hint where a command takes one", async () => {
    const frame = stripAnsi(
      await renderFrame(<CommandMenu commands={[...COMMANDS]} selected={0} />)
    )
    expect(frame).toContain("/focus <id>")
  })

  it("marks the highlighted row and only that row", async () => {
    const frame = stripAnsi(
      await renderFrame(<CommandMenu commands={[...COMMANDS]} selected={1} />)
    )
    expect(frame).toContain("› /focus")
    expect(frame).not.toContain("› /agents")
  })
})

describe("QueueStrip", () => {
  it("renders nothing at all when nothing is queued", async () => {
    expect(stripAnsi(await renderFrame(<QueueStrip items={[]} />))).not.toContain("»")
  })

  it("lists the queued follow-ups in the order they will run", async () => {
    const frame = stripAnsi(
      await renderFrame(<QueueStrip items={["also add tests", "then the docs"]} />)
    )
    expect(frame).toContain("» also add tests")
    expect(frame).toContain("then the docs")
    expect(frame.indexOf("also add tests")).toBeLessThan(frame.indexOf("then the docs"))
  })

  it("marks only the next item, so the list reads as a queue", async () => {
    const frame = stripAnsi(await renderFrame(<QueueStrip items={["first", "second"]} />))
    expect(frame.match(/»/g)).toHaveLength(1)
  })

  it("says how many it could not fit rather than hiding them", async () => {
    const frame = stripAnsi(
      await renderFrame(<QueueStrip items={["one", "two", "three", "four", "five"]} />)
    )
    expect(frame).toContain("(+2 more)")
    expect(frame).not.toContain("four")
  })

  it("stays silent when the terminal gave it no rows", async () => {
    const frame = stripAnsi(await renderFrame(<QueueStrip items={["one"]} max={0} />))
    expect(frame).not.toContain("»")
  })
})

describe("Prompt", () => {
  const PLACEHOLDER = "describe what the team should do…"

  const prompt = (props: Partial<Parameters<typeof Prompt>[0]> = {}) =>
    renderFrame(<Prompt value="" cursor={0} caretVisible placeholder={PLACEHOLDER} {...props} />)

  it("draws the caret as a reversed cell", async () => {
    expect(await prompt()).toContain("\u001b[7m")
  })

  // The bug this guards: the caret used to be an *extra* cell that vanished
  // when the blink was off, so the placeholder slid one column sideways twice a
  // second. Blinking must not change a single visible character.
  it("leaves the placeholder exactly where it was when the caret blinks off", async () => {
    const on = stripAnsi(await prompt({ caretVisible: true }))
    const off = stripAnsi(await prompt({ caretVisible: false }))
    expect(on).toBe(off)
    expect(on).toContain(`› ${PLACEHOLDER}`)
  })

  it("paints the caret onto the first character of the ghost text", async () => {
    const frame = await prompt()
    // The reversed run must wrap the `d`, not a blank cell before it.
    expect(frame).toContain("\u001b[7md")
  })

  // A nested <Text> would inherit the ghost text's dim, and Ink merges styles
  // downward without any way to un-inherit — so the block would wash out.
  it("keeps the caret block at full strength on dimmed ghost text", async () => {
    const frame = await prompt()
    expect(frame).not.toContain("\u001b[2m\u001b[7m")
    expect(frame).toContain("\u001b[7md\u001b[27m\u001b[2m")
  })

  it("dims the caret cell with the ghost text while the blink is off", async () => {
    const frame = await prompt({ caretVisible: false })
    expect(frame).not.toContain("\u001b[7m")
    expect(frame).toContain("\u001b[2mdescribe")
  })

  it("keeps the ghost text from moving as the caret blinks off mid-edit", async () => {
    const props = { value: "ship it", cursor: 4 }
    const on = stripAnsi(await prompt({ ...props, caretVisible: true }))
    const off = stripAnsi(await prompt({ ...props, caretVisible: false }))
    expect(on).toBe(off)
    expect(on).toContain("› ship it")
  })

  it("holds a cell at the end of the line so the width never changes", async () => {
    const on = stripAnsi(await prompt({ value: "ship it", cursor: 7, caretVisible: true }))
    const off = stripAnsi(await prompt({ value: "ship it", cursor: 7, caretVisible: false }))
    // Trailing whitespace is exempt: Ink trims an unstyled trailing space, so
    // the blank cell only survives while it is reversed. Nothing can shift
    // after the caret at end of line, so this is exactly how a real terminal
    // cursor behaves.
    expect(on.trimEnd()).toBe(off.trimEnd())
    expect(on.trimEnd()).toBe("› ship it")
  })

  it("keeps the caret at full strength on typed text", async () => {
    const frame = await prompt({ value: "ship it", cursor: 7, caretVisible: true })
    // Reversed, and not dimmed: the caret must not inherit the ghost styling.
    expect(frame).toContain("\u001b[7m")
    expect(frame).not.toContain("\u001b[2m\u001b[7m")
  })
})
