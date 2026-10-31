import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import {
  type AgentOutput,
  type AgentTask,
  type MultiClawConfig,
  type RuntimePermissionRequest,
  type RuntimeQuestionRequest,
  type RuntimeQuestionResponse,
  runtimeRegistry,
} from "@multiclawcli/core"
import { render } from "ink"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { stripAnsi } from "./state"

const RUNTIME = "tui-permission-queue"
let config: MultiClawConfig
let workDir: string
let respond: (task: AgentTask) => Promise<AgentOutput>
const mounted: Array<ReturnType<typeof render>> = []
const cleanups: Array<() => Promise<void>> = []

function request(agentId: string): RuntimePermissionRequest {
  return {
    agentId,
    runId: `run-${agentId}`,
    seq: 0,
    sessionId: `session-${agentId}`,
    requestId: `request-${agentId}`,
    toolCallId: `tool-${agentId}`,
    title: `Write ${agentId} file`,
    toolName: "Write",
    input: { path: `${agentId}.txt` },
    options: [
      { optionId: `${agentId}-once`, name: "Allow once", kind: "allow_once" },
      { optionId: `${agentId}-always`, name: "Allow always", kind: "allow_always" },
      { optionId: `${agentId}-reject`, name: "Reject once", kind: "reject_once" },
    ],
  }
}

function question(agentId: string): RuntimeQuestionRequest {
  return {
    agentId,
    runId: `run-${agentId}`,
    seq: 0,
    requestId: `question-${agentId}`,
    sessionId: `session-${agentId}`,
    message: "Choose a database",
    requestedSchema: {
      type: "object",
      required: ["database"],
      properties: {
        database: {
          type: "string",
          title: "Database",
          oneOf: [
            { const: "postgres", title: "Postgres", description: "Relational storage" },
            { const: "sqlite", title: "SQLite", description: "Local storage" },
          ],
        },
        notes: { type: "string", title: "Other" },
        features: {
          type: "array",
          title: "Features",
          items: { type: "string", enum: ["search", "cache"] },
        },
      },
    },
  }
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-permissions-"))
  config = {
    name: "approval-team",
    workDir,
    useLeader: false,
    maxConcurrency: 2,
    agents: ["alpha", "beta"].map((id) => ({
      id,
      name: id,
      runtime: RUNTIME,
      systemPrompt: "",
      taskPrompt: "{{requirement}}",
    })),
  }
  respond = async () => ({ output: "done", exitCode: 0 })
  runtimeRegistry.register({
    name: RUNTIME,
    describe: async () => ({
      name: RUNTIME,
      available: true,
      capabilities: {
        streaming: false,
        sessions: false,
        resume: false,
        permissions: true,
        tools: true,
        models: false,
        images: false,
        usage: false,
        cost: false,
        sandbox: false,
      },
    }),
    execute: (task) => respond(task),
  })
})

afterEach(async () => {
  for (const app of mounted.splice(0)) {
    app.unmount()
    await app.waitUntilExit()
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  fs.rmSync(workDir, { recursive: true, force: true })
})

async function mount(rows = 32) {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  let output = ""
  const stdout = {
    columns: 120,
    rows,
    isTTY: true,
    write(chunk: unknown, callback?: () => void) {
      output += String(chunk)
      callback?.()
      return true
    },
    on() {
      return stdout
    },
    off() {
      return stdout
    },
    removeListener() {
      return stdout
    },
  }
  let complete = 0
  const app = render(
    <App
      config={config}
      onCleanupReady={(cleanup) => cleanups.push(cleanup)}
      onTurnStart={(bus) => {
        bus.subscribe((event) => {
          if (event.type === "orchestration:complete") complete += 1
        })
      }}
    />,
    {
      stdin,
      stdout: stdout as unknown as NodeJS.WritableStream,
      interactive: false,
      patchConsole: false,
      exitOnCtrlC: false,
    }
  )
  mounted.push(app)
  await app.waitUntilRenderFlush()
  return {
    app,
    complete: () => complete,
    output: () => stripAnsi(output),
    async send(...keys: string[]) {
      for (const key of keys) {
        stdin.write(key)
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    },
  }
}

describe("App · structured question decisions", () => {
  it("keeps permission and question requests isolated and preserves JSON string whitespace", async () => {
    const decisions = new Map<string, unknown>()
    respond = async (task) => {
      const signal = task.signal ?? new AbortController().signal
      const decision =
        task.agentId === "alpha"
          ? await task.onPermission?.(request(task.agentId), signal)
          : await task.onQuestion?.(question(task.agentId), signal)
      decisions.set(task.agentId, decision)
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r", "postgres", "\r", "/pause", "\r", "/answer postgres", "\r")
    expect(decisions.size).toBe(0)
    await ui.send(
      "/approve q1 1",
      "\r",
      "/respond p1 {}",
      "\r",
      "/respond q1 invalid",
      "\r",
      '/respond q1 {"database":{}}',
      "\r"
    )
    await ui.send(
      "/respond q1 {}",
      "\r",
      '/respond q1 {"database":"unknown"}',
      "\r",
      '/respond q1 {"database":"postgres","unknown":"field"}',
      "\r"
    )
    expect(decisions.size).toBe(0)
    const content = {
      database: "postgres",
      notes: "keep  two spaces",
      features: ["search", "cache"],
    }
    await ui.send(`/respond q1 ${JSON.stringify(content)}`, "\r")
    await vi.waitFor(() => expect(decisions.get("beta")).toEqual({ action: "accept", content }))
    expect(decisions.has("alpha")).toBe(false)
    await ui.send('/respond q1 {"database":"sqlite"}', "\r", "/approve p1 1", "\r")
    await vi.waitFor(() => expect(ui.complete()).toBe(1))
    expect(decisions.get("alpha")).toBe("alpha-once")
  })

  it("renders the question as a form: fields, required marker and choices", async () => {
    const answers: RuntimeQuestionResponse[] = []
    respond = async (task) => {
      const answer = await task.onQuestion?.(
        question(task.agentId),
        task.signal ?? new AbortController().signal
      )
      if (answer) answers.push(answer)
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r")
    await ui.app.waitUntilRenderFlush()
    ui.app.unmount()
    await ui.app.waitUntilExit()
    expect(ui.output()).toContain("question · alpha · 2 waiting")
    expect(ui.output()).toContain("Choose a database")
    // Required fields carry a marker, and the focused one names its choices
    // inline instead of describing a schema the user would have to encode.
    expect(ui.output()).toContain("Database *")
    expect(ui.output()).toContain("Other")
    expect(ui.output()).toContain("Features")
    expect(ui.output()).toContain("1 Postgres — Relational storage")
    expect(ui.output()).toContain("tab next")
    await vi.waitFor(() => expect(answers).toEqual([{ action: "cancel" }, { action: "cancel" }]))
  })

  it("answers a question field by field without hand-written JSON", async () => {
    const answers = new Map<string, RuntimeQuestionResponse>()
    respond = async (task) => {
      const answer = await task.onQuestion?.(
        question(task.agentId),
        task.signal ?? new AbortController().signal
      )
      if (answer) answers.set(task.agentId, answer)
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r")
    // database: pick the second choice with a digit, then enter to commit it.
    await ui.send("2", "\r")
    // notes: typed straight into the prompt, whitespace preserved.
    await ui.send("keep  two spaces", "\r")
    // features: toggle both entries, then enter on the last field submits.
    await ui.send(" ", "\u001b[B", " ", "\r")
    await vi.waitFor(() =>
      expect(answers.get("alpha")).toEqual({
        action: "accept",
        content: {
          database: "sqlite",
          notes: "keep  two spaces",
          features: ["search", "cache"],
        },
      })
    )
  })

  it("refuses to submit a form with a required field still empty", async () => {
    const answers = new Map<string, RuntimeQuestionResponse>()
    respond = async (task) => {
      const form = question(task.agentId)
      form.requestedSchema = {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", title: "Name", minLength: 2 } },
      }
      const answer = await task.onQuestion?.(form, task.signal ?? new AbortController().signal)
      if (answer) answers.set(task.agentId, answer)
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    // Enter walks the field without ever filling it, and the last `enter` has to
    // refuse rather than send an empty answer.
    await ui.send("write files", "\r", "\r", "\r")
    ui.app.unmount()
    await ui.app.waitUntilExit()
    expect([...answers.values()].filter((answer) => answer.action === "accept")).toEqual([])
    expect(ui.output()).toContain("Name still needs a value")
  })

  it("windows four required fields and shows the focused field's limits", async () => {
    config.agents = config.agents.slice(0, 1)
    respond = async (task) => {
      const form = question(task.agentId)
      form.requestedSchema = {
        type: "object",
        required: ["question_0", "question_1", "question_2", "question_3"],
        properties: Object.fromEntries(
          Array.from({ length: 4 }, (_, index) => [
            `question_${index}`,
            {
              type: "string",
              title: `Question ${index + 1}`,
              minLength: 1,
              maxLength: 30,
              oneOf: Array.from({ length: 4 }, (_, option) => ({
                const: `choice-${index}-${option}`,
                title: `Choice ${index + 1}.${option + 1}`,
              })),
            },
          ])
        ),
      }
      await task.onQuestion?.(form, task.signal ?? new AbortController().signal)
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount(18)
    await ui.send("write files", "\r", "\t", "\t", "\t")
    await ui.app.waitUntilRenderFlush()
    ui.app.unmount()
    await ui.app.waitUntilExit()
    expect(ui.output()).toContain("Question 4 *")
    expect(ui.output()).toContain("1 Choice 4.1")
    expect(ui.output()).toContain("1–30 chars")
  })

  it("distinguishes skip and dismiss and rejects stale ids", async () => {
    const decisions = new Map<string, RuntimeQuestionResponse>()
    respond = async (task) => {
      const answer = await task.onQuestion?.(
        question(task.agentId),
        task.signal ?? new AbortController().signal
      )
      if (answer) decisions.set(task.agentId, answer)
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r", "/skip q2", "\r")
    expect(decisions.get("beta")).toEqual({ action: "decline" })
    expect(decisions.has("alpha")).toBe(false)
    await ui.send("/dismiss q2", "\r")
    expect(decisions.has("alpha")).toBe(false)
    await ui.send("/dismiss q1", "\r")
    await vi.waitFor(() => expect(decisions.get("alpha")).toEqual({ action: "cancel" }))
  })

  it("removes only an aborted question and drains its peer on cancel", async () => {
    const signals = new Map<string, AbortController>()
    const decisions = new Map<string, RuntimeQuestionResponse>()
    respond = async (task) => {
      const controller = new AbortController()
      signals.set(task.agentId, controller)
      const answer = await task.onQuestion?.(question(task.agentId), controller.signal)
      if (answer) decisions.set(task.agentId, answer)
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r")
    signals.get("alpha")?.abort()
    await vi.waitFor(() => expect(decisions.get("alpha")).toEqual({ action: "cancel" }))
    expect(decisions.has("beta")).toBe(false)
    await ui.send('/respond q1 {"database":"postgres"}', "\r")
    expect(decisions.has("beta")).toBe(false)
    await ui.send("/cancel", "\r")
    await vi.waitFor(() => expect(decisions.get("beta")).toEqual({ action: "cancel" }))
  })

  it("preserves an explicitly supplied question callback", async () => {
    const callback = vi.fn(async (): Promise<RuntimeQuestionResponse> => ({ action: "decline" }))
    config.questions = { onRequest: callback }
    respond = async (task) => {
      expect(task.onQuestion).toBe(callback)
      await task.onQuestion?.(question(task.agentId), task.signal ?? new AbortController().signal)
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r")
    await vi.waitFor(() => expect(ui.complete()).toBe(1))
    expect(callback).toHaveBeenCalledTimes(2)
  })
})

describe("App · explicit permission decisions", () => {
  it("renders the request on screen as a menu, with each offered option", async () => {
    const decisions: Array<string | undefined> = []
    respond = async (task) => {
      decisions.push(
        await task.onPermission?.(
          request(task.agentId),
          task.signal ?? new AbortController().signal
        )
      )
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r")
    await ui.app.waitUntilRenderFlush()
    ui.app.unmount()
    await ui.app.waitUntilExit()
    expect(ui.output()).toContain("permission · alpha · Write · 2 waiting")
    expect(ui.output()).toContain("Write alpha file")
    expect(ui.output()).toContain("1  Allow once")
    expect(ui.output()).toContain("2  Allow always  · this session")
    expect(ui.output()).toContain("3  Reject once")
    // The request behind this one is named, not merely counted.
    expect(ui.output()).toContain("also waiting · beta (Write)")
    expect(ui.output()).toContain("↑↓ or 1-9 choose · enter confirm · esc to type instead")
    await vi.waitFor(() => expect(decisions).toEqual([undefined, undefined]))
  })

  it("commits the highlighted option from the bar, without an id or a command", async () => {
    const decisions = new Map<string, string | undefined>()
    respond = async (task) => {
      decisions.set(
        task.agentId,
        await task.onPermission?.(
          request(task.agentId),
          task.signal ?? new AbortController().signal
        )
      )
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r")
    // Enter alone must not grant anything: nothing is highlighted yet.
    await ui.send("\r")
    expect(decisions.size).toBe(0)
    // `2` highlights, `enter` commits — two keystrokes for the always option.
    await ui.send("2", "\r")
    await vi.waitFor(() => expect(decisions.get("alpha")).toBe("alpha-always"))
    expect(decisions.has("beta")).toBe(false)
    // The next request becomes the front one and starts with nothing highlighted,
    // so the same keys reach it — but a bare `down` lands on the first option,
    // which is why the test picks the number explicitly.
    await ui.send("2", "\r")
    await vi.waitFor(() => expect(ui.complete()).toBe(1))
    expect(decisions.get("beta")).toBe("beta-always")
  })

  it("hands the keyboard back on esc so a follow-up can still be typed", async () => {
    const decisions = new Map<string, string | undefined>()
    respond = async (task) => {
      decisions.set(
        task.agentId,
        await task.onPermission?.(
          request(task.agentId),
          task.signal ?? new AbortController().signal
        )
      )
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r")
    await ui.send("\u001b")
    // A lone escape is held by the key parser in case it starts a sequence, so
    // the test has to let that window close before typing.
    await new Promise((resolve) => setTimeout(resolve, 200))
    // The digits are no longer intercepted, so this is ordinary queued text —
    // including the leading `1`, which the bar would otherwise have eaten.
    await ui.send("1. also check the docs", "\r", "/pause", "\r")
    expect(decisions.size).toBe(0)
    // The request is still reachable by command, with the id omitted.
    await ui.send("/deny", "\r")
    await vi.waitFor(() => expect(decisions.get("alpha")).toBeUndefined())
    expect(decisions.has("beta")).toBe(false)
    ui.app.unmount()
    await ui.app.waitUntilExit()
    expect(ui.output()).toContain("1. also check the docs")
  })

  it("isolates concurrent requests and never approves from typed text", async () => {
    const decisions = new Map<string, string | undefined>()
    const tasks: AgentTask[] = []
    const suppliedHandler = vi.fn(async () => "unexpected")
    config.permissions = { mode: "ask", onRequest: suppliedHandler }
    respond = async (task) => {
      tasks.push(task)
      const decision = await task.onPermission?.(
        request(task.agentId),
        task.signal ?? new AbortController().signal
      )
      decisions.set(task.agentId, decision)
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r")
    await vi.waitFor(() => expect(tasks).toHaveLength(2))
    expect(tasks.every((task) => task.permissionMode === "ask")).toBe(true)
    // A typed sentence is never a decision, whatever it starts with.
    await ui.send("yes", "\r", "/pause", "\r")
    expect(decisions.size).toBe(0)
    expect(suppliedHandler).not.toHaveBeenCalled()
    await ui.send("/approve request-alpha 0", "\r", "/approve missing 1", "\r")
    expect(decisions.size).toBe(0)
    await ui.send("/approve request-beta 2", "\r")
    await vi.waitFor(() => expect(decisions.get("beta")).toBe("beta-always"))
    expect(decisions.has("alpha")).toBe(false)
    await ui.send("/approve request-beta 1", "\r")
    expect(decisions.has("alpha")).toBe(false)
    await ui.send("/approve request-alpha 1", "\r")
    await vi.waitFor(() => expect(ui.complete()).toBe(1))
    expect(decisions.get("alpha")).toBe("alpha-once")
    expect(tasks).toHaveLength(2)
  })

  it("denies only the named request and cancels all remaining approvals on cancel", async () => {
    const decisions = new Map<string, string | undefined>()
    respond = async (task) => {
      decisions.set(
        task.agentId,
        await task.onPermission?.(
          request(task.agentId),
          task.signal ?? new AbortController().signal
        )
      )
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r", "/deny p2", "\r")
    await vi.waitFor(() => expect(decisions.has("beta")).toBe(true))
    expect(decisions.get("beta")).toBeUndefined()
    expect(decisions.has("alpha")).toBe(false)
    await ui.send("/cancel", "\r")
    await vi.waitFor(() => expect(decisions.has("alpha")).toBe(true))
    expect(decisions.get("alpha")).toBeUndefined()
    await vi.waitFor(() => expect(ui.complete()).toBe(1))
    await ui.send("/approve p1 1", "\r")
    ui.app.unmount()
    await ui.app.waitUntilExit()
    expect(ui.output()).toContain("unknown or stale permission request: p1")
    expect(ui.output()).not.toContain("PERMISSION")
  })

  it("removes an individually aborted request without settling its concurrent peer", async () => {
    const signals = new Map<string, AbortController>()
    const decisions = new Map<string, string | undefined>()
    respond = async (task) => {
      const controller = new AbortController()
      signals.set(task.agentId, controller)
      decisions.set(
        task.agentId,
        await task.onPermission?.(request(task.agentId), controller.signal)
      )
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r")
    signals.get("alpha")?.abort()
    await vi.waitFor(() => expect(decisions.has("alpha")).toBe(true))
    expect(decisions.has("beta")).toBe(false)
    await ui.send("/approve p1 1", "\r")
    expect(decisions.has("beta")).toBe(false)
    await ui.send("/approve p2 3", "\r")
    await vi.waitFor(() => expect(decisions.get("beta")).toBe("beta-reject"))
  })

  it("settles pending approvals and releases abort listeners before quitting", async () => {
    const decisions: Array<string | undefined> = []
    const removals: Array<ReturnType<typeof vi.spyOn>> = []
    respond = async (task) => {
      const controller = new AbortController()
      removals.push(vi.spyOn(controller.signal, "removeEventListener"))
      decisions.push(await task.onPermission?.(request(task.agentId), controller.signal))
      return { output: "done", exitCode: 0 }
    }
    const ui = await mount()
    await ui.send("write files", "\r", "/quit", "\r")
    await ui.app.waitUntilExit()
    expect(decisions).toEqual([undefined, undefined])
    expect(removals).toHaveLength(2)
    for (const remove of removals) {
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    }
    expect(ui.output()).not.toContain("PERMISSION")
  })

  it.each(["auto", "deny"] as const)(
    "preserves explicit %s mode and its caller callback",
    async (mode) => {
      const callback = vi.fn(async () => undefined)
      config.permissions = { mode, onRequest: callback }
      const tasks: AgentTask[] = []
      respond = async (task) => {
        tasks.push(task)
        return { output: "done", exitCode: 0 }
      }
      const ui = await mount()
      await ui.send("write files", "\r")
      await vi.waitFor(() => expect(ui.complete()).toBe(1))
      expect(
        tasks.every((task) => task.permissionMode === mode && task.onPermission === callback)
      ).toBe(true)
    }
  )
})
