import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { Readable, Writable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { resolveExecutable } from "../providers/bridge"
import { specForCommand } from "../providers/catalog"
import type {
  AgentOutput,
  AgentTask,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeInfo,
  RuntimePromptOptions,
  RuntimeQuery,
  RuntimeSession,
  RuntimeSessionOptions,
} from "../types/runtime"
import { abortError } from "../utils/abort"
import { PermanentError } from "../utils/errors"
import { RuntimeBase } from "./RuntimeBase"

/** Model ids advertised by each command's session/new response. */
const discoveredModels = new Map<string, string[]>()

/** Grace period between SIGTERM and SIGKILL during process cleanup. */
export const KILL_ESCALATION_MS = 3000
const CANCEL_GRACE_MS = 2000
const CLEANUP_ACK_MS = 3000
const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_COMMAND = "opencode"
const DEFAULT_ARGS = ["acp"]

type RuntimeEventPayload = RuntimeEvent extends infer E
  ? E extends RuntimeEventBase
    ? Omit<E, keyof RuntimeEventBase>
    : never
  : never

type AcpModule = typeof import("@agentclientprotocol/sdk")
type AcpSessionNotification = import("@agentclientprotocol/sdk").SessionNotification
type AcpPermissionRequest = import("@agentclientprotocol/sdk").RequestPermissionRequest
type AcpPermissionResponse = import("@agentclientprotocol/sdk").RequestPermissionResponse

const BASE_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  sessions: true,
  resume: true,
  permissions: true,
  tools: true,
  models: false,
  images: false,
  usage: true,
  cost: true,
  sandbox: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textOf(content: unknown): string | undefined {
  if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
    return content.text
  }
  return undefined
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  return JSON.stringify(value)
}

function mapStopReason(reason: string): "success" | "max_turns" | "cancelled" | "error" {
  switch (reason) {
    case "end_turn":
      return "success"
    case "cancelled":
      return "cancelled"
    case "max_tokens":
    case "max_turn_requests":
      return "max_turns"
    default:
      return "error"
  }
}

const KIND_TO_TOOLS: Record<string, string[]> = {
  read: ["Read"],
  edit: ["Edit", "Write"],
  execute: ["Bash"],
  search: ["Grep", "Glob"],
  fetch: ["WebFetch"],
}

interface RejectedPermission {
  toolCallId: string
  name?: string
  kind?: string
  title?: string
}

function toolPermitted(params: AcpPermissionRequest, tools: string[]): boolean {
  const allowed = new Set(tools.map((tool) => tool.toLowerCase()))
  const name = params.toolCall.name ?? undefined
  return name !== undefined
    ? allowed.has(name.toLowerCase())
    : (KIND_TO_TOOLS[params.toolCall.kind ?? ""] ?? []).some((tool) =>
        allowed.has(tool.toLowerCase())
      )
}

/** Approve named tools only; unidentified requests fail closed. */
function decidePermission(
  params: AcpPermissionRequest,
  tools: string[],
  sessionId: string | undefined
): { response: AcpPermissionResponse; rejected?: RejectedPermission } {
  if (sessionId !== undefined && params.sessionId !== sessionId) {
    return { response: { outcome: { outcome: "cancelled" } } }
  }
  const name = params.toolCall.name ?? undefined
  const kind = params.toolCall.kind ?? undefined
  const approved = toolPermitted(params, tools)
  // Automatic policy never changes provider/session-wide permission settings.
  const option = params.options.find((o) =>
    approved ? o.kind === "allow_once" : o.kind === "reject_once"
  )
  const response: AcpPermissionResponse = option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } }
  if (approved) return { response }
  return {
    response,
    rejected: {
      toolCallId: params.toolCall.toolCallId,
      name,
      kind,
      title: params.toolCall.title ?? undefined,
    },
  }
}

const FORM_ANNOTATIONS = ["title", "description", "default", "_meta"]
function knownFormKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key) || FORM_ANNOTATIONS.includes(key))
}
function validFormBound(value: unknown, integer = false): boolean {
  return (
    value == null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (!integer || (Number.isInteger(value) && value >= 0)))
  )
}
function titledChoices(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (option) =>
        isRecord(option) && knownFormKeys(option, ["const"]) && typeof option.const === "string"
    )
  )
}

function supportedQuestionSchema(
  schema: unknown
): schema is import("@agentclientprotocol/sdk").ElicitationSchema {
  if (
    !isRecord(schema) ||
    (schema.type !== undefined && schema.type !== "object") ||
    !knownFormKeys(schema, ["type", "properties", "required"])
  )
    return false
  const properties = schema.properties ?? {}
  if (!isRecord(properties)) return false
  if (
    schema.required != null &&
    (!Array.isArray(schema.required) ||
      !schema.required.every(
        (key) =>
          typeof key === "string" && Object.getOwnPropertyDescriptor(properties, key) !== undefined
      ))
  )
    return false
  return Object.values(properties).every((field) => {
    if (!isRecord(field)) return false
    if (field.type === "string") {
      // Formats and regular expressions require a dedicated validator, not guessed semantics.
      return (
        knownFormKeys(field, ["type", "enum", "oneOf", "minLength", "maxLength"]) &&
        validFormBound(field.minLength, true) &&
        validFormBound(field.maxLength, true) &&
        (field.enum == null ||
          (Array.isArray(field.enum) &&
            field.enum.length > 0 &&
            field.enum.every((value) => typeof value === "string"))) &&
        (field.oneOf == null || titledChoices(field.oneOf))
      )
    }
    if (field.type === "boolean") return knownFormKeys(field, ["type"])
    if (field.type === "number" || field.type === "integer") {
      return (
        knownFormKeys(field, ["type", "minimum", "maximum"]) &&
        validFormBound(field.minimum) &&
        validFormBound(field.maximum)
      )
    }
    if (
      field.type !== "array" ||
      !isRecord(field.items) ||
      !knownFormKeys(field, ["type", "items", "minItems", "maxItems"]) ||
      !validFormBound(field.minItems, true) ||
      !validFormBound(field.maxItems, true)
    )
      return false
    return (
      (knownFormKeys(field.items, ["type", "enum"]) &&
        field.items.type === "string" &&
        Array.isArray(field.items.enum) &&
        field.items.enum.length > 0 &&
        field.items.enum.every((value) => typeof value === "string")) ||
      (knownFormKeys(field.items, ["anyOf"]) &&
        field.items.type === undefined &&
        titledChoices(field.items.anyOf))
    )
  })
}

export function validateRuntimeQuestionContent(
  schema: unknown,
  content: unknown
): content is Record<string, string | number | boolean | string[]> {
  if (!supportedQuestionSchema(schema) || !isRecord(content)) return false
  // Validate exactly the data that will survive JSON/structured-clone transport.
  if (
    Object.getOwnPropertySymbols(content).length > 0 ||
    Object.getOwnPropertyNames(content).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(content, key)
      return !descriptor?.enumerable || !("value" in descriptor)
    })
  )
    return false
  const properties = schema.properties ?? {}
  if (
    (schema.required ?? []).some(
      (key) => Object.getOwnPropertyDescriptor(content, key) === undefined
    )
  )
    return false
  return Object.entries(content).every(([key, value]) => {
    if (Object.getOwnPropertyDescriptor(properties, key) === undefined) return false
    const field = properties[key] as Record<string, unknown>
    if (field.type === "boolean") return typeof value === "boolean"
    if (field.type === "number" || field.type === "integer") {
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (field.type !== "integer" || Number.isInteger(value)) &&
        (typeof field.minimum !== "number" || value >= field.minimum) &&
        (typeof field.maximum !== "number" || value <= field.maximum)
      )
    }
    if (field.type === "string") {
      return (
        typeof value === "string" &&
        (typeof field.minLength !== "number" || [...value].length >= field.minLength) &&
        (typeof field.maxLength !== "number" || [...value].length <= field.maxLength) &&
        (!Array.isArray(field.enum) || field.enum.includes(value)) &&
        (!Array.isArray(field.oneOf) ||
          field.oneOf.some((option) => isRecord(option) && option.const === value))
      )
    }
    const items = field.items as Record<string, unknown>
    const choices = Array.isArray(items.enum)
      ? items.enum
      : (items.anyOf as Array<{ const: string }>).map((option) => option.const)
    return (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string" && choices.includes(item)) &&
      new Set(value).size === value.length &&
      (typeof field.minItems !== "number" || value.length >= field.minItems) &&
      (typeof field.maxItems !== "number" || value.length <= field.maxItems)
    )
  })
}

function withAuthHint(acp: AcpModule, err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err))
  if (error instanceof acp.RequestError && error.code === acp.RequestError.authRequired().code) {
    return new Error(`${error.message} — run \`claude\` to log in`)
  }
  return error
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function timeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483_647) {
    throw new PermanentError("ACP timeout must be a finite non-negative timer duration")
  }
  return timeout
}

interface ActiveTurn {
  runId: string
  seq: number
  options: RuntimePromptOptions
  output: string
  usage?: { contextTokens: number; contextSize: number }
  cost?: { amount: number; currency: string }
  error?: Error
  timer?: NodeJS.Timeout
  cancelTimer?: NodeJS.Timeout
  onAbort?: () => void
  promise: Promise<AgentOutput>
  resolve: (output: AgentOutput) => void
  reject: (error: Error) => void
  cancellation?: Promise<void>
  decisions: AbortController
}

export class AcpRuntime extends RuntimeBase {
  readonly name = "acp"

  async describe(options?: RuntimeQuery): Promise<RuntimeInfo> {
    // Do not import the SDK at CLI startup; availability is about the binary.
    const command = options?.command ?? DEFAULT_COMMAND
    return {
      name: this.name,
      available: resolveExecutable(command) !== null,
      capabilities: {
        ...BASE_CAPABILITIES,
        tools: specForCommand(command)?.tools ?? false,
        models: specForCommand(command)?.modelSelection === "config-option",
      },
    }
  }

  async execute(task: AgentTask): Promise<AgentOutput> {
    const { prompt, onEvent, signal, permissionMode, onPermission, onQuestion, ...options } = task
    // Startup cancellation must not remain a lifetime listener: once opened,
    // execute's signal cancels the turn through session/cancel before teardown.
    const startup = new AbortController()
    const forward = () => startup.abort()
    if (signal?.aborted) startup.abort()
    signal?.addEventListener("abort", forward, { once: true })
    let session: RuntimeSession
    try {
      session = await this.openSession({
        ...options,
        questionForms: Boolean(onQuestion),
        signal: startup.signal,
      })
    } finally {
      signal?.removeEventListener("abort", forward)
    }
    try {
      return await session.prompt(prompt, {
        signal,
        timeout: task.timeout,
        onEvent,
        permissionMode,
        onPermission,
        onQuestion,
      })
    } finally {
      await session.close()
    }
  }

  async openSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    if (options.signal?.aborted) throw abortError()
    if (options.resume === "fork") {
      throw new PermanentError("ACP does not support forked sessions")
    }
    const defaultTimeout = timeoutMs(options.timeout)
    const questionForms = options.questionForms === true
    let startupReject!: (error: Error) => void
    const startupFailure = new Promise<never>((_, reject) => {
      startupReject = reject
    })
    let failSession: ((error: Error) => void) | undefined
    const failStartup = (error: Error) => {
      startupReject(error)
      failSession?.(error)
    }
    const onSessionAbort = () => failStartup(abortError())
    options.signal?.addEventListener("abort", onSessionAbort, { once: true })
    const startupTimer = setTimeout(
      () => failStartup(new Error(`acp startup timed out (${defaultTimeout}ms)`)),
      defaultTimeout
    )
    let cleanup: (() => Promise<void>) | undefined
    try {
      // Bound the lazy import too, and recheck abort before spawning anything.
      const acp = await Promise.race([import("@agentclientprotocol/sdk"), startupFailure])
      if (options.signal?.aborted) throw abortError()
      const command = options.command ?? DEFAULT_COMMAND
      const spec = specForCommand(command)
      const meta = spec?.meta?.({ ...options, prompt: "", timeout: defaultTimeout })
      const child = spawn(resolveExecutable(command) ?? command, options.args ?? DEFAULT_ARGS, {
        cwd: options.workDir,
        env: process.env,
        detached: true,
      })
      let state: RuntimeSession["state"] = "idle"
      let sessionId = ""
      let active: ActiveTurn | undefined
      let childClosed = false
      let terminalError: Error | undefined
      let errorOutput = ""
      let escalation: NodeJS.Timeout | undefined
      let acknowledgement: NodeJS.Timeout | undefined
      let closePromise: Promise<void> | undefined
      let closeResolve: (() => void) | undefined
      let closeReject: ((error: Error) => void) | undefined
      let connection: import("@agentclientprotocol/sdk").ClientConnection | undefined

      const killTree = (signal: NodeJS.Signals) => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal)
            return
          } catch {
            // A fake child or an already-ended group may need the child fallback.
          }
        }
        try {
          child.kill(signal)
        } catch {
          // Already gone; only the close event acknowledges cleanup.
        }
      }
      const emitForTurn = (turn: ActiveTurn, event: RuntimeEventPayload) => {
        turn.options.onEvent?.({
          ...event,
          runId: turn.runId,
          agentId: options.agentId,
          seq: turn.seq++,
        } as RuntimeEvent)
      }
      const emit = (event: RuntimeEventPayload) => {
        if (active) emitForTurn(active, event)
      }
      const settleTurn = (turn: ActiveTurn, output?: AgentOutput, error?: Error) => {
        if (active !== turn) return
        turn.decisions.abort()
        if (turn.timer) clearTimeout(turn.timer)
        if (turn.cancelTimer) clearTimeout(turn.cancelTimer)
        if (turn.onAbort) turn.options.signal?.removeEventListener("abort", turn.onAbort)
        active = undefined
        if (state === "running" || state === "cancelling") state = "idle"
        if (error) {
          if (closePromise) {
            void closePromise.then(
              () => turn.reject(error),
              (cleanupError: Error) => turn.reject(cleanupError)
            )
          } else turn.reject(error)
        } else if (output) turn.resolve(output)
      }
      const clearCleanupTimers = () => {
        if (escalation) clearTimeout(escalation)
        if (acknowledgement) clearTimeout(acknowledgement)
      }
      const close = (): Promise<void> => {
        if (closePromise) return closePromise
        closePromise = new Promise<void>((resolve, reject) => {
          closeResolve = resolve
          closeReject = reject
        })
        options.signal?.removeEventListener("abort", onSessionAbort)
        clearTimeout(startupTimer)
        state = "closing"
        if (active) settleTurn(active, undefined, active.error ?? terminalError ?? abortError())
        if (childClosed) {
          state = "closed"
          closeResolve?.()
          return closePromise
        }
        // Cleanup timers belong to the process, not to a turn's settlement.
        escalation = setTimeout(() => {
          killTree("SIGKILL")
          if (childClosed) return
          acknowledgement = setTimeout(() => {
            state = "closed"
            clearCleanupTimers()
            closeReject?.(new Error(`${command} cleanup failed: no child close after SIGKILL`))
          }, CLEANUP_ACK_MS)
        }, KILL_ESCALATION_MS)
        try {
          connection?.close()
        } catch {
          // Still reap the process if closing the protocol fails.
        }
        killTree("SIGTERM")
        return closePromise
      }
      const fail = (error: Error) => {
        terminalError ??= error
        startupReject(terminalError)
        void close().catch(() => {})
      }
      failSession = fail
      cleanup = close

      const stderrDecoder = new StringDecoder("utf8")
      child.stderr.on("data", (data: Buffer) => {
        errorOutput += stderrDecoder.write(data)
      })
      child.on("close", (code) => {
        childClosed = true
        errorOutput += stderrDecoder.end()
        clearCleanupTimers()
        clearTimeout(startupTimer)
        options.signal?.removeEventListener("abort", onSessionAbort)
        if (!closePromise) {
          fail(new Error(`${command} exited with code ${code}: ${errorOutput}`))
        }
        state = "closed"
        try {
          connection?.close()
        } catch {
          // The child has already acknowledged process cleanup.
        }
        closeResolve?.()
      })
      child.on("error", (error) => {
        fail(new PermanentError(`Failed to start ${command}: ${error.message}`))
      })

      const handleUpdate = (notification: AcpSessionNotification) => {
        // Replay from session/load and all idle notifications are not turn output.
        const turn = active
        if (!turn || notification.sessionId !== sessionId) return
        const update = notification.update
        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            const text = textOf(update.content)
            if (text === undefined) emit({ type: "raw", vendor: "acp", payload: update })
            else {
              turn.output += text
              emit({ type: "message_delta", role: "agent", text })
            }
            break
          }
          case "user_message_chunk":
          case "agent_thought_chunk": {
            const text = textOf(update.content)
            if (text === undefined) emit({ type: "raw", vendor: "acp", payload: update })
            else {
              emit({
                type: "message_delta",
                role: update.sessionUpdate === "user_message_chunk" ? "user" : "thought",
                text,
              })
            }
            break
          }
          case "tool_call":
            emit({
              type: "tool_call",
              id: update.toolCallId,
              name: update.name ?? update.title,
              input: update.rawInput,
            })
            break
          case "tool_call_update":
            emit({
              type: "tool_result",
              id: update.toolCallId,
              output: stringifyOutput(update.rawOutput ?? update.content),
              isError: update.status === "failed",
            })
            break
          case "plan":
            emit({ type: "plan", entries: update.entries.map((entry) => entry.content) })
            break
          case "usage_update": {
            if (typeof update.used === "number" && typeof update.size === "number") {
              turn.usage = { contextTokens: update.used, contextSize: update.size }
              emit({ type: "usage", ...turn.usage })
            }
            const cost = isRecord(update.cost) ? update.cost : undefined
            if (typeof cost?.amount === "number" && typeof cost.currency === "string") {
              turn.cost = { amount: cost.amount, currency: cost.currency }
              emit({
                type: "cost",
                ...turn.cost,
                ...(cost.currency.toLowerCase() === "usd" ? { costUsd: cost.amount } : {}),
              })
            }
            break
          }
          default:
            emit({ type: "raw", vendor: "acp", payload: update })
        }
      }
      const app = acp.client({ name: "multiclaw" })
      app.onNotification(acp.methods.client.session.update, (context) => {
        handleUpdate(context.params)
      })
      app.onRequest(acp.methods.client.session.requestPermission, async (context) => {
        const cancelled: AcpPermissionResponse = { outcome: { outcome: "cancelled" } }
        const turn = active
        const params = context.params
        if (
          state !== "running" ||
          !turn ||
          params.sessionId !== sessionId ||
          context.signal.aborted
        )
          return cancelled
        const mode = turn.options.permissionMode ?? "auto"
        const { response, rejected } = decidePermission(params, options.tools, sessionId)
        if (rejected) {
          warn("Tool permission denied by the configured tools policy.")
          emit({
            type: "raw",
            vendor: "acp",
            payload: { type: "permission_rejected", ...rejected },
          })
          return response
        }
        if (mode === "auto") return response
        if (mode !== "ask" || !turn.options.onPermission) {
          warn(
            mode === "ask"
              ? "Tool permission cancelled: no approval handler is available."
              : "Tool permission denied by the configured approval mode."
          )
          return cancelled
        }
        const signal = AbortSignal.any([turn.decisions.signal, context.signal])
        const offered = new Set(params.options.map((option) => option.optionId))
        const request = {
          requestId: randomUUID(),
          runId: turn.runId,
          agentId: options.agentId,
          seq: turn.seq++,
          sessionId,
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? params.toolCall.name ?? "Tool permission",
          toolName: params.toolCall.name ?? undefined,
          kind: params.toolCall.kind ?? undefined,
          input: params.toolCall.rawInput,
          options: params.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
        }
        let onAbort!: () => void
        const aborted = new Promise<undefined>((resolve) => {
          onAbort = () => resolve(undefined)
          signal.addEventListener("abort", onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
        try {
          const optionId = await Promise.race([
            Promise.resolve().then(() =>
              signal.aborted ? undefined : turn.options.onPermission?.(request, signal)
            ),
            aborted,
          ])
          if (signal.aborted || active !== turn || state !== "running") return cancelled
          return optionId !== undefined && offered.has(optionId)
            ? ({ outcome: { outcome: "selected", optionId } } as AcpPermissionResponse)
            : cancelled
        } catch {
          return cancelled
        } finally {
          signal.removeEventListener("abort", onAbort)
        }
      })
      app.onRequest(acp.methods.client.elicitation.create, async (context) => {
        const cancelled: import("@agentclientprotocol/sdk").CreateElicitationResponse = {
          action: "cancel",
        }
        const turn = active
        const params = context.params
        if (
          state !== "running" ||
          !turn ||
          context.signal.aborted ||
          !("sessionId" in params) ||
          params.sessionId !== sessionId
        )
          return cancelled
        if (params.mode !== "form" || !supportedQuestionSchema(params.requestedSchema)) {
          warn("Structured question cancelled: unsupported form mode or schema.")
          return cancelled
        }
        if (!questionForms || !turn.options.onQuestion) {
          warn("Structured question cancelled: no negotiated question handler is available.")
          return cancelled
        }
        const schema = structuredClone(params.requestedSchema)
        const signal = AbortSignal.any([turn.decisions.signal, context.signal])
        const request = {
          requestId: randomUUID(),
          runId: turn.runId,
          agentId: options.agentId,
          seq: turn.seq++,
          sessionId,
          toolCallId:
            "toolCallId" in params && typeof params.toolCallId === "string"
              ? params.toolCallId
              : undefined,
          message: params.message,
          requestedSchema: structuredClone(schema),
        }
        let onAbort!: () => void
        const aborted = new Promise<undefined>((resolve) => {
          onAbort = () => resolve(undefined)
          signal.addEventListener("abort", onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
        try {
          const response = await Promise.race([
            Promise.resolve().then(() =>
              signal.aborted ? undefined : turn.options.onQuestion?.(request, signal)
            ),
            aborted,
          ])
          if (signal.aborted || active !== turn || state !== "running" || !response)
            return cancelled
          if (response.action === "accept") {
            if (!validateRuntimeQuestionContent(schema, response.content)) {
              warn("Structured question cancelled: the answer does not match the requested schema.")
              return cancelled
            }
            return { action: "accept" as const, content: structuredClone(response.content) }
          }
          return response.action === "decline" ? { action: "decline" as const } : cancelled
        } catch {
          return cancelled
        } finally {
          signal.removeEventListener("abort", onAbort)
        }
      })
      connection = app.connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin),
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
        )
      )
      const ctx = connection.agent
      const onConnectionClosed = () => {
        if (!closePromise) fail(new Error(`${command} ACP connection closed: ${errorOutput}`))
      }
      // Some embedders mock just the request context; the real SDK supplies closed.
      connection.closed?.then(onConnectionClosed, onConnectionClosed)

      const cancelTurn = (): Promise<void> => {
        const turn = active
        if (!turn) return closePromise ?? Promise.resolve()
        if (turn.cancellation) return turn.cancellation
        state = "cancelling"
        turn.decisions.abort()
        const waitForCleanup = async () => {
          if (closePromise) await closePromise
        }
        turn.cancellation = turn.promise.then(waitForCleanup, waitForCleanup)
        turn.cancelTimer = setTimeout(() => {
          fail(turn.error ?? abortError())
        }, CANCEL_GRACE_MS)
        void Promise.resolve()
          .then(() => {
            if (active === turn) return ctx.notify(acp.methods.agent.session.cancel, { sessionId })
          })
          .catch((error: unknown) => {
            if (active === turn) fail(withAuthHint(acp, error))
          })
        return turn.cancellation
      }
      const prompt = (
        text: string,
        promptOptions: RuntimePromptOptions = {}
      ): Promise<AgentOutput> => {
        if (state !== "idle") {
          return Promise.reject(new Error(`Cannot prompt ACP session while ${state}`))
        }
        if (options.signal?.aborted || promptOptions.signal?.aborted) {
          return Promise.reject(abortError())
        }
        let duration: number
        try {
          duration = timeoutMs(promptOptions.timeout ?? defaultTimeout)
        } catch (error) {
          return Promise.reject(error)
        }
        let resolve!: (output: AgentOutput) => void
        let reject!: (error: Error) => void
        const promise = new Promise<AgentOutput>((res, rej) => {
          resolve = res
          reject = rej
        })
        const turn: ActiveTurn = {
          runId: randomUUID(),
          seq: 0,
          options: promptOptions,
          output: "",
          decisions: new AbortController(),
          promise,
          resolve,
          reject,
        }
        active = turn
        state = "running"
        turn.onAbort = () => {
          turn.error = abortError()
          void cancelTurn().catch(() => {})
        }
        promptOptions.signal?.addEventListener("abort", turn.onAbort, { once: true })
        turn.timer = setTimeout(() => {
          turn.error = new Error(`acp timed out (${duration}ms)`)
          fail(turn.error)
        }, duration)
        const run = async () => {
          emit({ type: "run_started", model: options.model })
          // A synchronous event callback may close or cancel this turn.
          if (active !== turn) return
          const response = await ctx.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [
              {
                type: "text",
                text:
                  meta === undefined && options.systemPrompt
                    ? `${options.systemPrompt}\n\n---\n\n${text}`
                    : text,
              },
            ],
          })
          if (active !== turn) return
          if (turn.error) {
            settleTurn(turn, undefined, turn.error)
            return
          }
          const stopReason = mapStopReason(response.stopReason)
          settleTurn(turn, {
            output: turn.output,
            exitCode: stopReason === "success" ? 0 : 1,
            sessionId,
            stopReason,
            ...(turn.usage ? { usage: turn.usage } : {}),
            ...(turn.cost?.currency.toLowerCase() === "usd" ? { costUsd: turn.cost.amount } : {}),
          })
          emitForTurn(turn, { type: "run_finished", stopReason })
        }
        void run().catch((error: unknown) => {
          if (active === turn) fail(withAuthHint(acp, error))
        })
        return promise
      }
      const session: RuntimeSession = {
        get sessionId() {
          return sessionId
        },
        get state() {
          return state
        },
        capabilities: { continuation: true, supplement: false },
        prompt,
        cancelTurn,
        close,
      }
      const warn = (message: string) => {
        if (options.onWarning) options.onWarning(message)
        else process.stderr.write(`[multiclaw] Warning: ${message}\n`)
      }
      const initialize = async () => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          ...(questionForms ? { clientCapabilities: { elicitation: { form: {} } } } : {}),
        })
        if (terminalError) throw terminalError
        if (options.sessionId) {
          if (init.agentCapabilities?.loadSession !== true) {
            throw new PermanentError(
              `Agent does not support session/load (loadSession=false); cannot resume session ${options.sessionId}`
            )
          }
          await ctx.request(acp.methods.agent.session.load, {
            sessionId: options.sessionId,
            cwd: options.workDir,
            mcpServers: [],
            ...(meta ? { _meta: meta } : {}),
          })
          sessionId = options.sessionId
        } else {
          const created = await ctx.request(acp.methods.agent.session.new, {
            cwd: options.workDir,
            mcpServers: [],
            ...(meta ? { _meta: meta } : {}),
          })
          sessionId = created.sessionId
          const modelOpt = created.configOptions?.find(
            (option) =>
              (option as { category?: string | null; id?: string }).category === "model" ||
              (option as { id?: string }).id === "model"
          )
          if (
            modelOpt &&
            "options" in modelOpt &&
            Array.isArray((modelOpt as { options?: unknown }).options)
          ) {
            discoveredModels.set(
              command,
              ((modelOpt as { options?: Array<{ value?: string }> }).options ?? []).map(
                (option) => option.value ?? String(option)
              )
            )
          }
        }
        if (terminalError) throw terminalError
        if (options.model && spec?.modelSelection === "config-option") {
          const known = discoveredModels.get(command)
          if (known && !known.includes(options.model)) {
            warn(
              `model "${options.model}" is not offered by ${command}; running with the provider's default.`
            )
          } else {
            try {
              await ctx.request(acp.methods.agent.session.setConfigOption, {
                sessionId,
                configId: "model",
                value: options.model,
              })
            } catch (error) {
              if (terminalError) throw terminalError
              warn(
                `Could not set model "${options.model}" on ${command}; running with the provider's default (${errorMessage(error)}).`
              )
            }
          }
        }
        if (terminalError) throw terminalError
        if (options.signal?.aborted) throw abortError()
      }
      await Promise.race([
        initialize().catch((error: unknown) => {
          throw withAuthHint(acp, error)
        }),
        startupFailure,
      ])
      clearTimeout(startupTimer)
      return session
    } catch (error) {
      clearTimeout(startupTimer)
      options.signal?.removeEventListener("abort", onSessionAbort)
      if (cleanup) await cleanup()
      throw error
    }
  }
}
