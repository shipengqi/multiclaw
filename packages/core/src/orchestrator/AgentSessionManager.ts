import { randomUUID } from "node:crypto"
import type { AgentOutput, AgentRuntime, AgentTask, RuntimeSession } from "../types/runtime"
import type { SessionEvent, SessionIntent, SessionRecord } from "../types/session"
import { abortError, isAbortError } from "../utils/abort"
import { PermanentError } from "../utils/errors"
import { sessionCompatibilityKey } from "../utils/session"

interface SessionObservation {
  record: SessionRecord
  executionId: string
  attempt: number
  session?: RuntimeSession
}

interface SessionEntry extends SessionObservation {
  runtime: AgentRuntime
  startup: AbortController
  opening: Promise<RuntimeSession>
  closing?: Promise<void>
  cleanupComplete?: boolean
  busy: boolean
  onWarning?: AgentTask["onWarning"]
}

/** What one agent did with a mid-turn message. */
export interface SupplementReport {
  agentId: string
  /**
   * `injected` landed in the running turn; `idle` had no turn to land in;
   * `unsupported` cannot take mid-turn input at all; `error` failed.
   */
  status: "injected" | "idle" | "unsupported" | "error"
  error?: string
}

/** Owns reusable agent sessions across independent orchestration turns. */
export class AgentSessionManager {
  private listeners = new Set<(event: SessionEvent) => void>()

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(
    entry: SessionObservation,
    action: SessionEvent["action"],
    requestedSessionId?: string
  ): void {
    entry.record.observedAt = new Date().toISOString()
    if (
      entry.session &&
      action !== "closing" &&
      action !== "closed" &&
      entry.record.failure?.code !== "cleanup_failed"
    )
      entry.record.state = entry.session.state
    const event: SessionEvent = {
      action,
      executionId: entry.executionId,
      attempt: entry.attempt,
      record: structuredClone(entry.record),
      ...(requestedSessionId ? { requestedSessionId } : {}),
      reason: entry.record.reason,
    }
    for (const listener of this.listeners) listener(event)
  }

  private entries = new Map<string, SessionEntry>()
  private resetting?: Promise<void>
  private closing?: Promise<void>
  private closed = false

  private compatible(
    record: SessionRecord,
    runtime: AgentRuntime,
    task: AgentTask,
    key: string
  ): boolean {
    return (
      record.agentId === task.agentId &&
      record.workId === task.workId &&
      record.runtime === runtime.name &&
      record.compatibilityKey === key
    )
  }

  inspect(
    runtime: AgentRuntime,
    task: AgentTask,
    context: { session?: SessionRecord; strict?: boolean } = {}
  ): SessionIntent {
    const intent = (action: SessionIntent["action"], reason: string): SessionIntent => ({
      agentId: task.agentId,
      action,
      reason,
    })
    const entry = this.entries.get(task.agentId)
    if (
      this.closed ||
      this.resetting ||
      entry?.busy ||
      entry?.closing ||
      (entry?.session && !["idle", "closed"].includes(entry.session.state))
    )
      return intent("unavailable", "A Session is busy or cleanup is pending.")
    let candidate = context.session
    if (
      candidate?.failure?.code === "cleanup_failed" ||
      entry?.record.failure?.code === "cleanup_failed"
    )
      return intent("unavailable", "Previous Session cleanup was not acknowledged.")
    if (!candidate?.sessionId) candidate = undefined
    const key = sessionCompatibilityKey(runtime, task)
    const compatible = (record: SessionRecord) => this.compatible(record, runtime, task, key)
    if (candidate && !compatible(candidate))
      return intent(
        context.strict ? "unavailable" : "create",
        "Recorded work identity or immutable Session settings differ."
      )
    if (entry && compatible(entry.record)) {
      if (
        runtime.openSession &&
        entry.runtime === runtime &&
        entry.session?.state === "idle" &&
        entry.session.capabilities.continuation &&
        (!candidate?.sessionId || candidate.sessionId === entry.session.sessionId)
      )
        return intent("reuse", "Will reuse the matching live Session if still idle.")
      candidate ??= entry.record
    }
    if (candidate) {
      if (!runtime.openSession || !candidate.capabilities.load)
        return intent(
          context.strict ? "unavailable" : "create",
          "Recorded Session loading is unsupported."
        )
      return intent(
        "load",
        "Will attempt to load the recorded conversation; restoration is not yet confirmed."
      )
    }
    return intent(
      "create",
      "Will start a new executor conversation; any previous worker must first acknowledge cleanup."
    )
  }

  async execute(
    runtime: AgentRuntime,
    task: AgentTask,
    context: {
      session?: SessionRecord
      strict?: boolean
      executionId?: string
      attempt?: number
    } = {}
  ): Promise<AgentOutput> {
    if (this.closed) throw new Error("AgentSessionManager is closed")
    if (this.resetting) throw new Error("AgentSessionManager is resetting")
    if (task.signal?.aborted) throw abortError()
    const compatibilityKey = sessionCompatibilityKey(runtime, task)
    const executionId = context.executionId ?? randomUUID()
    const attempt = context.attempt ?? 1
    let entry = this.entries.get(task.agentId)
    if (entry?.busy || (entry?.session && !["idle", "closed"].includes(entry.session.state)))
      throw new Error("Agent session is busy: " + task.agentId)
    if (entry?.closing) await entry.closing
    let candidate = context.session
    let reason: string | undefined
    const compatible = (record: SessionRecord) =>
      this.compatible(record, runtime, task, compatibilityKey)
    const observation = (): SessionObservation => ({
      record: {
        bindingId: randomUUID(),
        agentId: task.agentId,
        workId: task.workId,
        runtime: runtime.name,
        compatibilityKey,
        state: "opening",
        capabilities: { continuation: false, load: false, supplement: false },
        action: "created",
        observedAt: new Date().toISOString(),
        reason,
      },
      executionId,
      attempt,
    })
    const rejectTarget = (code: "incompatible" | "unsupported", message: string): never => {
      const failure = observation()
      failure.record.state = "unknown"
      failure.record.failure = { code, message }
      this.publish(failure, "load_failed", candidate?.sessionId)
      throw new PermanentError(message)
    }
    if (candidate?.failure?.code === "cleanup_failed")
      rejectTarget(
        "unsupported",
        "Previous Session cleanup was not acknowledged; refusing to start a replacement executor."
      )
    if (!candidate?.sessionId) candidate = undefined
    if (candidate && !compatible(candidate)) {
      reason =
        "The recorded Session belongs to different work or has incompatible creation settings."
      if (context.strict) rejectTarget("incompatible", reason)
      candidate = undefined
    }
    const requested = candidate?.sessionId
    if (
      entry &&
      (entry.runtime !== runtime ||
        !compatible(entry.record) ||
        entry.session?.state === "closed" ||
        !entry.session?.capabilities.continuation ||
        (requested && requested !== entry.session.sessionId) ||
        task.resume === "fork" ||
        !runtime.openSession)
    ) {
      reason ??= !compatible(entry.record)
        ? "Work identity or immutable Session settings changed."
        : "The previous live Session cannot continue."
      if (!candidate && compatible(entry.record) && entry.record.failure?.code !== "cleanup_failed")
        candidate = structuredClone(entry.record)
      await this.closeEntry(entry)
      this.entries.delete(task.agentId)
      entry = undefined
      if (this.closed || this.resetting || task.signal?.aborted) throw abortError()
    }
    if (!entry && candidate && !candidate.capabilities.load) {
      reason = "The recorded provider Session does not support loading."
      if (context.strict) rejectTarget("unsupported", reason)
      candidate = undefined
    }
    if (!runtime.openSession) {
      if (candidate) rejectTarget("unsupported", "This runtime cannot load a live Session.")
      const output = await runtime.execute(task)
      if (output.sessionId) {
        const observed = observation()
        observed.record.sessionId = output.sessionId
        observed.record.state = "unknown"
        observed.record.reason =
          "The execute-only runtime reported an ID without a managed Session."
        this.publish(observed, "state_changed")
      }
      return output
    }
    let detach: (() => void) | undefined
    if (!entry) {
      const sessionId = candidate?.sessionId
      const created: SessionEntry = {
        ...observation(),
        runtime,
        startup: new AbortController(),
        busy: true,
        onWarning: task.onWarning,
        opening: Promise.resolve().then(() => open()),
      }
      const open = async (): Promise<RuntimeSession> => {
        try {
          const session = await runtime.openSession!({
            agentId: task.agentId,
            provider: task.provider,
            systemPrompt: task.systemPrompt,
            workDir: task.workDir,
            command: task.command,
            args: task.args,
            model: task.model,
            sessionId,
            resume: task.resume,
            timeout: task.timeout,
            questionForms: Boolean(task.onQuestion),
            signal: created.startup.signal,
            onWarning: (message) => created.onWarning?.(message),
          })
          created.session = session
          created.record.capabilities = { ...session.capabilities }
          if (sessionId && session.sessionId !== sessionId) {
            created.record.failure = {
              code: "load_failed",
              message:
                "Provider returned a different Session ID; the requested conversation was not restored.",
            }
            await this.closeSession(created, session)
            throw new PermanentError(created.record.failure.message)
          }
          created.record.sessionId = session.sessionId
          this.publish(created, sessionId ? "loaded" : "created", sessionId)
          return session
        } catch (error) {
          created.record.failure ??= {
            code: sessionId ? "load_failed" : "opening_failed",
            message: error instanceof Error ? error.message : String(error),
          }
          if (!created.session) created.record.state = "unknown"
          this.publish(created, sessionId ? "load_failed" : "opening_failed", sessionId)
          throw error
        }
      }
      created.record.action = sessionId ? "loaded" : "created"
      const forwardAbort = () => created.startup.abort(task.signal?.reason)
      task.signal?.addEventListener("abort", forwardAbort, { once: true })
      detach = () => task.signal?.removeEventListener("abort", forwardAbort)
      this.entries.set(task.agentId, created)
      this.publish(created, sessionId ? "load_requested" : "opening", sessionId)
      entry = created
    } else {
      entry.busy = true
      entry.onWarning = task.onWarning
      entry.executionId = executionId
      entry.attempt = attempt
      entry.record.action = "reused"
      entry.record.failure = undefined
      this.publish(entry, "reused")
    }
    try {
      const session = await entry.opening
      detach?.()
      detach = undefined
      if (entry.startup.signal.aborted || this.closed || this.resetting) {
        await this.closeEntry(entry)
        throw abortError()
      }
      if (session.state !== "idle") throw new Error("Agent session is busy: " + task.agentId)
      const prompt = task.workId
        ? task.prompt +
          "\n\n## Session continuity\n" +
          (entry.record.action === "created"
            ? "A new executor Session was created; no old conversation was restored. Inspect the workspace before repeating operations."
            : entry.record.action === "loaded"
              ? "The recorded provider conversation was loaded successfully. Inspect current workspace state before continuing."
              : "The matching live executor conversation is being reused.") +
          (entry.record.reason ? "\n" + entry.record.reason : "")
        : task.prompt
      const turn = session.prompt(prompt, {
        signal: task.signal,
        timeout: task.timeout,
        onEvent: task.onEvent,
        permissionMode: task.permissionMode,
        onPermission: task.onPermission,
        onQuestion: task.onQuestion,
      })
      this.publish(entry, "state_changed")
      return await turn
    } catch (error) {
      if (entry.session) {
        entry.record.failure ??= {
          code: "turn_failed",
          message: error instanceof Error ? error.message : String(error),
        }
        this.publish(entry, "state_changed")
      }
      throw error
    } finally {
      detach?.()
      entry.onWarning = undefined
      try {
        if (entry.session?.state === "closed") {
          await this.closeEntry(entry)
          if (this.entries.get(task.agentId) === entry) this.entries.delete(task.agentId)
        } else if (!entry.session) {
          if (this.entries.get(task.agentId) === entry) this.entries.delete(task.agentId)
        } else this.publish(entry, "state_changed")
      } finally {
        entry.busy = false
      }
    }
  }

  /**
   * Deliver a message into every session that is running a turn right now.
   *
   * Only `running` sessions are candidates, and that is the whole safety
   * argument: a session between turns has nothing to inject into, and asking a
   * provider to steer an idle session makes it *start* a turn that this manager
   * never scheduled — one whose output belongs to no turn and which nothing
   * would ever settle. Sessions that are idle are therefore not reported as
   * failures but simply absent, and the caller sees an empty list.
   *
   * One agent failing never stops the others: each report stands alone, because
   * the caller has to be able to say "architect took it, qa did not" rather than
   * "steering failed".
   */
  async supplement(text: string): Promise<SupplementReport[]> {
    if (this.closed) return []
    const targets = [...this.entries.entries()].filter(
      ([, entry]) => entry.session?.state === "running"
    )
    return await Promise.all(
      targets.map(async ([agentId, entry]): Promise<SupplementReport> => {
        const session = entry.session
        if (!session) return { agentId, status: "idle" }
        if (!session.capabilities.supplement || !session.supplement) {
          return { agentId, status: "unsupported" }
        }
        try {
          return { agentId, status: (await session.supplement(text)).status }
        } catch (error) {
          return {
            agentId,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }
        }
      })
    )
  }

  /** Close selected idle conversations without resetting the leader. */
  async resetAgents(agentIds: string[]): Promise<void> {
    for (const id of agentIds) {
      const entry = this.entries.get(id)
      if (!entry) continue
      if (entry.busy) throw new Error("Cannot reset a busy agent: " + id)
      await this.closeEntry(entry)
      if (this.entries.get(id) === entry) this.entries.delete(id)
    }
  }

  /** Closes all sessions and permits a fresh conversation after cleanup completes. */
  reset(): Promise<void> {
    if (this.closing) return this.closing
    if (this.resetting) return this.resetting
    this.resetting = this.drain().finally(() => {
      this.resetting = undefined
    })
    return this.resetting
  }

  /** Terminal, idempotent cleanup barrier. No new executions may start. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.resetting ?? this.drain()
    return this.closing
  }

  private async drain(): Promise<void> {
    const entries = [...this.entries.entries()]
    for (const [, entry] of entries) entry.startup.abort()
    const results = await Promise.allSettled(
      entries.map(async ([id, entry]) => {
        await this.closeEntry(entry)
        if (this.entries.get(id) === entry) this.entries.delete(id)
      })
    )
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Agent session cleanup failed")
  }

  private closeEntry(entry: SessionEntry): Promise<void> {
    if (!entry.closing) {
      entry.closing = (async () => {
        let session: RuntimeSession
        try {
          session = entry.session ?? (await entry.opening)
        } catch (error) {
          if (entry.session) session = entry.session
          else if (isAbortError(error)) return
          else throw error
        }
        await this.closeSession(entry, session)
      })()
    }
    return entry.closing
  }

  private async closeSession(entry: SessionEntry, session: RuntimeSession): Promise<void> {
    if (entry.cleanupComplete) return
    if (entry.record.failure?.code === "cleanup_failed")
      throw new Error(entry.record.failure.message)
    entry.record.state = "closing"
    this.publish(entry, "closing")
    try {
      await session.close()
      entry.cleanupComplete = true
      entry.record.state = "closed"
      this.publish(entry, "closed")
    } catch (error) {
      entry.record.state = "unknown"
      entry.record.failure = {
        code: "cleanup_failed",
        message: error instanceof Error ? error.message : String(error),
      }
      this.publish(entry, "cleanup_failed")
      throw error
    }
  }
}
