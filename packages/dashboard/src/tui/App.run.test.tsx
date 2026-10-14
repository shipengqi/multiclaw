import * as fs from "node:fs"
import * as path from "node:path"
import type { MultiClawConfig } from "@multiclawcli/core"
import { agents, runtimeRegistry } from "@multiclawcli/core"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { stripAnsi } from "./state"
import { driveFrame } from "./test-helpers"

/**
 * `describe()` for a fake runtime: present, but claiming no capabilities. These
 * tests drive the rendered frame, not capability negotiation.
 */
function alwaysAvailable(name: string) {
  return async () => ({
    name,
    available: true,
    capabilities: {
      streaming: false,
      sessions: false,
      resume: false,
      permissions: false,
      tools: false,
      models: false,
      images: false,
      usage: false,
      cost: false,
      sandbox: false,
    },
  })
}

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
      describe: alwaysAvailable(RUNTIME),
      async execute(task) {
        if (task.agentId === "leader") {
          return { output: '{"mode":"run","run":["architect","dev"]}', exitCode: 0 }
        }
        task.onEvent?.({
          runId: "run-1",
          agentId: task.agentId,
          seq: 0,
          type: "message_delta",
          role: "agent",
          text: `${task.agentId}: working\n`,
        })
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

  it("toggles tool detail with the /verbose command", async () => {
    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })

    const frame = stripAnsi(
      await driveFrame(
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
          thenKeys: ["/verbose", "\r"],
          ready: finished,
          settleMs: 200,
        }
      )
    )

    expect(frame).toContain("verbose on — showing tool detail")
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
      describe: alwaysAvailable(REPLY_RUNTIME),
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
      describe: alwaysAvailable(SLOW_RUNTIME),
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
      describe: alwaysAvailable(SLOW_RUNTIME),
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
      describe: alwaysAvailable(WORKSPACE_RUNTIME),
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

const ASK_RUNTIME = "tui-integration-ask"

const ASK_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-ask",
  // The real preset, on purpose: the conversation reaches the leader through its
  // task template, so a stub `taskPrompt` would have nothing to assert against.
  leader: agents.leader({ runtime: ASK_RUNTIME }),
  agents: [agents.architect({ runtime: ASK_RUNTIME })],
}

describe("App · answering a question the leader asked", () => {
  /** How many times the leader has run so far. */
  let leaderRuns = 0
  /** The prompt the leader was handed on the turn that follows its question. */
  let secondPrompt = ""

  beforeEach(() => {
    leaderRuns = 0
    secondPrompt = ""
  })

  beforeAll(() => {
    runtimeRegistry.register({
      name: ASK_RUNTIME,
      describe: alwaysAvailable(ASK_RUNTIME),
      async execute(task) {
        if (task.agentId !== "leader") return { output: "done", exitCode: 0 }
        leaderRuns += 1
        if (leaderRuns === 1) {
          return { output: '{"mode":"ask","message":"which database?"}', exitCode: 0 }
        }
        secondPrompt = task.prompt
        return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
      },
    })
  })

  // Regression: a bare answer arrived with nothing behind it. The leader was
  // handed "Postgres" as a requirement, with no way to know which question it
  // answered — so it asked again, and the console never got past the question.
  it("hands the leader the question its answer belongs to", async () => {
    let completes = 0
    let resolveSecond: () => void = () => {}
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })

    await driveFrame(
      <App
        config={ASK_CONFIG}
        onTurnStart={(bus) => {
          bus.subscribe((event) => {
            if (event.type !== "orchestration:complete") return
            completes += 1
            if (completes === 2) resolveSecond()
          })
        }}
      />,
      { keys: ["build a web app", "\r", "Postgres", "\r"], ready: second, timeoutMs: 5000 }
    )

    expect(completes).toBe(2)
    expect(secondPrompt).toContain("Postgres")
    expect(secondPrompt).toContain("build a web app")
    expect(secondPrompt).toContain("you asked: which database?")
    // Resolved, not left for the model to read as literal template text.
    expect(secondPrompt).not.toContain("{{conversation}}")
  })
})

/**
 * A runtime whose agents emit one long line of prose.
 *
 * The stream pane wraps its output itself, against a width it works out from the
 * terminal geometry rather than one it can measure back out of Yoga. That
 * arithmetic is the risk: too generous and every full row gets shaved at the
 * pane edge, which is exactly the truncation the wrapping was added to remove.
 * Only a real run through the real layout can catch it.
 */
const LONG_RUNTIME = "tui-integration-long"

/** Long enough to wrap over several rows of the stream pane, but not to overflow it. */
const LONG_LINE = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ")

const LONG_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-long",
  leader: {
    id: "leader",
    name: "Leader",
    icon: "◆",
    runtime: LONG_RUNTIME,
    systemPrompt: "",
    taskPrompt: "",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      icon: "◇",
      runtime: LONG_RUNTIME,
      model: "sonnet-4",
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

describe("App · a turn whose output is wider than the pane", () => {
  beforeAll(() => {
    runtimeRegistry.register({
      name: LONG_RUNTIME,
      describe: alwaysAvailable(LONG_RUNTIME),
      async execute(task) {
        if (task.agentId === "leader") {
          return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
        }
        task.onEvent?.({
          runId: "run-1",
          agentId: task.agentId,
          seq: 0,
          type: "message_delta",
          role: "agent",
          text: `${LONG_LINE}\n`,
        })
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  async function runLongTurn(columns: number): Promise<string> {
    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })

    const frame = await driveFrame(
      <App
        config={LONG_CONFIG}
        onTurnStart={(bus) => {
          bus.subscribe((event) => {
            if (event.type === "orchestration:complete") complete()
          })
        }}
      />,
      { keys: ["add a --json flag", "\r"], columns, rows: 30, ready: finished }
    )
    return stripAnsi(frame)
  }

  it("wraps a wide line instead of cutting it off at the pane edge", async () => {
    const frame = await runLongTurn(100)
    // Every word survives, so the pane did not truncate the line.
    for (const word of LONG_LINE.split(" ")) expect(frame).toContain(word)
  })

  it("wraps to the narrower pane of a compact terminal too", async () => {
    const frame = await runLongTurn(60)
    for (const word of LONG_LINE.split(" ")) expect(frame).toContain(word)
  })
})

/** A runtime whose agents report a USD cost, as `claude-agent-acp` does. */
const COST_RUNTIME = "tui-integration-cost"

const COST_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-cost",
  leader: {
    id: "leader",
    name: "Leader",
    icon: "◆",
    runtime: COST_RUNTIME,
    systemPrompt: "",
    taskPrompt: "",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      icon: "◇",
      runtime: COST_RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

describe("App · a run that reports cost", () => {
  beforeAll(() => {
    runtimeRegistry.register({
      name: COST_RUNTIME,
      describe: alwaysAvailable(COST_RUNTIME),
      async execute(task) {
        if (task.agentId === "leader") {
          return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
        }
        return { output: `${task.agentId} finished`, exitCode: 0, costUsd: 0.42 }
      },
    })
  })

  // The turn's total cost rides on the status line once the turn is over. It is
  // printed only when a cost was reported — never a default "$0.00".
  it("shows the turn's total cost in the footer", async () => {
    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })

    const frame = stripAnsi(
      await driveFrame(
        <App
          config={COST_CONFIG}
          onTurnStart={(bus) => {
            bus.subscribe((event) => {
              if (event.type === "orchestration:complete") complete()
            })
          }}
        />,
        { keys: ["add a --json flag", "\r"], ready: finished }
      )
    )

    expect(frame).toContain("$0.42")
  })
})

/** A runtime whose single agent succeeds — a turn with nothing to retry. */
const RETRY_OK_RUNTIME = "tui-integration-retry-ok"

const RETRY_OK_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-retry-ok",
  leader: {
    id: "leader",
    name: "Leader",
    runtime: RETRY_OK_RUNTIME,
    systemPrompt: "",
    taskPrompt: "",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      runtime: RETRY_OK_RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

describe("App · /retry with nothing to retry", () => {
  beforeAll(() => {
    runtimeRegistry.register({
      name: RETRY_OK_RUNTIME,
      describe: alwaysAvailable(RETRY_OK_RUNTIME),
      async execute(task) {
        if (task.agentId === "leader") {
          return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
        }
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  it("says there is nothing to retry when the turn had no failures", async () => {
    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })

    const frame = stripAnsi(
      await driveFrame(
        <App
          config={RETRY_OK_CONFIG}
          onTurnStart={(bus) => {
            bus.subscribe((event) => {
              if (event.type === "orchestration:complete") complete()
            })
          }}
        />,
        { keys: ["add a flag", "\r"], thenKeys: ["/retry", "\r"], ready: finished, settleMs: 200 }
      )
    )

    expect(frame).toContain("nothing failed")
  })
})

/** A runtime whose `dev` agent fails once, then succeeds — so a retry can fix it. */
const RETRY_FAIL_RUNTIME = "tui-integration-retry-fail"

const RETRY_FAIL_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-retry-fail",
  leader: {
    id: "leader",
    name: "Leader",
    runtime: RETRY_FAIL_RUNTIME,
    systemPrompt: "",
    taskPrompt: "",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      runtime: RETRY_FAIL_RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    },
    {
      id: "dev",
      name: "Developer",
      runtime: RETRY_FAIL_RUNTIME,
      dependsOn: ["architect"],
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

describe("App · /retry re-runs a failed agent", () => {
  /** How many times the leader ran, across every turn. */
  let leaderRuns = 0
  /** Every agent the runtime was asked to run, in order, across every turn. */
  let runs: string[] = []
  /** `dev` fails on its first attempt and succeeds afterwards. */
  let devAttempts = 0

  beforeEach(() => {
    leaderRuns = 0
    runs = []
    devAttempts = 0
  })

  beforeAll(() => {
    runtimeRegistry.register({
      name: RETRY_FAIL_RUNTIME,
      describe: alwaysAvailable(RETRY_FAIL_RUNTIME),
      async execute(task) {
        runs.push(task.agentId)
        if (task.agentId === "leader") {
          leaderRuns += 1
          return { output: '{"mode":"run","run":["architect","dev"]}', exitCode: 0 }
        }
        if (task.agentId === "dev") {
          devAttempts += 1
          if (devAttempts === 1) throw new Error("dev exploded")
        }
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  it("re-runs only the failed agent, without consulting the leader again", async () => {
    let completes = 0
    let firstDone: () => void = () => {}
    const first = new Promise<void>((resolve) => {
      firstDone = resolve
    })

    const frame = stripAnsi(
      await driveFrame(
        <App
          config={RETRY_FAIL_CONFIG}
          onTurnStart={(bus) => {
            bus.subscribe((event) => {
              if (event.type !== "orchestration:complete") return
              completes += 1
              if (completes === 1) firstDone()
            })
          }}
        />,
        {
          keys: ["add a flag", "\r"],
          thenKeys: ["/retry", "\r"],
          ready: first,
          settleMs: 400,
        }
      )
    )

    // The retry ran as a second turn.
    expect(completes).toBe(2)
    // The leader planned once, in turn one; the retry bypassed it entirely.
    expect(leaderRuns).toBe(1)
    // Turn two ran exactly the failed agent — not the leader, not architect.
    expect(runs).toEqual(["leader", "architect", "dev", "dev"])
    expect(frame).toContain("turn 2")
  })
})

/** A runtime that records the requirement it was handed, via the leader's prompt. */
const PROMPT_RUNTIME = "tui-integration-prompt"

/** The last prompt the leader was handed. Its template is just `{{requirement}}`. */
let leaderPrompt = ""

const PROMPT_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-prompt",
  leader: {
    id: "leader",
    name: "Leader",
    icon: "◆",
    runtime: PROMPT_RUNTIME,
    systemPrompt: "",
    taskPrompt: "{{requirement}}",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      runtime: PROMPT_RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

describe("App · the prompt line", () => {
  beforeEach(() => {
    leaderPrompt = ""
  })

  beforeAll(() => {
    runtimeRegistry.register({
      name: PROMPT_RUNTIME,
      describe: alwaysAvailable(PROMPT_RUNTIME),
      async execute(task) {
        if (task.agentId === "leader") {
          leaderPrompt = task.prompt
          return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
        }
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  /**
   * Type `keys`, press enter, and return the requirement the leader was handed.
   *
   * The leader's template is the raw `{{requirement}}`, so its prompt *is* the
   * requirement — which is the value `submit` handed the orchestrator.
   */
  async function submit(keys: string[]): Promise<string> {
    let complete: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      complete = resolve
    })
    await driveFrame(
      <App
        config={PROMPT_CONFIG}
        onTurnStart={(bus) => {
          bus.subscribe((event) => {
            if (event.type === "orchestration:complete") complete()
          })
        }}
      />,
      { keys: [...keys, "\r"], ready: finished, timeoutMs: 3000 }
    )
    return leaderPrompt
  }

  // Regression: a paste used to be flattened to a single line, so a pasted stack
  // trace reached the leader as one unreadable row.
  it("keeps the line breaks a paste carried", async () => {
    expect(await submit(["a\nb"])).toBe("a\nb")
  })

  // The glyph substitution must not disturb ordinary single-line editing: a
  // character typed mid-line lands at the caret, not at the end.
  it("inserts a character at the caret, not at the end", async () => {
    expect(await submit(["ac", "\u001b[D", "b"])).toBe("abc")
  })

  it("deletes the character before the caret", async () => {
    expect(await submit(["abc", "\u001b[D", "\u001b[D", "\u007f"])).toBe("bc")
  })
})

/** A runtime that records the requirement the leader was handed, once per turn. */
const REPLAY_RUNTIME = "tui-integration-replay"

const REPLAY_CONFIG: MultiClawConfig = {
  name: "dev-team",
  workDir: "/tmp/multiclaw-tui-replay",
  leader: {
    id: "leader",
    name: "Leader",
    icon: "◆",
    runtime: REPLAY_RUNTIME,
    // The raw requirement, so the leader's prompt *is* what a turn was asked to
    // do — which is exactly what `/replay` and `/fork` act on.
    systemPrompt: "",
    taskPrompt: "{{requirement}}",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      runtime: REPLAY_RUNTIME,
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

describe("App · replaying and forking finished turns", () => {
  /** The requirement the leader was handed, once per turn. */
  let prompts: string[] = []
  /** How many turns have started, across every turn of the test. */
  let starts = 0

  beforeEach(() => {
    prompts = []
    starts = 0
  })

  beforeAll(() => {
    runtimeRegistry.register({
      name: REPLAY_RUNTIME,
      describe: alwaysAvailable(REPLAY_RUNTIME),
      async execute(task) {
        if (task.agentId === "leader") {
          prompts.push(task.prompt)
          return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
        }
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  /**
   * Type `keys` until `readyAt` turns have completed, then type `thenKeys`.
   *
   * The `thenKeys` start one more turn (a replay), which is given `settleMs` to
   * finish — the same shape the `/retry` test uses.
   */
  async function drive(keys: string[], readyAt: number, thenKeys: string[] = []): Promise<string> {
    let completes = 0
    let resolveReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })

    const frame = await driveFrame(
      <App
        config={REPLAY_CONFIG}
        onTurnStart={(bus) => {
          starts += 1
          bus.subscribe((event) => {
            if (event.type !== "orchestration:complete") return
            completes += 1
            if (completes === readyAt) resolveReady()
          })
        }}
      />,
      { keys, ready, thenKeys, settleMs: 500, timeoutMs: 8000 }
    )
    return stripAnsi(frame)
  }

  it("replays the last finished turn by default", async () => {
    await drive(["first task", "\r", "second task", "\r"], 2, ["/replay", "\r"])

    // Three turns ran; the third re-ran the second's requirement verbatim.
    expect(prompts).toEqual(["first task", "second task", "second task"])
  })

  it("replays the turn named by number", async () => {
    await drive(["first task", "\r", "second task", "\r"], 2, ["/replay 1", "\r"])

    expect(prompts).toEqual(["first task", "second task", "first task"])
  })

  it("reports an unknown turn without starting one", async () => {
    const frame = await drive(["first task", "\r"], 1, ["/replay 99", "\r"])

    expect(frame).toContain("no turn 99")
    // The failed replay started nothing: only the original turn ever began.
    expect(starts).toBe(1)
  })

  it("says there is nothing to replay on a fresh console", async () => {
    const frame = stripAnsi(
      await driveFrame(<App config={REPLAY_CONFIG} />, { keys: ["/replay", "\r"], settleMs: 200 })
    )

    expect(frame).toContain("nothing to replay yet")
  })

  // Forking only edits the prompt — it must not run anything, so the whole point
  // is that the turn count does not move.
  it("fills the prompt from a past turn without running it", async () => {
    const frame = await drive(["first task", "\r", "second task", "\r"], 2, ["/fork 1", "\r"])

    expect(frame).toContain("› first task")
    expect(starts).toBe(2)
  })
})

describe("App · completing an agent id", () => {
  beforeAll(() => {
    runtimeRegistry.register({
      name: REPLAY_RUNTIME,
      describe: alwaysAvailable(REPLAY_RUNTIME),
      async execute(task) {
        if (task.agentId === "leader") {
          return { output: '{"mode":"run","run":["architect"]}', exitCode: 0 }
        }
        return { output: `${task.agentId} finished`, exitCode: 0 }
      },
    })
  })

  // The argument palette opens where the command palette closes (on the space),
  // and the hint bar advertises the key that accepts a row.
  it("opens the argument palette after /focus and advertises the accept key", async () => {
    const frame = stripAnsi(
      await driveFrame(<App config={REPLAY_CONFIG} />, { keys: ["/focus "], settleMs: 200 })
    )

    expect(frame).toContain("↑↓ select · enter focus · esc close")
  })

  it("runs /focus with the highlighted agent when a row is accepted", async () => {
    const frame = stripAnsi(
      await driveFrame(<App config={REPLAY_CONFIG} />, { keys: ["/focus ", "\r"], settleMs: 200 })
    )

    expect(frame).toContain("focused leader")
  })
})

describe("App · the command palette window", () => {
  // There are more commands than `MAX_MENU_ROWS`, so the palette draws a window
  // that has to follow the selection. Before this, the window was pinned to the
  // top `MAX_MENU_ROWS` rows and the highlight was clamped inside it, so the
  // eighth command could not be reached with the arrow keys at all.
  it("follows the selection past the first window", async () => {
    const down = "\u001b[B"
    const frame = stripAnsi(
      await driveFrame(<App config={REPLAY_CONFIG} />, {
        // `/` opens the palette on every command; seven `↓` moves onto the
        // eighth, which is `/fork` and sits below the first window.
        keys: ["/", ...Array.from({ length: 7 }, () => down)],
        settleMs: 0,
      })
    )

    expect(frame).toContain("› /fork")
  })
})

/**
 * A clean workspace before every test.
 *
 * T9 makes the console persist finished turns under `config.workDir`, and every
 * config above points at a fixed `/tmp` path. Without this, a turn written by
 * one test — or by a previous *run* of the suite — would be restored into the
 * next render, so `turn 2` would come back as `turn 7` and the suite would fail
 * on its second run. Wiping the console directory restores the isolation the
 * tests had before anything was written to disk.
 */
beforeEach(() => {
  for (const { workDir } of [
    CONFIG,
    REPLY_CONFIG,
    SLOW_CONFIG,
    WORKSPACE_CONFIG,
    ASK_CONFIG,
    LONG_CONFIG,
    COST_CONFIG,
    RETRY_OK_CONFIG,
    RETRY_FAIL_CONFIG,
    PROMPT_CONFIG,
    REPLAY_CONFIG,
  ]) {
    fs.rmSync(path.join(workDir, ".multiclaw", "console"), { recursive: true, force: true })
  }
})
