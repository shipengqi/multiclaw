/**
 * Everything a runtime emits about a run carries the same envelope. `seq` is a
 * per-run monotonic counter so a consumer can order events without trusting the
 * clock; `runId` is fresh for every `execute()` call.
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
  | (RuntimeEventBase & { type: "tool_call"; id: string; name: string; input: unknown })
  | (RuntimeEventBase & { type: "tool_result"; id: string; output: string; isError: boolean })
  | (RuntimeEventBase & { type: "plan"; entries: string[] })
  | (RuntimeEventBase & { type: "usage"; inputTokens?: number; outputTokens?: number })
  | (RuntimeEventBase & {
      type: "cost"
      costUsd?: number
      modelBreakdown?: Record<string, unknown>
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

export interface AgentTask {
  agentId: string
  systemPrompt: string
  prompt: string
  tools: string[]
  workDir: string
  timeout: number
  signal?: AbortSignal
  onEvent?: (event: RuntimeEvent) => void
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
  usage?: { inputTokens?: number; outputTokens?: number }
  costUsd?: number
  stopReason?: string
}

export interface AgentRuntime {
  readonly name: string
  describe(options?: RuntimeQuery): Promise<RuntimeInfo>
  execute(task: AgentTask): Promise<AgentOutput>
}
