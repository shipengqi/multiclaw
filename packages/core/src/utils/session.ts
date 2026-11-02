import { createHash } from "node:crypto"
import * as path from "node:path"
import type { AgentRuntime, AgentTask } from "../types/runtime"
import type { SessionEvent, SessionRecord } from "../types/session"

/** Only immutable creation options participate; target IDs and work identity are checked separately. */
export function sessionCompatibilityKey(
  runtime: Pick<AgentRuntime, "name">,
  task: AgentTask
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        runtime.name,
        task.provider,
        task.command,
        task.args,
        task.model,
        path.resolve(task.workDir),
        task.systemPrompt,
        Boolean(task.onQuestion),
      ])
    )
    .digest("hex")
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const capabilities = record.capabilities as Record<string, unknown> | undefined
  const failure = record.failure as Record<string, unknown> | undefined
  return (
    ["bindingId", "agentId", "runtime", "compatibilityKey", "observedAt"].every(
      (key) => typeof record[key] === "string" && !!record[key]
    ) &&
    (record.sessionId === undefined ||
      (typeof record.sessionId === "string" && !!record.sessionId)) &&
    (record.workId === undefined || typeof record.workId === "string") &&
    (record.reason === undefined || typeof record.reason === "string") &&
    ["opening", "idle", "running", "cancelling", "closing", "closed", "unknown"].includes(
      String(record.state)
    ) &&
    ["created", "loaded", "reused"].includes(String(record.action)) &&
    !!capabilities &&
    ["continuation", "load", "supplement"].every((key) => typeof capabilities[key] === "boolean") &&
    (failure === undefined ||
      (!!failure &&
        [
          "incompatible",
          "unsupported",
          "opening_failed",
          "load_failed",
          "turn_failed",
          "cleanup_failed",
        ].includes(String(failure.code)) &&
        typeof failure.message === "string"))
  )
}

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  return (
    isSessionRecord(event.record) &&
    [
      "opening",
      "created",
      "load_requested",
      "loaded",
      "reused",
      "state_changed",
      "opening_failed",
      "load_failed",
      "closing",
      "closed",
      "cleanup_failed",
    ].includes(String(event.action)) &&
    typeof event.executionId === "string" &&
    !!event.executionId &&
    Number.isInteger(event.attempt) &&
    (event.attempt as number) > 0 &&
    (event.requestedSessionId === undefined || typeof event.requestedSessionId === "string") &&
    (event.reason === undefined || typeof event.reason === "string")
  )
}

export function describeSession(record: SessionRecord): string {
  if (record.failure)
    return "Session " + record.failure.code.replaceAll("_", " ") + ": " + record.failure.message
  if (record.state === "opening") return "Session opening"
  if (!record.sessionId) return "Session not established · " + record.state
  return (
    "Session " +
    record.action +
    (record.sessionId ? " " + record.sessionId : "") +
    " · " +
    record.state
  )
}
