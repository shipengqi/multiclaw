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
  RuntimeSupplementResult,
} from "../types/runtime"
import { abortError } from "../utils/abort"
import { PermanentError } from "../utils/errors"
import { hasToolArgs } from "../utils/toolSummary"
import { RuntimeBase } from "./RuntimeBase"

/** Model ids advertised by each command's session/new response. */
const discoveredModels = new Map<string, string[]>()

/** Grace period between SIGTERM and SIGKILL during process cleanup. */
export const KILL_ESCALATION_MS = 3000
const CANCEL_GRACE_MS = 2000
const CLEANUP_ACK_MS = 3000
/**
 * How long a mid-turn message may take to be acknowledged.
 *
 * Injecting is a queue push on the agent side, so anything slower means the
 * agent is stuck somewhere it cannot answer from — and an unacknowledged steer
 * is worse than a refused one, because the user cannot tell whether it landed.
 */
const STEER_ACK_MS = 15_000
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

/**
 * Extension method both ACP bridges implement for mid-turn input.
 *
 * It is not in the ACP spec: the two bridges that support it (Claude and Codex)
 * agreed on this name, this `{ sessionId, prompt }` shape and this `outcome`
 * vocabulary, and advertise it as `InitializeResponse._meta.steering.supported`.
 */
const STEER_METHOD = "_session/steering"

/**
 * Whether the agent advertised mid-turn input during `initialize`.
 *
 * `_meta` is a free-form extension bag that the protocol says clients must not
 * assume anything about, so this reads it defensively and requires an explicit
 * `supported === true`. Anything else — a missing key, a truthy string, an
 * older bridge — means "not available", which is the safe direction: the
 * console then queues the text instead of sending a method nobody will read.
 */
function advertisesSteering(init: { _meta?: { [key: string]: unknown } | null }): boolean {
  const steering = init._meta?.steering
  return isRecord(steering) && steering.supported === true
}

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

/**
 * Match one allowlist entry against a tool name.
 *
 * Entries are case-insensitive globs: `*` stands for any run of characters, so
 * `mcp__graft__*` covers a whole MCP server instead of every tool it exposes.
 * Nothing else is special — no character classes, no ranges, no `?` — because
 * an allowlist nobody can read at a glance is an allowlist nobody audits.
 */
function matchesTool(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${source}$`).test(name)
}

function toolPermitted(params: AcpPermissionRequest, tools: string[]): boolean {
  const allowed = tools.map((tool) => tool.toLowerCase())
  const name = params.toolCall.name ?? undefined
  if (name !== undefined) {
    const candidate = name.toLowerCase()
    return allowed.some((pattern) => matchesTool(pattern, candidate))
  }
  return (KIND_TO_TOOLS[params.toolCall.kind ?? ""] ?? []).some((tool) => {
    const candidate = tool.toLowerCase()
    return allowed.some((pattern) => matchesTool(pattern, candidate))
  })
}

/**
 * The client's answer to a permission request, decided without a human.
 *
 * `approved` is the part the caller needs: an allowlisted tool runs without
 * asking, and only the ones outside the list can be escalated to a person.
 */
function decidePermission(
  params: AcpPermissionRequest,
  tools: string[],
  sessionId: string | undefined
): { response: AcpPermissionResponse; approved: boolean; rejected?: RejectedPermission } {
  if (sessionId !== undefined && params.sessionId !== sessionId) {
    return { response: { outcome: { outcome: "cancelled" } }, approved: false }
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
  if (approved) return { response, approved }
  return {
    response,
    approved,
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
      /** Negotiated during `initialize`; decides whether `supplement` exists. */
      let steeringSupported = false
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
      /**
       * Tool calls whose arguments have already been reported.
       *
       * ACP announces a tool call before its input has finished streaming, so
       * the first `tool_call` carries an empty object. The arguments arrive on a
       * later update; without this set every progress ping would re-emit them.
       */
      const argsSurfaced = new Set<string>()
      /** Names by tool-call id: a refinement is not required to repeat the name. */
      const toolNames = new Map<string, string>()

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
          case "tool_call": {
            const name = update.name ?? update.title
            toolNames.set(update.toolCallId, name)
            if (hasToolArgs(update.rawInput)) argsSurfaced.add(update.toolCallId)
            emit({ type: "tool_call", id: update.toolCallId, name, input: update.rawInput })
            break
          }
          case "tool_call_update": {
            // The first `tool_call` could not carry the arguments — they were
            // still streaming. Replay the completed input as a second
            // `tool_call` for the same id so a consumer can render one row that
            // says what the tool was asked to do instead of a bare `{}`.
            if (!argsSurfaced.has(update.toolCallId) && hasToolArgs(update.rawInput)) {
              argsSurfaced.add(update.toolCallId)
              emit({
                type: "tool_call",
                id: update.toolCallId,
                name: update.name ?? toolNames.get(update.toolCallId) ?? update.title ?? "",
                input: update.rawInput,
              })
            }
            emit({
              type: "tool_result",
              id: update.toolCallId,
              output: stringifyOutput(update.rawOutput ?? update.content),
              isError: update.status === "failed",
            })
            break
          }
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
        const { response, approved, rejected } = decidePermission(params, options.tools, sessionId)
        // The allowlist is the policy, not the prompt. A listed tool runs
        // without asking in every mode but `deny`; `ask` exists to escalate the
        // tools the list does *not* cover, which is the only case where a
        // question can change the outcome.
        if (approved) {
          if (mode !== "deny") return response
          warn("Tool permission denied by the configured approval mode.")
          return cancelled
        }
        const askable = mode === "ask" && turn.options.onPermission !== undefined
        if (!askable) {
          const label =
            rejected?.name ?? rejected?.kind ?? rejected?.toolCallId ?? "an unnamed tool"
          // Two different refusals, and only one of them is actionable: "not on
          // the list" is a configuration decision, "no handler" is a wiring bug.
          warn(
            mode === "ask"
              ? `Tool permission cancelled: no approval handler is available (${label}).`
              : `Tool permission denied by the configured tools policy: ${label}.`
          )
          if (rejected) {
            emit({
              type: "raw",
              vendor: "acp",
              payload: { type: "permission_rejected", ...rejected },
            })
          }
          // `deny` refuses outright; every other mode answers with the policy's
          // reject option when the provider offered one.
          return mode === "deny" ? cancelled : response
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
          const chosen = params.options.find((option) => option.optionId === optionId)
          if (optionId === undefined || chosen === undefined || !offered.has(optionId)) {
            return cancelled
          }
          // A refusal chosen by a person leaves the same trace a policy denial
          // does, so the stream can still say which call was refused — `source`
          // separates "the list does not cover it" from "a person said no".
          if (chosen.kind.startsWith("reject") && rejected) {
            emit({
              type: "raw",
              vendor: "acp",
              payload: { type: "permission_rejected", ...rejected, source: "user" },
            })
          }
          return { outcome: { outcome: "selected", optionId } } as AcpPermissionResponse
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
      /**
       * Deliver a message into the running turn.
       *
       * Three things are deliberate here:
       *
       * - It never starts a turn. Both bridges will happily start one when
       *   nothing is running (Codex always, Claude unless asked not to), and a
       *   turn started from a steer has no `prompt` call owning it: nothing here
       *   would settle it, attribute its output, or show it to the user. So an
       *   idle session answers `idle` and the caller keeps its text.
       * - It asks the provider not to start a turn either, via
       *   `_meta.steering.idleBehavior`. Claude honours that and answers
       *   `promptRequired`; Codex ignores unknown meta and answers
       *   `startedNewTurn`, which is why that branch below has to clean up after
       *   it (measured 2026-10-31: `session/cancel` sent as a notification does
       *   stop the turn Codex started this way).
       * - It has a deadline. "Did my message land?" cannot be a guess.
       *
       * `injected` is about delivery, not obedience. Counting probes stopped
       * before their original target with Claude bridges 0.89.1 / 0.95.0 and
       * codex-acp 2.5.0, but reached the target first with codex-acp 2.2.2.
       * These observations do not guarantee timing for other tasks or versions.
       * Callers should acknowledge delivery, not promise immediate obedience.
       */
      const supplement = async (
        text: string,
        supplementOptions: { signal?: AbortSignal } = {}
      ): Promise<RuntimeSupplementResult> => {
        if (!steeringSupported) {
          throw new Error(`${command} does not accept mid-turn input`)
        }
        const turn = active
        if (!turn || state !== "running") return { status: "idle" }
        if (supplementOptions.signal?.aborted) throw abortError()
        let timer: NodeJS.Timeout | undefined
        try {
          const response = await Promise.race([
            ctx.request<{ outcome?: unknown }, Record<string, unknown>>(STEER_METHOD, {
              sessionId,
              prompt: [{ type: "text", text }],
              _meta: { steering: { idleBehavior: "promptRequired" } },
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`steering was not acknowledged within ${STEER_ACK_MS}ms`)),
                STEER_ACK_MS
              )
            }),
          ])
          if (active !== turn) return { status: "idle" }
          const outcome = response?.outcome
          if (outcome === "injected") return { status: "injected" }
          if (outcome === "promptRequired") return { status: "idle" }
          if (outcome === "startedNewTurn") {
            // The turn ended between the check above and the agent's decision, so
            // the agent started one from our text. Nothing owns it: cancel it
            // rather than let work run that the caller is not tracking.
            await Promise.resolve()
              .then(() => ctx.notify(acp.methods.agent.session.cancel, { sessionId }))
              .catch(() => {})
            return { status: "idle" }
          }
          if (outcome === "failed") {
            throw new Error("the agent could not apply the mid-turn message")
          }
          throw new Error(`unexpected steering outcome: ${JSON.stringify(outcome ?? null)}`)
        } finally {
          if (timer) clearTimeout(timer)
        }
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
        get capabilities() {
          // Read, not captured: the negotiation happens in `initialize`, after
          // this object exists.
          return { continuation: true, supplement: steeringSupported }
        },
        prompt,
        supplement,
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
        steeringSupported = advertisesSteering(init)
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
