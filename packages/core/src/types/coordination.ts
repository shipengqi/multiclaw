import type { SessionRecord } from "./session"

export interface WorkSupplement {
  /** Owning application chat, when execution is managed by a session host. */
  sessionId?: string
  messageId: string
  workId: string
  revision: number
  text: string
  deliveries: Array<{
    agentId: string
    bindingId?: string
    status: "pending" | "delivered" | "applied" | "failed" | "unknown"
    reason?: string
  }>
}

export type CoordinationDecision =
  | { mode: "reply" | "ask"; message: string }
  | { mode: "supplement"; message: string; workId: string; text: string; agents: string[] }
  | { mode: "queue" | "replace"; message: string; requirement: string }

export interface CoordinatorState {
  session?: SessionRecord
}
