import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { agents } from "../agents"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import type { AgentDefinition, ToolName } from "../types/agent"
import type { MultiClawConfig } from "../types/config"
import type { MultiClawEvent } from "../types/event"
import type { AgentTask, RuntimeInfo } from "../types/runtime"
import { Orchestrator } from "./Orchestrator"

let workDir: string
const runtimeName = "test-tools-policy"
let execute = vi.fn(async (_task: AgentTask) => ({ output: "work", exitCode: 0 }))
let describeRuntime = vi.fn(fakeRuntime(runtimeName, execute).describe)

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-policy-"))
  execute = vi.fn(async (_task: AgentTask) => ({ output: "work", exitCode: 0 }))
  describeRuntime = vi.fn(fakeRuntime(runtimeName, execute).describe)
  runtimeRegistry.register({ name: runtimeName, execute, describe: describeRuntime })
})
afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }))

const worker = (extra: Partial<AgentDefinition> = {}) =>
  makeAgent({ id: "worker", runtime: runtimeName, ...extra })
const preset = () => agents.backendDeveloper({ runtime: runtimeName })
const config = (overrides: Partial<MultiClawConfig> = {}): MultiClawConfig => ({
  name: "tools-policy",
  workDir,
  agents: [worker()],
  ...overrides,
})

async function run(overrides: Partial<MultiClawConfig>) {
  const orchestrator = new Orchestrator(config(overrides))
  const events: MultiClawEvent[] = []
  orchestrator.eventBus.subscribe((event) => events.push(event))
  return { result: await orchestrator.run(), events }
}

describe("explicit tools preflight", () => {
  it.each<{ tools: ToolName[] }>([{ tools: [] }, { tools: ["Read"] }])(
    "blocks explicit worker tools $tools before any startup",
    async ({ tools }) => {
      fs.writeFileSync(path.join(workDir, "task-plan.json"), "stale")
      const { result, events } = await run({
        agents: [worker({ tools })],
        leader: agents.leader({ runtime: runtimeName }),
      })
      expect(result.success).toBe(false)
      expect(result.agentResults).toEqual([])
      expect(execute).not.toHaveBeenCalled()
      expect(events.map((event) => event.type)).toEqual([
        "orchestration:warning",
        "orchestration:complete",
      ])
      expect(events[0].payload).toMatchObject({
        message: expect.stringMatching(/worker.*test-tools-policy.*opencode.*explicit tools/i),
      })
      expect(fs.readFileSync(path.join(workDir, "task-plan.json"), "utf8")).toBe("stale")
    }
  )

  it.each(["leader", "reviewer"])("blocks explicit %s before any startup", async (role) => {
    const { result } = await run({
      agents: [worker(), worker({ id: "reviewer", tools: role === "reviewer" ? [] : undefined })],
      leader: agents.leader({ runtime: runtimeName, ...(role === "leader" ? { tools: [] } : {}) }),
      review: { reviewer: "reviewer", repairAgents: ["worker"] },
    })
    expect(result.success).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it("throws an actionable preview error before the leader or task-plan cleanup", async () => {
    fs.writeFileSync(path.join(workDir, "task-plan.json"), "stale")
    const orchestrator = new Orchestrator(
      config({
        agents: [worker({ tools: [] })],
        leader: agents.leader({ runtime: runtimeName }),
        defaults: { command: "custom-provider" },
      })
    )
    await expect(orchestrator.preview()).rejects.toThrow(/worker.*custom-provider.*select.*remove/i)
    expect(execute).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(workDir, "task-plan.json"))).toBe(true)
  })

  it("blocks an unselected repair worker before a resumed pipeline starts", async () => {
    const { result } = await run({
      agents: [worker(), worker({ id: "repair", tools: [] }), worker({ id: "reviewer" })],
      review: { reviewer: "reviewer", repairAgents: ["repair"] },
      resume: { agents: ["worker"] },
    })
    expect(result.success).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })

  it("allows unchanged implicit preset tools and their spreads", async () => {
    const implicit = preset()
    const { result } = await run({ agents: [{ ...implicit }] })
    expect(result.success).toBe(true)
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tools: implicit.tools }))
    expect(describeRuntime).not.toHaveBeenCalled()
  })

  it.each(["mutation", "equal replacement", "empty replacement", "factory override"])(
    "blocks preset %s",
    async (kind) => {
      let changed = preset()
      if (kind === "mutation") changed.tools?.push("Edit")
      if (kind === "equal replacement") changed = { ...changed, tools: [...(changed.tools ?? [])] }
      if (kind === "empty replacement") changed = { ...changed, tools: [] }
      if (kind === "factory override")
        changed = agents.backendDeveloper({ runtime: runtimeName, tools: [] })
      const { result } = await run({ agents: [changed] })
      expect(result.success).toBe(false)
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it("inspects explicit agents after an implicit agent sharing the same runtime and command", async () => {
    const { result } = await run({ agents: [preset(), worker({ tools: [] })] })
    expect(result.success).toBe(false)
    expect(describeRuntime).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it("allows explicit tools unchanged when the runtime enforces them", async () => {
    describeRuntime.mockImplementation(async () => {
      const info = await fakeRuntime(runtimeName, execute).describe()
      return { ...info, capabilities: { ...info.capabilities, tools: true } }
    })
    const tools: ToolName[] = []
    const { result } = await run({ agents: [worker({ tools })] })
    expect(result.success).toBe(true)
    expect(execute.mock.calls[0]?.[0].tools).toBe(tools)
  })

  it("caches describe across explicit agents using the same runtime and command", async () => {
    describeRuntime.mockImplementation(async () => {
      const info = await fakeRuntime(runtimeName, execute).describe()
      return { ...info, capabilities: { ...info.capabilities, tools: true } }
    })
    const { result } = await run({
      agents: [worker({ id: "first", tools: [] }), worker({ tools: ["Read"] })],
    })
    expect(result.success).toBe(true)
    expect(describeRuntime).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("does not reuse capabilities across resolved commands", async () => {
    describeRuntime.mockImplementation(async ({ command } = {}) => {
      const info = await fakeRuntime(runtimeName, execute).describe()
      return { ...info, capabilities: { ...info.capabilities, tools: command === "supported" } }
    })
    const { result } = await run({
      agents: [
        worker({ id: "first", command: "supported", tools: [] }),
        worker({ command: "unsupported", tools: [] }),
      ],
    })
    expect(result.success).toBe(false)
    expect(describeRuntime).toHaveBeenCalledTimes(2)
    expect(execute).not.toHaveBeenCalled()
  })

  it("resolves default provider commands for capability queries", async () => {
    await run({ agents: [worker({ tools: [] })], defaults: { provider: "claude" } })
    expect(describeRuntime).toHaveBeenCalledWith({ command: "claude-agent-acp" })
  })

  it("does not apply a disabled leader's explicit tools", async () => {
    const { result } = await run({
      leader: agents.leader({ runtime: runtimeName, tools: [] }),
      useLeader: false,
    })
    expect(result.success).toBe(true)
  })

  it.each(["run", "preview"] as const)("preserves pre-abort for %s", async (method) => {
    const controller = new AbortController()
    controller.abort()
    const result = await new Orchestrator(config({ agents: [worker({ tools: [] })] }))[method]({
      signal: controller.signal,
    })
    expect(
      method === "run"
        ? "cancelled" in result && result.cancelled
        : "totalAgents" in result && result.totalAgents
    ).toBe(method === "run" ? true : 0)
    expect(describeRuntime).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    { method: "run", late: "resolve" },
    { method: "run", late: "reject" },
    { method: "preview", late: "resolve" },
    { method: "preview", late: "reject" },
  ] as const)(
    "cancels pending $method describe before its late $late",
    async ({ method, late }) => {
      const controller = new AbortController()
      const removeListener = vi.spyOn(controller.signal, "removeEventListener")
      let resolveProbe!: (info: RuntimeInfo) => void
      let rejectProbe!: (error: Error) => void
      const pending = new Promise<RuntimeInfo>((resolve, reject) => {
        resolveProbe = resolve
        rejectProbe = reject
      })
      describeRuntime.mockReturnValue(pending)
      const orchestrator = new Orchestrator(config({ agents: [worker({ tools: [] })] }))
      const events: MultiClawEvent[] = []
      orchestrator.eventBus.subscribe((event) => events.push(event))
      fs.writeFileSync(path.join(workDir, "task-plan.json"), "stale")
      const completion = orchestrator[method]({ signal: controller.signal })
      expect(describeRuntime).toHaveBeenCalledTimes(1)
      controller.abort()
      const result = await completion
      expect(
        method === "run"
          ? "cancelled" in result && result.cancelled
          : "totalAgents" in result && result.totalAgents
      ).toBe(method === "run" ? true : 0)
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
      expect(execute).not.toHaveBeenCalled()
      expect(events.map((event) => event.type)).toEqual(
        method === "run" ? ["orchestration:complete"] : []
      )
      expect(fs.readFileSync(path.join(workDir, "task-plan.json"), "utf8")).toBe("stale")
      if (late === "resolve") resolveProbe(await fakeRuntime(runtimeName, execute).describe())
      else rejectProbe(new Error("late probe rejection"))
      await Promise.resolve()
      await Promise.resolve()
      expect(execute).not.toHaveBeenCalled()
    },
    1000
  )

  it.each(["run", "preview"] as const)("preserves abort during describe for %s", async (method) => {
    const controller = new AbortController()
    describeRuntime.mockImplementation(async () => {
      controller.abort()
      return fakeRuntime(runtimeName, execute).describe()
    })
    const result = await new Orchestrator(config({ agents: [worker({ tools: [] })] }))[method]({
      signal: controller.signal,
    })
    expect(
      method === "run"
        ? "cancelled" in result && result.cancelled
        : "totalAgents" in result && result.totalAgents
    ).toBe(method === "run" ? true : 0)
    expect(execute).not.toHaveBeenCalled()
  })
})
