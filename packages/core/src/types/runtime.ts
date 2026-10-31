/**
 * Everything a runtime emits about a run carries the same envelope. `seq` is a
 * per-run monotonic counter so a consumer can order events without trusting the
 * clock; `runId` is fresh for every `execute()` call or session `prompt()` turn.
 */
export interface RuntimeEventBase {
  runId: string
  agentId: string
  seq: number
}

/**
 * The structured stream a runtime produces while an agent runs.
 *
 * This is deliberately wider than any single adapter implements: a runtime only
 * emits the variants it can actually produce, and `RuntimeInfo.capabilities`
 * tells the caller which those are. `raw` is the escape hatch for vendor output
 * we recognise the shape of but have not modelled yet — it must never be the
 * reason a run fails.
 */
export type RuntimeEvent =
  | (RuntimeEventBase & { type: "run_started"; model?: string })
  | (RuntimeEventBase & { type: "message_delta"; role: "agent" | "thought" | "user"; text: string })
  | (RuntimeEventBase & { type: "message"; role: "agent" | "thought" | "user"; text: string })
  /**
   * A tool call. The same `id` may arrive more than once: providers announce a
   * call before its arguments have streamed, so the first event can carry an
   * empty `input` and a later one the completed arguments. Consumers should key
   * on `id` and render a row once.
   */
  | (RuntimeEventBase & { type: "tool_call"; id: string; name: string; input: unknown })
  | (RuntimeEventBase & { type: "tool_result"; id: string; output: string; isError: boolean })
  | (RuntimeEventBase & { type: "plan"; entries: string[] })
  | (RuntimeEventBase & {
      type: "usage"
      inputTokens?: number
      outputTokens?: number
      contextTokens?: number
      contextSize?: number
    })
  | (RuntimeEventBase & {
      type: "cost"
      costUsd?: number
      modelBreakdown?: Record<string, unknown>
      amount?: number
      currency?: string
    })
  | (RuntimeEventBase & { type: "raw"; vendor: string; payload: unknown })
  | (RuntimeEventBase & {
      type: "run_finished"
      stopReason: "success" | "max_turns" | "cancelled" | "timeout" | "error"
    })
  | (RuntimeEventBase & { type: "run_error"; message: string; code?: string })

/**
 * What a *runtime adapter* implements — not what the upstream binary is capable
 * of. A flag is only `true` when this adapter actually wires the behaviour; an
 * unhonoured `true` would make callers pass options that are silently dropped.
 */
export interface RuntimeCapabilities {
  streaming: boolean
  sessions: boolean
  resume: boolean
  permissions: boolean
  tools: boolean
  models: boolean
  images: boolean
  usage: boolean
  cost: boolean
  sandbox: boolean
}

/** The result of capability negotiation, returned by `AgentRuntime.describe()`. */
export interface RuntimeInfo {
  name: string
  version?: string
  available: boolean
  capabilities: RuntimeCapabilities
}

/** Caller-supplied context for {@link AgentRuntime.describe}. */
export interface RuntimeQuery {
  /** Binary this runtime would launch, when the caller knows it. */
  command?: string
}

export interface RuntimePermissionRequest extends RuntimeEventBase {
  requestId: string
  sessionId: string
  toolCallId: string
  title: string
  toolName?: string
  kind?: string
  input?: unknown
  /** Only choices permitted by the configured tools policy are offered. */
  options: Array<{
    optionId: string
    name: string
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
  }>
}

/** Return an offered option id, or undefined to cancel/deny. Never grant outside the tools policy. */
export type RuntimePermissionHandler = (
  request: RuntimePermissionRequest,
  signal: AbortSignal
) => Promise<string | undefined>

export interface RuntimeQuestionRequest extends RuntimeEventBase {
  requestId: string
  sessionId: string
  toolCallId?: string
  message: string
  requestedSchema: import("@agentclientprotocol/sdk").ElicitationSchema
}

export type RuntimeQuestionResponse =
  | { action: "accept"; content: Record<string, string | number | boolean | string[]> }
  | { action: "decline" | "cancel" }

/** Structured form input only; the signal aborts when the requesting turn ends. */
export type RuntimeQuestionHandler = (
  request: RuntimeQuestionRequest,
  signal: AbortSignal
) => Promise<RuntimeQuestionResponse>

export interface AgentTask {
  agentId: string
  systemPrompt: string
  prompt: string
  tools: string[]
  workDir: string
  timeout: number
  signal?: AbortSignal
  onEvent?: (event: RuntimeEvent) => void
  /** Automatic tools policy by default; ask without a handler denies. */
  permissionMode?: "auto" | "ask" | "deny"
  onPermission?: RuntimePermissionHandler
  onQuestion?: RuntimeQuestionHandler
  /**
   * Non-fatal diagnostics the runtime wants the caller to surface.
   *
   * A runtime runs under a TUI's alternate screen, where anything written
   * straight to stderr is invisible — so a warning the user needs to see has to
   * travel on a channel the caller can render. Optional, so a direct caller that
   * supplies nothing keeps the old behaviour (the runtime falls back to stderr).
   */
  onWarning?: (message: string) => void
  /** Ask the runtime to run under a specific session id, if it supports sessions. */
  sessionId?: string
  /** How to treat an existing session: continue it in place, or fork a copy. */
  resume?: "continue" | "fork"
  model?: string
  /**
   * Command to launch, for runtimes that drive an external process (e.g. ACP).
   * Generic — it names a binary, not a protocol — so runtimes that do not spawn
   * anything ignore it.
   */
  command?: string
  /** Arguments for {@link command}. */
  args?: string[]
}

export interface AgentOutput {
  output: string
  exitCode: number
  sessionId?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    contextTokens?: number
    contextSize?: number
  }
  costUsd?: number
  stopReason?: string
}

/** Immutable agent configuration shared by all turns in an open session. */
export type RuntimeSessionOptions = Omit<
  AgentTask,
  "prompt" | "onEvent" | "signal" | "timeout" | "permissionMode" | "onPermission" | "onQuestion"
> & {
  /** Immutable negotiated form capability; callbacks remain turn-local. */
  questionForms?: boolean
  /** Lifetime cancellation, including startup and idle time; closes the session. */
  signal?: AbortSignal
  /** Startup deadline and default per-turn timeout in ms (ACP defaults to 600,000). */
  timeout?: number
}

export interface RuntimePromptOptions {
  /** Cancels only this turn. A cooperative provider leaves the session reusable. */
  signal?: AbortSignal
  /** Overrides the session's default per-turn deadline. */
  timeout?: number
  /** Turn-local events, with a fresh runId and sequence counter. */
  onEvent?: (event: RuntimeEvent) => void
  /** Waiting uses the existing turn timeout; it does not pause the deadline. */
  permissionMode?: "auto" | "ask" | "deny"
  onPermission?: RuntimePermissionHandler
  onQuestion?: RuntimeQuestionHandler
}

/**
 * What a mid-turn message did.
 *
 * `injected` means the running turn took it — the agent will see it before it
 * finishes. `idle` means no turn was running, so nothing was applied and the
 * caller still owns the text; deciding to queue it is the caller's job, not the
 * runtime's.
 */
export type RuntimeSupplementResult = { status: "injected" } | { status: "idle" }

/** Caller-owned live session. Always await close() in a finally block. */
export interface RuntimeSession {
  readonly sessionId: string
  readonly state: "idle" | "running" | "cancelling" | "closing" | "closed"
  /**
   * What this session can do beyond a single turn.
   *
   * `supplement` is negotiated with the provider rather than assumed: it is true
   * only when the agent advertised mid-turn input during `initialize` (ACP
   * `_meta.steering.supported`), so a bridge that does not implement it is
   * reported as unable instead of being sent a method it will ignore.
   */
  readonly capabilities: { continuation: boolean; supplement: boolean }
  /** Rejects overlapping turns; it does not implicitly queue or inject input. */
  prompt(text: string, options?: RuntimePromptOptions): Promise<AgentOutput>
  /**
   * Delivers a message into the turn that is running *now*, when
   * {@link RuntimeSession.capabilities} allows it.
   *
   * Only meaningful mid-turn. An idle session resolves `idle` and must not start
   * a turn from it: `prompt` is how a turn starts, and a turn the caller never
   * started has no owner to settle it, cancel it or show its output. Rejects on
   * provider errors — "did it land?" must never be a guess.
   */
  supplement?(text: string, options?: { signal?: AbortSignal }): Promise<RuntimeSupplementResult>
  /**
   * Idempotently cancels the current turn and waits for its terminal response.
   * ACP closes uncooperative providers after a grace period; cleanup failure rejects.
   * Idle cancellation is a no-op. The prompt may reject independently.
   */
  cancelTurn(): Promise<void>
  /** Idempotent cleanup barrier; rejects if process cleanup cannot be acknowledged. */
  close(): Promise<void>
}

export interface AgentRuntime {
  readonly name: string
  describe(options?: RuntimeQuery): Promise<RuntimeInfo>
  execute(task: AgentTask): Promise<AgentOutput>
  /** Optional live-session API; existing execute-only runtimes remain compatible. */
  openSession?(options: RuntimeSessionOptions): Promise<RuntimeSession>
}
