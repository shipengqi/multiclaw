import { describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { stripAnsi } from "./state"
import { DEMO, driveFrame } from "./test-helpers"

/**
 * The message the fake orchestrator rejects with. Held outside the mock factory
 * so a test can read it without importing through the mock.
 */
const control = vi.hoisted(() => ({ message: "jiti could not load the config" }))

/**
 * Swap only the `Orchestrator` for one whose `run` rejects.
 *
 * The console's error path is otherwise unreachable from the outside — every
 * failure the real orchestrator can hit is caught and turned into a result — so
 * it is exercised here against a stand-in. Everything else in core stays real.
 */
vi.mock("@multiclawcli/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiclawcli/core")>()
  return {
    ...actual,
    Orchestrator: class {
      readonly eventBus = new actual.EventBus()
      async run(): Promise<never> {
        throw new Error(control.message)
      }
    },
  }
})

describe("App · a run that errors", () => {
  it("shows the error in the body, not just a truncated status line", async () => {
    const frame = stripAnsi(
      await driveFrame(<App config={DEMO} />, { keys: ["do it", "\r"], settleMs: 250 })
    )

    expect(frame).toContain("the run stopped")
    expect(frame).toContain("jiti could not load the config")
  })

  // The error panel is an overlay like any other: esc dismisses it and the panes
  // come back, rather than the user having to restart the console.
  it("clears the error on esc and returns to the panes", async () => {
    const frame = stripAnsi(
      await driveFrame(<App config={DEMO} />, {
        keys: ["do it", "\r"],
        thenKeys: ["\u001b"],
        settleMs: 250,
      })
    )

    expect(frame).not.toContain("the run stopped")
    expect(frame).toContain("TEAM")
  })
})
