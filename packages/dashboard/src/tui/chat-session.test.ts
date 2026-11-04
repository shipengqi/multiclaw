import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  type AgentRuntime,
  type AgentTask,
  abortError,
  COORDINATOR_ID,
  type RuntimeSession,
  runtimeRegistry,
} from "@multiclawcli/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SessionRuntime } from "./chat-session"
import { createSession, listSessions } from "./sessions"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const original = runtimeRegistry.get("acp")
let dir: string
const owners: SessionRuntime[] = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-runtime-"))
})
afterEach(async () => {
  for (const r of owners.splice(0)) await r.close()
  runtimeRegistry.register(original)
  fs.rmSync(dir, { recursive: true, force: true })
})
function config() {
  return {
    name: "Chats",
    workDir: dir,
    agents: [
      { id: "dev", name: "Developer", systemPrompt: "system", taskPrompt: "Implement" },
      {
        id: "tester",
        name: "Tester",
        systemPrompt: "system",
        taskPrompt: "Verify",
        dependsOn: ["dev"],
      },
    ],
  }
}
function create() {
  const r = new SessionRuntime(config())
  owners.push(r)
  return r
}
function until(r: SessionRuntime, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error("Timed out waiting for chat state"))
    }, 2000)
    const off = r.subscribe(() => {
      if (predicate()) {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  })
}
function install(
  worker: (task: AgentTask) => Promise<string>,
  capable = false,
  beforeChat?: () => Promise<void>
) {
  const sessions: string[] = []
  let serial = 0
  const execute = async (task: AgentTask) => {
    if (task.signal?.aborted) throw abortError()
    let output = ""
    if (task.agentId === COORDINATOR_ID) {
      if (task.prompt.includes("Phase: summary")) output = "Completed work and verification."
      else if (task.prompt.includes("Phase: chat")) {
        await beforeChat?.()
        const facts = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf("\n") + 1))
        const text = facts.message as string
        output = JSON.stringify(
          text === "progress?"
            ? { mode: "reply", message: "Developer is still working." }
            : text === "another task"
              ? {
                  mode: "queue",
                  message: "Queued another task",
                  requirement: "Independent new work",
                }
              : text === "stop and replace"
                ? { mode: "replace", message: "Replacing work", requirement: "Replacement task" }
                : {
                    mode: "supplement",
                    message: "Sending pagination requirement",
                    workId: facts.work.id,
                    text,
                    agents: ["dev"],
                  }
        )
      } else {
        const facts = JSON.parse(task.prompt.slice(task.prompt.lastIndexOf("\n") + 1))
        output = JSON.stringify(
          facts.requirement === "hello"
            ? { mode: "reply", message: "Hello!" }
            : { mode: "run", run: ["dev", "tester"], requirement: facts.requirement }
        )
      }
    } else {
      const done = worker(task)
      output = await (task.signal
        ? Promise.race([
            done,
            new Promise<never>((_, reject) =>
              task.signal?.addEventListener("abort", () => reject(abortError()), { once: true })
            ),
          ])
        : done)
    }
    return { output, exitCode: 0 }
  }
  const r: AgentRuntime = {
    name: "acp",
    execute,
    describe: async () => ({
      name: "acp",
      available: true,
      capabilities: {
        streaming: true,
        sessions: true,
        resume: false,
        permissions: true,
        models: false,
        images: false,
        usage: false,
        cost: false,
        sandbox: false,
      },
    }),
    openSession: async (task) => {
      let state: RuntimeSession["state"] = "idle"
      const id = "binding-" + ++serial
      sessions.push(id + ":" + task.agentId)
      return {
        sessionId: id,
        get state() {
          return state
        },
        capabilities: { continuation: true, load: false, supplement: capable },
        async prompt(prompt, options) {
          state = "running"
          try {
            return await execute({
              ...task,
              ...options,
              timeout: options?.timeout ?? task.timeout ?? 1000,
              prompt,
            })
          } finally {
            state = "idle"
          }
        },
        async supplement() {
          return { status: state === "running" ? "injected" : "idle" }
        },
        async cancelTurn() {
          state = "idle"
        },
        async close() {
          state = "closed"
        },
      }
    },
  }
  runtimeRegistry.register(r)
  return sessions
}

describe("session-owned live conversation", () => {
  it("does not register empty chats on startup, new or close", async () => {
    const r = create()
    r.newChat()
    await r.close()
    expect(listSessions(dir)).toEqual([])
    expect(fs.existsSync(path.join(dir, ".multiclaw"))).toBe(false)
  })
  it("answers without running the team and persists only on first send", async () => {
    const calls: string[] = []
    install(async (task) => {
      calls.push(task.agentId)
      return "done"
    })
    const r = create()
    await r.submit("hello")
    await until(r, () => !r.current?.running)
    expect(calls).toEqual([])
    expect(r.current?.messages.map((m) => m.text)).toContain("Hello!")
    expect(listSessions(dir)).toHaveLength(1)
  })
  it("keeps responding while a developer is blocked and preserves the main input target", async () => {
    const finish = deferred()
    const calls: string[] = []
    install(async (task) => {
      calls.push(task.agentId)
      if (task.agentId === "dev") await finish.promise
      return "done"
    })
    const r = create()
    await r.submit("Build API")
    await until(r, () => calls.length > 0)
    r.updateView({ type: "focus:set", agentId: "tester" })
    await r.submit("progress?")
    expect(r.current?.running).toBe(true)
    expect(r.current?.messages.map((m) => m.text)).toContain("Developer is still working.")
    expect(calls).toEqual(["dev"])
    finish.resolve()
    await until(r, () => !r.current?.running)
  })
  it.each([false, true])(
    "reworks supplements before testing (provider supports injection: %s)",
    async (capable) => {
      const finish = deferred()
      const calls: string[] = []
      install(async (task) => {
        calls.push(task.agentId)
        if (calls.length === 1) await finish.promise
        return "done"
      }, capable)
      const r = create()
      await r.submit("Build API")
      await until(r, () => calls.length > 0)
      await r.submit("Support pagination")
      expect(r.current?.supplements[0].deliveries[0].status).toBe(capable ? "delivered" : "pending")
      finish.resolve()
      await until(r, () => !r.current?.running)
      expect(calls).toEqual(["dev", "dev", "tester"])
      expect(r.current?.latestWork?.revision).toBe(2)
      expect(r.current?.lastResult?.success).toBe(true)
    }
  )
  it("runs same-named workers in two independent chats and routes completion to their owners", async () => {
    const finish = deferred()
    const calls: AgentTask[] = []
    const bindings = install(async (task) => {
      calls.push(task)
      await finish.promise
      return "done"
    })
    const r = create()
    await r.submit("First task")
    const first = r.selectedId!
    await until(r, () => calls.length === 1)
    r.newChat()
    await r.submit("Second task")
    const second = r.selectedId!
    await until(r, () => calls.length === 2)
    expect(first).not.toBe(second)
    expect(bindings.filter((b) => b.endsWith(":dev"))).toHaveLength(2)
    r.open(first)
    r.setDraft("first draft")
    r.open(second)
    r.setDraft("second draft")
    r.open(first)
    expect(r.draft).toBe("first draft")
    finish.resolve()
    await until(r, () => r.summaries.every((s) => s.status === "complete"))
    expect(r.current?.messages[0].text).toBe("First task")
    r.open(second)
    expect(r.current?.messages[0].text).toBe("Second task")
  })
  it("cancels only the selected session and closes every session on exit", async () => {
    const finish = deferred()
    let calls = 0
    install(async () => {
      calls++
      await finish.promise
      return "done"
    })
    const r = create()
    await r.submit("First task")
    const first = r.selectedId!
    await until(r, () => calls === 1)
    r.newChat()
    await r.submit("Second task")
    await until(r, () => calls === 2)
    const second = r.selectedId!
    r.open(first)
    r.cancel()
    await until(r, () => !r.current?.running)
    expect(r.current?.lastResult?.cancelled).toBe(true)
    r.open(second)
    expect(r.current?.running).toBe(true)
    await r.close()
    expect(r.current?.running).toBe(false)
  })
  it("queues independent work while maintaining live conversation", async () => {
    const finish = deferred()
    const calls: string[] = []
    install(async (task) => {
      calls.push(task.prompt)
      if (calls.length === 1) await finish.promise
      return "done"
    })
    const r = create()
    await r.submit("Build API")
    await until(r, () => calls.length > 0)
    await r.submit("another task")
    await r.submit("progress?")
    expect(r.current?.queue).toHaveLength(1)
    expect(r.current?.messages.map((m) => m.text)).toContain("Developer is still working.")
    finish.resolve()
    await until(r, () => !r.current?.running && r.current?.queue.length === 0)
    expect(calls).toHaveLength(4)
    expect(calls[2]).toContain("Independent new work")
  })
  it("background permissions stay attached to the original agent and do not consume chat text", async () => {
    let calls = 0
    let answer: string | undefined
    install(async (task) => {
      calls++
      if (calls === 1)
        answer = await task.onPermission?.(
          {
            runId: "run",
            agentId: "dev",
            seq: 1,
            requestId: "request",
            sessionId: "provider",
            toolCallId: "tool",
            title: "Edit API",
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
          task.signal!
        )
      return "done"
    })
    const r = create()
    await r.submit("Build API")
    const first = r.selectedId!
    await until(r, () => (r.current?.interactions.length ?? 0) > 0)
    const interaction = r.current!.interactions[0]
    r.newChat()
    expect(r.current).toBeUndefined()
    expect(r.summaries[0].status).toBe("needs input")
    r.open(first)
    await r.submit("progress?")
    expect(answer).toBeUndefined()
    if (interaction.kind !== "permission") throw new Error("wrong request")
    interaction.settle("allow")
    await until(r, () => !r.current?.running)
    expect(answer).toBe("allow")
  })
  it("stops current work before a replacement, ahead of previously queued work", async () => {
    const finish = deferred()
    const calls: string[] = []
    install(async (task) => {
      calls.push(task.prompt)
      if (calls.length === 1) await finish.promise
      return "done"
    })
    const r = create()
    await r.submit("Build API")
    await until(r, () => calls.length > 0)
    await r.submit("another task")
    await r.submit("stop and replace")
    await until(r, () => !r.current?.running && r.current?.queue.length === 0)
    expect(calls).toHaveLength(5)
    expect(calls[1]).toContain("Replacement task")
    expect(calls[3]).toContain("Independent new work")
    finish.resolve()
  })
  it("cancels work without waiting for a pending live coordinator answer", async () => {
    const finish = deferred(),
      chatStarted = deferred(),
      finishChat = deferred()
    let calls = 0
    install(
      async () => {
        calls++
        await finish.promise
        return "done"
      },
      false,
      async () => {
        chatStarted.resolve()
        await finishChat.promise
      }
    )
    const r = create()
    await r.submit("Build API")
    await until(r, () => calls > 0)
    const message = r.submit("Support pagination")
    await chatStarted.promise
    r.cancel()
    await until(r, () => !r.current?.running)
    expect(r.current?.lastResult?.cancelled).toBe(true)
    finishChat.resolve()
    await message
    expect(r.current?.supplements).toEqual([])
    expect(r.current?.messages.some((m) => m.text.includes("before this instruction"))).toBe(true)
    finish.resolve()
  })
  it("requires stopping active work before deletion and removes the selected idle chat", async () => {
    const finish = deferred()
    let calls = 0
    install(async () => {
      calls++
      await finish.promise
      return "done"
    })
    const r = create()
    await r.submit("Build API")
    await until(r, () => calls > 0)
    const id = r.selectedId!
    await expect(r.remove(id)).rejects.toThrow("Stop")
    r.cancel()
    await until(r, () => !r.current?.running)
    await r.remove(id)
    expect(r.current).toBeUndefined()
    expect(listSessions(dir)).toEqual([])
  })
  it("opens explicit IDs only and preserves unsupported old journals", async () => {
    const meta = createSession(dir)
    const target = path.join(dir, ".multiclaw", "sessions", meta.id, "session.json")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{"version":1,"inFlight":{"turn":1}}')
    const r = create()
    expect(() => r.open("missing")).toThrow("not found")
    r.open(meta.id)
    expect(r.current?.unsupported).toContain("Unsupported")
    expect(() => r.submit("hello")).toThrow("Unsupported")
    await r.close()
    expect(fs.readFileSync(target, "utf8")).toBe('{"version":1,"inFlight":{"turn":1}}')
  })
  it("restores supported messages and keeps pending work paused", async () => {
    install(async () => "done")
    const r = create()
    await r.submit("Build API")
    await until(r, () => !r.current?.running)
    const id = r.selectedId!
    await r.close()
    const next = create()
    next.open(id)
    expect(next.current?.messages.some((m) => m.kind === "summary")).toBe(true)
    expect(next.current?.running).toBe(false)
    expect(next.current?.paused).toBe(true)
  })
  it("retains damaged version-two journals without overwriting them", async () => {
    const meta = createSession(dir)
    const target = path.join(dir, ".multiclaw", "sessions", meta.id, "session.json")
    const data = JSON.stringify({
      version: 2,
      messages: [],
      queue: [],
      supplements: [],
      view: { agents: null },
    })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    const r = create()
    r.open(meta.id)
    expect(r.current?.unsupported).toContain("damaged")
    await r.close()
    expect(fs.readFileSync(target, "utf8")).toBe(data)
  })
})
