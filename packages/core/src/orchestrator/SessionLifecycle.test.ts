import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { EventBus } from "../event/EventBus"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent, makeSessionRecord } from "../testing/helpers"
import {
  type TestConfig as MultiClawConfig,
  TestOrchestrator as Orchestrator,
} from "../testing/orchestration"
import type { AgentTask, RuntimeSession, RuntimeSessionOptions } from "../types/runtime"
import type { SessionEvent, SessionRecord } from "../types/session"
import { sessionCompatibilityKey } from "../utils/session"
import { AgentRunner } from "./AgentRunner"
import { AgentSessionManager } from "./AgentSessionManager"
import { ContextManager } from "./ContextManager"

const task = (changes: Partial<AgentTask> = {}): AgentTask => ({
  agentId: "dev",
  workId: "work-1",
  provider: "custom",
  command: "bridge",
  args: [],
  model: "model",
  systemPrompt: "system",
  prompt: "Complete goal",
  workDir: "/tmp",
  timeout: 1000,
  ...changes,
})
function live(
  id = "session-1",
  changes: {
    load?: boolean
    continuation?: boolean
    failTurn?: boolean
    failClose?: boolean
    fatal?: boolean
  } = {}
) {
  let state: RuntimeSession["state"] = "idle"
  let failTurn = changes.failTurn
  const prompt = vi.fn(async (text: string) => {
    state = "running"
    if (failTurn) {
      failTurn = false
      state = changes.fatal ? "closed" : "idle"
      throw new Error("Turn failed")
    }
    state = "idle"
    return { output: text, exitCode: 0, sessionId: id }
  })
  const close = vi.fn(async () => {
    state = "closed"
    if (changes.failClose) throw new Error("Cleanup was not acknowledged")
  })
  return {
    sessionId: id,
    get state() {
      return state
    },
    capabilities: {
      continuation: changes.continuation ?? true,
      load: changes.load ?? true,
      supplement: false,
    },
    prompt,
    close,
    cancelTurn: async () => {},
  }
}
function setup(open: (options: RuntimeSessionOptions) => Promise<RuntimeSession>) {
  const runtime = {
    ...fakeRuntime("lifecycle", async () => {
      throw new Error("Unexpected execute")
    }),
    openSession: vi.fn(open),
  }
  const manager = new AgentSessionManager()
  const events: SessionEvent[] = []
  manager.subscribe((event) => events.push(event))
  return { runtime, manager, events }
}
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

it("records creation before prompting, and reuses a compatible live binding", async () => {
  const session = live()
  const { runtime, manager, events } = setup(async () => session)
  session.prompt.mockImplementationOnce(async () => {
    expect(events.map((event) => event.action)).toContain("created")
    expect(events.find((event) => event.action === "created")?.record.sessionId).toBe("session-1")
    return { output: "done", exitCode: 0, sessionId: "session-1" }
  })
  await manager.execute(runtime, task(), { executionId: "first" })
  await manager.execute(runtime, task(), { executionId: "second" })
  expect(runtime.openSession).toHaveBeenCalledTimes(1)
  expect(events.find((event) => event.action === "reused")?.executionId).toBe("second")
  const created = events.find((event) => event.action === "created")?.record
  const reused = events.find((event) => event.action === "reused")?.record
  expect(reused?.bindingId).toBe(created?.bindingId)
  expect(created?.action).toBe("created")
  await manager.close()
  expect(events[events.length - 1]?.action).toBe("closed")
  expect(events[events.length - 1]?.record.state).toBe("closed")
})

it("preserves a failed turn's Session and lets explicit retry reuse it", async () => {
  const session = live("session-1", { failTurn: true })
  const { runtime, manager, events } = setup(async () => session)
  await expect(manager.execute(runtime, task())).rejects.toThrow("Turn failed")
  const failed = events[events.length - 1]!.record
  expect(failed.state).toBe("idle")
  expect(failed.sessionId).toBe("session-1")
  await manager.execute(runtime, task(), { session: failed, strict: true })
  expect(runtime.openSession).toHaveBeenCalledTimes(1)
  expect(events.find((event) => event.action === "reused")?.record.failure).toBeUndefined()
  await manager.close()
})

it("loads a persisted compatible Session and reuses it on the following turn", async () => {
  const { runtime, manager, events } = setup(async (options) => live(options.sessionId))
  const record = makeSessionRecord(
    { agentId: "dev", workId: "work-1", runtime: runtime.name },
    task()
  )
  await manager.execute(runtime, task(), { session: record })
  expect(runtime.openSession.mock.calls[0][0].sessionId).toBe("session-1")
  const loaded = events.find((event) => event.action === "loaded")!.record
  await manager.execute(runtime, task(), { session: loaded })
  expect(runtime.openSession).toHaveBeenCalledTimes(1)
  expect(events.filter((event) => event.action === "loaded")).toHaveLength(1)
  await manager.close()
})

it.each(["model", "provider", "command", "systemPrompt", "workDir"] as const)(
  "uses recovery context when automatic continuation has changed %s",
  async (field) => {
    const { runtime, manager } = setup(async () => live("new-session"))
    const record = makeSessionRecord(
      { agentId: "dev", workId: "work-1", runtime: runtime.name },
      task()
    )
    await manager.execute(runtime, task({ [field]: "changed" }), { session: record })
    expect(runtime.openSession.mock.calls[0][0].sessionId).toBeUndefined()
    const output = await manager.execute(runtime, task({ [field]: "changed" }))
    expect(output.output).toContain("matching live executor conversation")
    await manager.close()
  }
)

it("rejects incompatible explicit resume without starting a worker", async () => {
  const { runtime, manager, events } = setup(async () => live())
  const record = makeSessionRecord(
    { agentId: "dev", workId: "work-1", runtime: runtime.name },
    task()
  )
  await expect(
    manager.execute(runtime, task({ model: "different" }), { session: record, strict: true })
  ).rejects.toThrow("incompatible")
  expect(runtime.openSession).not.toHaveBeenCalled()
  expect(events[events.length - 1]?.record.failure?.code).toBe("incompatible")
  await manager.close()
})

it("does not treat continuation support as load support", async () => {
  const { runtime, manager, events } = setup(async () => live("new-session", { load: false }))
  const record = makeSessionRecord(
    {
      agentId: "dev",
      workId: "work-1",
      runtime: runtime.name,
      capabilities: { continuation: true, load: false, supplement: false },
    },
    task()
  )
  const output = await manager.execute(runtime, task(), { session: record })
  expect(output.output).toContain("no old conversation was restored")
  expect(events.find((event) => event.action === "created")?.record.reason).toContain(
    "does not support loading"
  )
  await manager.close()
})

it("reports load failure without fabricating an established Session ID or starting fresh", async () => {
  const { runtime, manager, events } = setup(async () => {
    throw new Error("Session not found")
  })
  const record = makeSessionRecord(
    { agentId: "dev", workId: "work-1", runtime: runtime.name },
    task()
  )
  await expect(manager.execute(runtime, task(), { session: record })).rejects.toThrow(
    "Session not found"
  )
  expect(runtime.openSession).toHaveBeenCalledTimes(1)
  expect(events[events.length - 1]?.action).toBe("load_failed")
  expect(events[events.length - 1]?.record.sessionId).toBeUndefined()
  expect(events[events.length - 1]?.requestedSessionId).toBe("session-1")
  await manager.close()
})

it("rejects a provider that returns a different ID during load", async () => {
  const session = live("wrong-session")
  const { runtime, manager, events } = setup(async () => session)
  const record = makeSessionRecord(
    { agentId: "dev", workId: "work-1", runtime: runtime.name },
    task()
  )
  await expect(manager.execute(runtime, task(), { session: record })).rejects.toThrow(
    "not restored"
  )
  expect(events.some((event) => event.action === "loaded")).toBe(false)
  expect(events[events.length - 1]?.record.sessionId).toBeUndefined()
  expect(session.close).toHaveBeenCalledTimes(1)
  await manager.close()
})

it("keeps cleanup failure distinct and refuses a replacement executor", async () => {
  const { runtime, manager, events } = setup(async () => live("session-1", { failClose: true }))
  await manager.execute(runtime, task())
  await expect(manager.execute(runtime, task({ workId: "new-work" }))).rejects.toThrow("Cleanup")
  expect(events[events.length - 1]?.action).toBe("cleanup_failed")
  expect(events[events.length - 1]?.record.state).toBe("unknown")
  expect(events.some((event) => event.action === "closed")).toBe(false)
  expect(runtime.openSession).toHaveBeenCalledTimes(1)
  await expect(manager.close()).rejects.toThrow("Cleanup")
})

it("preserves Session facts on an AgentRunner error result", async () => {
  const session = live("session-1", { failTurn: true })
  const { runtime, manager } = setup(async () => session)
  runtimeRegistry.register(runtime)
  const bus = new EventBus()
  const runner = new AgentRunner(
    bus,
    new ContextManager({ requirement: "Goal", workId: "work-1" }),
    "/tmp",
    { name: "test", workDir: "/tmp", agents: [] },
    manager
  )
  const result = await runner.run(makeAgent({ id: "dev", runtime: runtime.name }))
  expect(result.status).toBe("failed")
  expect(result.session?.sessionId).toBe("session-1")
  expect(result.session?.state).toBe("idle")
  expect(result.session?.failure?.code).toBe("turn_failed")
  await manager.close()
})

it("updates the work binding before a worker returns and closes CLI-owned sessions before completion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-work-"))
  dirs.push(dir)
  let resolve!: () => void
  const wait = new Promise<void>((done) => {
    resolve = done
  })
  let started!: () => void
  const ready = new Promise<void>((done) => {
    started = done
  })
  const session = live()
  session.prompt.mockImplementationOnce(async () => {
    started()
    await wait
    return { output: "done", exitCode: 0, sessionId: "session-1" }
  })
  runtimeRegistry.register({
    ...fakeRuntime("work-binding", async () => {
      throw new Error("Unexpected execute")
    }),
    openSession: async () => session,
  })
  const orchestrator = new Orchestrator({
    name: "test",
    workDir: dir,
    agents: [makeAgent({ id: "dev", runtime: "work-binding" })],
    context: { requirement: "Build API" },
  })
  let saved: SessionRecord | undefined
  orchestrator.eventBus.subscribe((event) => {
    if (event.type === "orchestration:route") saved = event.payload.work?.agents[0]?.session
  })
  const running = orchestrator.run()
  await ready
  expect(saved?.sessionId).toBe("session-1")
  expect(saved?.workId).toBeDefined()
  resolve()
  const result = await running
  expect(result.work?.agents[0].session?.state).toBe("closed")
  expect(result.agentResults[0].session?.state).toBe("closed")
  expect(session.close).toHaveBeenCalledTimes(1)
})

it("does not store prompt or command secrets in compatibility metadata", () => {
  const key = sessionCompatibilityKey(
    { name: "test" },
    task({ systemPrompt: "private-system", args: ["private-token"] })
  )
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(key).not.toContain("private")
})

it("records execute-only IDs as unmanaged facts and never claims conversation restoration", async () => {
  const manager = new AgentSessionManager()
  const events: SessionEvent[] = []
  manager.subscribe((event) => events.push(event))
  const runtime = fakeRuntime("one-shot", async () => ({
    output: "done",
    exitCode: 0,
    sessionId: "reported",
  }))
  await manager.execute(runtime, task())
  expect(events[events.length - 1]?.record).toMatchObject({
    state: "unknown",
    sessionId: "reported",
    capabilities: { load: false, continuation: false },
  })
  expect(events.some((event) => event.action === "loaded" || event.action === "reused")).toBe(false)
  await expect(
    manager.execute(runtime, task(), { session: events[events.length - 1]!.record, strict: true })
  ).rejects.toThrow("does not support loading")
  await manager.close()
})

it("marks mismatched-load cleanup failure unknown and blocks replacement", async () => {
  const { runtime, manager, events } = setup(async () => live("wrong", { failClose: true }))
  const record = makeSessionRecord(
    { agentId: "dev", workId: "work-1", runtime: runtime.name },
    task()
  )
  await expect(manager.execute(runtime, task(), { session: record })).rejects.toThrow("Cleanup")
  expect(events[events.length - 1]?.record).toMatchObject({
    state: "unknown",
    failure: { code: "cleanup_failed" },
  })
  expect(events.some((event) => event.action === "closed")).toBe(false)
  await expect(manager.execute(runtime, task())).rejects.toThrow("Cleanup")
  expect(runtime.openSession).toHaveBeenCalledTimes(1)
  await expect(manager.close()).rejects.toThrow("Cleanup")
})

it("previews new work and recorded restoration without opening, resetting or closing workers", async () => {
  const session = live()
  const { runtime, manager, events } = setup(async () => session)
  runtimeRegistry.register(runtime)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-preview-"))
  dirs.push(dir)
  const config = {
    name: "preview",
    workDir: dir,
    agents: [makeAgent({ id: "dev", runtime: runtime.name })],
    context: { requirement: "Build API" },
  }
  const preview = await new Orchestrator(config, manager).preview()
  expect(preview.sessions?.[0].action).toBe("create")
  expect(runtime.openSession).not.toHaveBeenCalled()
  expect(events).toEqual([])
  await manager.execute(runtime, task())
  const record = events.find((event) => event.action === "created")!.record
  const before = events.length
  expect(manager.inspect(runtime, task(), { session: record }).action).toBe("reuse")
  expect(manager.inspect(runtime, task({ workId: "new" })).action).toBe("create")
  expect(
    manager.inspect(runtime, task({ model: "changed" }), { session: record, strict: true }).action
  ).toBe("unavailable")
  expect(events).toHaveLength(before)
  expect(session.close).not.toHaveBeenCalled()
  const restarted = new AgentSessionManager()
  expect(
    restarted.inspect(runtime, task(), { session: { ...record, state: "unknown" } })
  ).toMatchObject({ action: "load", reason: expect.stringContaining("not yet confirmed") })
  expect(runtime.openSession).toHaveBeenCalledTimes(1)
  await restarted.close()
  await manager.close()
})

it("retains the established load candidate after a failed resume so explicit retry does not start fresh", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-load-retry-"))
  dirs.push(dir)
  let failLoad = false
  const open = vi.fn(async (options: RuntimeSessionOptions) => {
    if (failLoad) throw new Error("Provider temporarily unavailable")
    return live(options.sessionId)
  })
  runtimeRegistry.register({
    ...fakeRuntime("load-retry", async () => {
      throw new Error("Unexpected execute")
    }),
    openSession: open,
  })
  const config = {
    name: "retry",
    workDir: dir,
    agents: [makeAgent({ id: "dev", runtime: "load-retry" })],
    context: { requirement: "Build API" },
  }
  const first = await new Orchestrator(config).run()
  failLoad = true
  const failed = await new Orchestrator({
    ...config,
    latestWork: first.work,
    resume: { agents: ["dev"] },
  }).run()
  expect(failed.success).toBe(false)
  expect(failed.agentResults[0].session?.sessionId).toBeUndefined()
  expect(failed.work?.agents[0].session?.sessionId).toBe("session-1")
  failLoad = false
  const retried = await new Orchestrator({
    ...config,
    latestWork: failed.work,
    resume: { agents: ["dev"] },
  }).run()
  expect(retried.success).toBe(true)
  expect(retried.agentResults[0].session?.action).toBe("loaded")
  expect(open.mock.calls.map(([options]) => options.sessionId)).toEqual([
    undefined,
    "session-1",
    "session-1",
  ])
})
