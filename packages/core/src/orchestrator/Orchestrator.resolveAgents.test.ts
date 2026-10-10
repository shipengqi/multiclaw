import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import type { AgentDefinition } from "../types/agent"
import type { MultiClawConfig } from "../types/config"
import type { MultiClawEvent } from "../types/event"
import type { AgentOutput } from "../types/runtime"
import { Orchestrator } from "./Orchestrator"

const RUNTIME = "test-resolve-agents"

let leaderOutput = ""
let leaderShouldFail = false

beforeAll(() => {
  runtimeRegistry.register(
    fakeRuntime(RUNTIME, async (): Promise<AgentOutput> => {
      if (leaderShouldFail) throw new Error("leader exploded")
      return { output: leaderOutput, exitCode: 0 }
    })
  )
})

let workDir: string
beforeEach(() => {
  leaderOutput = ""
  leaderShouldFail = false
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-resolve-"))
})
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

function build(agents: AgentDefinition[], leader?: AgentDefinition, useLeader?: boolean) {
  const config: MultiClawConfig = {
    name: "test",
    workDir,
    agents,
    leader,
    useLeader,
  }
  const orch = new Orchestrator(config)
  const events: MultiClawEvent[] = []
  orch.eventBus.subscribe((e) => events.push(e))
  return { orch, events }
}

const resolveAgents = (orch: Orchestrator): Promise<AgentDefinition[]> =>
  (orch as unknown as { resolveAgents(): Promise<AgentDefinition[]> }).resolveAgents()

describe("Orchestrator.resolveAgents", () => {
  it("returns all agents untouched when no leader is configured", async () => {
    const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b" })]
    const { orch } = build(agents)

    expect(await resolveAgents(orch)).toEqual(agents)
  })

  it("ignores the leader when useLeader is false", async () => {
    const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b" })]
    const leader = makeAgent({ id: "leader", runtime: RUNTIME })
    leaderOutput = '{"run": ["a"]}'
    const { orch } = build(agents, leader, false)

    expect(await resolveAgents(orch)).toEqual(agents)
  })

  it("keeps only the agents named in the leader plan", async () => {
    const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b" }), makeAgent({ id: "c" })]
    const leader = makeAgent({ id: "leader", runtime: RUNTIME })
    leaderOutput = 'Here is the plan: {"run": ["a", "c"]} — done.'
    const { orch, events } = build(agents, leader)

    const result = await resolveAgents(orch)

    expect(result.map((a) => a.id)).toEqual(["a", "c"])
    const skipped = events.filter((e) => e.type === "agent:skipped")
    expect(skipped).toHaveLength(1)
    expect(skipped[0].payload).toMatchObject({ agentId: "b" })
  })

  it("drops dependsOn entries that point at skipped agents", async () => {
    const agents = [
      makeAgent({ id: "a" }),
      makeAgent({ id: "b", dependsOn: ["a"] }),
      makeAgent({ id: "c", dependsOn: ["b"] }),
    ]
    const leader = makeAgent({ id: "leader", runtime: RUNTIME })
    leaderOutput = '{"run": ["a", "c"]}'
    const { orch } = build(agents, leader)

    const result = await resolveAgents(orch)

    const c = result.find((a) => a.id === "c")
    expect(c?.dependsOn).toEqual([])
  })

  it("falls back to all agents when the leader fails", async () => {
    const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b" })]
    const leader = makeAgent({ id: "leader", runtime: RUNTIME })
    leaderShouldFail = true
    const { orch } = build(agents, leader)

    expect(await resolveAgents(orch)).toEqual(agents)
  })

  it("falls back to all agents when the leader output has no plan JSON", async () => {
    const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b" })]
    const leader = makeAgent({ id: "leader", runtime: RUNTIME })
    leaderOutput = "I could not decide, run everything."
    const { orch } = build(agents, leader)

    expect(await resolveAgents(orch)).toEqual(agents)
  })

  it("falls back to all agents when the plan JSON is malformed", async () => {
    const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b" })]
    const leader = makeAgent({ id: "leader", runtime: RUNTIME })
    leaderOutput = '{"run": [not valid json]}'
    const { orch } = build(agents, leader)

    expect(await resolveAgents(orch)).toEqual(agents)
  })

  it("skips earlier JSON that has no run plan and uses a later valid one", async () => {
    const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b" }), makeAgent({ id: "c" })]
    const leader = makeAgent({ id: "leader", runtime: RUNTIME })
    leaderOutput = '{"meta":{"note":"}"},"ok":true}\nand the answer is {"run":["b"]}'
    const { orch } = build(agents, leader)

    expect((await resolveAgents(orch)).map((a) => a.id)).toEqual(["b"])
  })

  it("falls back when `run` is not an array of strings", async () => {
    const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b" })]
    const leader = makeAgent({ id: "leader", runtime: RUNTIME })
    leaderOutput = '{"run": "a"}'
    const { orch } = build(agents, leader)

    expect(await resolveAgents(orch)).toEqual(agents)
  })
})
