/** Observed provider conversation facts, independent of an execution's outcome. */
export interface SessionRecord {
  bindingId: string
  agentId: string
  workId?: string
  sessionId?: string
  runtime: string
  compatibilityKey: string
  state: "opening" | "idle" | "running" | "cancelling" | "closing" | "closed" | "unknown"
  capabilities: { continuation: boolean; load: boolean; supplement: boolean }
  action: "created" | "loaded" | "reused"
  observedAt: string
  reason?: string
  failure?: {
    code:
      | "incompatible"
      | "unsupported"
      | "opening_failed"
      | "load_failed"
      | "turn_failed"
      | "cleanup_failed"
    message: string
  }
}

export interface SessionEvent {
  action:
    | "opening"
    | "created"
    | "load_requested"
    | "loaded"
    | "reused"
    | "state_changed"
    | "opening_failed"
    | "load_failed"
    | "closing"
    | "closed"
    | "cleanup_failed"
  executionId: string
  attempt: number
  record: SessionRecord
  requestedSessionId?: string
  reason?: string
}

/** Read-only intent; loading and cleanup have not happened. */
export interface SessionIntent {
  agentId: string
  action: "create" | "reuse" | "load" | "unavailable"
  reason: string
}
