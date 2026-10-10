import type { MultiClawConfig } from "@multiclawcli/core"
import { runtimeRegistry } from "@multiclawcli/core"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { stripAnsi } from "./state"
import { driveFrame } from "./test-helpers"

/**
 * A runtime that answers instantly.
 *
 * These are integration tests for the *rendered frame*, so the only thing the
 * runtime has to do is produce events — timing is deliberately kept out of it.
 *
 * The leader has to emit a plan: without one it is treated as having answered in
 * prose, and the turn ends before any of the team runs.
 */
const RUNTIME = "tui-integration"

const CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-integration",
  leader: {
    id: "leader",
    name: "Leader",
    icon: "◆",
    runtime: RUNTIME,
    taskTitle: "plans the pipeline",
    systemPrompt: "",
    taskPrompt: "",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      icon: "◇",
      runtime: RUNTIME,
      model: "sonnet-4",
      taskTitle: "designs the solution",
      systemPrompt: "",
      taskPrompt: "",
    },
    {
      id: "dev",
      name: "Developer",
      icon: "◇",
      runtime: RUNTIME,
      model: "sonnet-4",
      taskTitle: "writes the code",
      dependsOn: ["architect"],
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

/** The line carrying the stream pane's follow marker, if the pane rendered one. */
function followLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("▼") || line.includes("⏸")) ?? ""
}

/**
 * Run one turn end to end and return the final frame.
 *
 * The wait is driven by the orchestrator's own completion event rather than a
 * timer, so the test never races the console's 80 ms event batching.
 */
async function runTurn(columns = 100, rows = 30): Promise<string> {
  let complete: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    complete = resolve
  })

  const frame = await driveFrame(
    <App
      config={CONFIG}
      onTurnStart={(bus) => {
        bus.subscribe((event) => {
          if (event.type === "orchestration:complete") complete()
        })
      }}
    />,
    {
      keys: ["add a --json flag", "\r"],
      columns,
      rows,
      ready: finished,
    }
  )
  return stripAnsi(frame)
}

describe("App · a full turn", () => {
  beforeAll(() => {
    runtimeRegistry.register({
      name: RUNTIME,
      checkAvailable: async () => true,
      async execute(task) {
        if (task.agentId === "leader") {
          return { output: '{"mode":"run","run":["architect","dev"]}', exitCode: 0 }
        }
        task.onOutput?.(`${task.agentId}: working\n`)
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  it("draws the pipeline with each stage numbered", async () => {
    const frame = await runTurn()
    const rail = frame.split("\n").find((line) => line.includes("──▸")) ?? ""
    expect(rail).toContain("◆ Leader")
    expect(rail).toContain("①")
    expect(rail).toContain("②")
    expect(rail).toContain("Architect")
    expect(rail).toContain("Developer")
  })

  it("fills the roster from the config and marks every agent done", async () => {
    const frame = await runTurn()
    expect(frame).toContain("TEAM")
    expect(frame).toContain("3/3")
    expect(frame).not.toContain("no agents configured")
  })

  it("reports completion in the footer", async () => {
    expect(await runTurn()).toContain("✓ done")
  })

  // Regression: the body sat in a `flexDirection="row"` wrapper, so the row that
  // held the two panes was sized by its content instead of stretching. Every
  // `space-between` inside the body collapsed as a result — the stream header's
  // follow marker drifted to wherever the text happened to end.
  it("stretches the panes to the full width, right-aligning the stream header", async () => {
    const frame = await runTurn(100, 30)
    const line = followLine(frame)
    expect(line).not.toBe("")
    expect(line.length).toBe(100)
    expect(line.endsWith("▼")).toBe(true)
  })

  it("keeps the header right-aligned on a narrow terminal too", async () => {
    const frame = await runTurn(64, 20)
    expect(followLine(frame).length).toBe(64)
  })

  // Regression: the elapsed duration was rendered with no separator, so a
  // running agent read as `running0.2s`.
  it("separates the status label from the elapsed time", async () => {
    const frame = await runTurn()
    expect(frame).not.toMatch(/(running|retrying|done|failed)\d/)
    expect(followLine(frame)).toMatch(/\s\d+(\.\d+)?(ms|s)\s/)
  })
})

/** A runtime whose leader answers in prose instead of planning a pipeline. */
const REPLY_RUNTIME = "tui-integration-reply"

const REPLY_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-reply",
  leader: {
    id: "leader",
    name: "Leader",
    icon: "◆",
    runtime: REPLY_RUNTIME,
    systemPrompt: "",
    taskPrompt: "",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      icon: "◇",
      runtime: REPLY_RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

describe("App · a turn the leader answers", () => {
  /** Every agent the runtime was asked to run, in order. */
  let ran: string[] = []

  beforeEach(() => {
    ran = []
  })

  beforeAll(() => {
    runtimeRegistry.register({
      name: REPLY_RUNTIME,
      checkAvailable: async () => true,
      async execute(task) {
        ran.push(task.agentId)
        if (task.agentId === "leader") {
          return { output: "Hi! Ask me for a change to this project.", exitCode: 0 }
        }
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  /** Send `requirement` and return the frame the console settled on. */
  async function ask(requirement: string): Promise<string> {
    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })

    const frame = await driveFrame(
      <App
        config={REPLY_CONFIG}
        onTurnStart={(bus) => {
          bus.subscribe((event) => {
            if (event.type === "orchestration:complete") complete()
          })
        }}
      />,
      { keys: [requirement, "\r"], ready: finished, timeoutMs: 3000 }
    )
    return stripAnsi(frame)
  }

  // Regression: with no plan JSON the orchestrator used to run *every* configured
  // agent, so a greeting cost a full pipeline and reported a green "done".
  it("shows the answer instead of a pipeline, and runs nobody else", async () => {
    const frame = await ask("hello")

    expect(ran).toEqual(["leader"])
    expect(frame).toContain("answered")
    expect(frame).toContain("Hi! Ask me for a change to this project.")
    // And it does not claim the team did anything.
    expect(frame).not.toContain("✓ done")
  })

  it("leaves the roster out of the hint bar, since there is nothing to switch to", async () => {
    const frame = await ask("hello")

    expect(frame).toContain("enter sends")
    expect(frame).not.toContain("tab switch")
  })
})

/** A runtime that holds each agent open, so a test can type while one runs. */
const SLOW_RUNTIME = "tui-integration-slow"

const SLOW_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-queue",
  leader: {
    id: "leader",
    name: "Leader",
    icon: "◆",
    runtime: SLOW_RUNTIME,
    systemPrompt: "",
    taskPrompt: "",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      icon: "◇",
      runtime: SLOW_RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

describe("App · a follow-up typed mid-run", () => {
  /** How many agents were executing at once. Queueing must keep this at one. */
  let inFlight = 0
  let peak = 0

  beforeEach(() => {
    inFlight = 0
    peak = 0
  })

  beforeAll(() => {
    runtimeRegistry.register({
      name: SLOW_RUNTIME,
      checkAvailable: async () => true,
      async execute(task) {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        try {
          if (task.agentId === "leader")
            return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
          // Hold the turn open long enough for the keystrokes below to land
          // mid-run; 400 ms against a 90 ms typing window leaves a wide margin.
          await new Promise((resolve) => setTimeout(resolve, 400))
          return { output: `${task.agentId} finished`, exitCode: 0 }
        } finally {
          inFlight -= 1
        }
      },
    })
  })

  // Regression: text typed during a run was discarded outright — `handleKey`
  // returned before the character was inserted, and the prompt was disabled. A
  // thought typed mid-run vanished with no feedback whatsoever.
  it("runs the queued text as the next turn instead of dropping it", async () => {
    let completes = 0
    let resolveSecond: () => void = () => {}
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })

    const frame = stripAnsi(
      await driveFrame(
        <App
          config={SLOW_CONFIG}
          onTurnStart={(bus) => {
            bus.subscribe((event) => {
              if (event.type !== "orchestration:complete") return
              completes += 1
              if (completes === 2) resolveSecond()
            })
          }}
        />,
        {
          // The second pair is typed while the first turn is still held open.
          keys: ["first task", "\r", "second task", "\r"],
          ready: second,
          timeoutMs: 3000,
        }
      )
    )

    // Two completions is the whole assertion: if the follow-up had been dropped
    // there would only ever be one turn, and this promise would never resolve.
    expect(completes).toBe(2)
    expect(frame).toContain("turn 2")

    // And it waited its turn. Without the queue the second submit would have
    // started a *concurrent* turn, so this is what separates "queued" from
    // "raced".
    expect(peak).toBe(1)
  })
})

describe("App · browsing finished turns", () => {
  beforeAll(() => {
    runtimeRegistry.register({
      name: SLOW_RUNTIME,
      checkAvailable: async () => true,
      async execute(task) {
        if (task.agentId === "leader") {
          return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
        }
        // Long enough that all three requirements below land while the first
        // turn is still open, so they queue up in the order they were typed.
        await new Promise((resolve) => setTimeout(resolve, 600))
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  /** Run three turns back to back, then type `thenKeys` and return the frame. */
  async function threeTurns(thenKeys: string[]): Promise<string> {
    let completes = 0
    let resolveThird: () => void = () => {}
    const third = new Promise<void>((resolve) => {
      resolveThird = resolve
    })

    return stripAnsi(
      await driveFrame(
        <App
          config={SLOW_CONFIG}
          onTurnStart={(bus) => {
            bus.subscribe((event) => {
              if (event.type !== "orchestration:complete") return
              completes += 1
              if (completes === 3) resolveThird()
            })
          }}
        />,
        {
          keys: ["first task", "\r", "second task", "\r", "third task", "\r"],
          ready: third,
          thenKeys,
          timeoutMs: 8000,
        }
      )
    )
  }

  // Only superseded turns are listed: turn 3 is the one on screen.
  it("lists the turns that have finished, newest first", async () => {
    const frame = await threeTurns(["/history", "\r"])

    expect(frame).toContain("2 earlier")
    expect(frame).toContain("turn 2")
    expect(frame).toContain("turn 1")
    expect(frame).toContain("first task")
    expect(frame).toContain("second task")
    // The turn that is still on screen is not offered back to the user.
    expect(frame).not.toContain("third task")
    // Newest first, so the turn the user just left is at the top of the list.
    expect(frame.indexOf("turn 2")).toBeLessThan(frame.indexOf("turn 1"))
  })

  it("opens the selected turn for reading, with a way back to the live one", async () => {
    const frame = await threeTurns(["/history", "\r", "\r"])

    expect(frame).toContain("viewing turn 2")
    expect(frame).toContain("second task")
    expect(frame).toContain("esc to return")
    // The panes are back, showing the turn that was opened.
    expect(frame).toContain("TEAM")
  })
})

const WORKSPACE_RUNTIME = "tui-integration-workspace"

/** Every working directory the runtime was handed, across all turns. */
const workDirs: string[] = []

const WORKSPACE_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-workspace",
  leader: {
    id: "leader",
    name: "Leader",
    runtime: WORKSPACE_RUNTIME,
    systemPrompt: "",
    taskPrompt: "",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      runtime: WORKSPACE_RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

describe("App · the workspace across turns", () => {
  beforeAll(() => {
    runtimeRegistry.register({
      name: WORKSPACE_RUNTIME,
      checkAvailable: async () => true,
      async execute(task) {
        workDirs.push(task.workDir)
        if (task.agentId === "leader") {
          return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
        }
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  // Regression: every turn was handed its own `.multiclaw/runs/run-<stamp>`
  // sandbox, so turn two could not see a single file turn one had written — a
  // follow-up like "now add tests for that" ran against an empty directory.
  it("hands every turn the same workspace, not a fresh sandbox", async () => {
    workDirs.length = 0

    let firstDone: () => void = () => {}
    const first = new Promise<void>((resolve) => {
      firstDone = resolve
    })

    await driveFrame(
      <App
        config={WORKSPACE_CONFIG}
        onTurnStart={(bus) => {
          bus.subscribe((event) => {
            if (event.type === "orchestration:complete") firstDone()
          })
        }}
      />,
      {
        keys: ["first task", "\r"],
        ready: first,
        thenKeys: ["second task", "\r"],
        // The second turn runs on an instant runtime; this is just long enough
        // for it to finish before the frame is taken.
        settleMs: 400,
      }
    )

    expect(workDirs.length).toBeGreaterThanOrEqual(4) // leader + architect, twice
    expect(new Set(workDirs)).toEqual(new Set(["/tmp/multiclaw-tui-workspace"]))
  })
})
