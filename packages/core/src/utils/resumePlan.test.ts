import { describe, expect, it } from "vitest"
import { describeResumePlan } from "./resumePlan"

const TEAM = [
  { id: "architect" },
  { id: "dev", dependsOn: ["architect"] },
  { id: "reviewer", dependsOn: ["dev"] },
]

describe("describeResumePlan", () => {
  it("says an agent with no session starts fresh", () => {
    expect(describeResumePlan({ agents: ["architect"], team: TEAM })).toBe("architect starts fresh")
  })

  it("says an agent with a session continues it", () => {
    expect(
      describeResumePlan({ agents: ["architect"], sessions: { architect: "s-1" }, team: TEAM })
    ).toBe("architect continues its session")
  })

  // The whole point: a single-agent retry drops the dependency that made the
  // agent run last time, so the retry is a different pipeline. Saying so is
  // the difference between "reviewer failed again" and "reviewer ran without
  // the plan it was reviewing".
  it("names the dependency a retry drops", () => {
    expect(describeResumePlan({ agents: ["dev"], team: TEAM })).toBe(
      "dev starts fresh; dev runs without architect"
    )
  })

  it("says nothing about dependencies the retry keeps", () => {
    expect(describeResumePlan({ agents: ["architect", "dev"], team: TEAM })).toBe(
      "architect starts fresh; dev starts fresh"
    )
  })

  // Core keeps a dependency on an unconfigured id (only *skipped* agents are
  // pruned), so claiming the retry dropped it would be a lie — and the stage
  // ordering breaks the same way in every run, not just this one.
  it("ignores a dependency that is not configured", () => {
    const team = [{ id: "dev", dependsOn: ["ghost"] }]
    expect(describeResumePlan({ agents: ["dev"], team })).toBe("dev starts fresh")
  })

  it("lists every dropped dependency", () => {
    const team = [{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a", "b"] }]
    expect(describeResumePlan({ agents: ["c"], team })).toBe("c starts fresh; c runs without a, b")
  })

  it("describes each agent in the order it was named", () => {
    expect(
      describeResumePlan({
        agents: ["reviewer", "architect"],
        sessions: { reviewer: "s-9" },
        team: TEAM,
      })
    ).toBe("reviewer continues its session; architect starts fresh; reviewer runs without dev")
  })

  // A session for an agent that is not being resumed is simply not its
  // session: the description only speaks about what runs.
  it("ignores sessions belonging to agents outside the retry", () => {
    expect(
      describeResumePlan({ agents: ["architect"], sessions: { dev: "s-1" }, team: TEAM })
    ).toBe("architect starts fresh")
  })
})
