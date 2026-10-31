import type { AgentOutput, AgentRuntime, AgentTask, RuntimeSession } from "../types/runtime"
import { abortError, isAbortError } from "../utils/abort"

interface SessionEntry {
  runtime: AgentRuntime
  fingerprint: string
  startup: AbortController
  opening: Promise<RuntimeSession>
  session?: RuntimeSession
  closing?: Promise<void>
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
  private entries = new Map<string, SessionEntry>()
  private resetting?: Promise<void>
  private closing?: Promise<void>
  private closed = false

  async execute(runtime: AgentRuntime, task: AgentTask): Promise<AgentOutput> {
    if (this.closed) throw new Error("AgentSessionManager is closed")
    if (this.resetting) throw new Error("AgentSessionManager is resetting")
    if (task.signal?.aborted) throw abortError()

    let entry = this.entries.get(task.agentId)
    if (
      entry?.busy ||
      (entry?.session && entry.session.state !== "idle" && entry.session.state !== "closed")
    ) {
      throw new Error(`Agent session ${task.agentId} is busy`)
    }
    if (entry?.closing) await entry.closing
    const fingerprint = JSON.stringify([
      task.command,
      task.args,
      task.model,
      task.workDir,
      task.systemPrompt,
      task.tools,
      task.sessionId,
      task.resume,
      Boolean(task.onQuestion),
    ])
    if (
      entry &&
      (entry.runtime !== runtime ||
        entry.fingerprint !== fingerprint ||
        entry.session?.state === "closed" ||
        !runtime.openSession)
    ) {
      entry.busy = true
      try {
        await this.closeEntry(entry)
        this.entries.delete(task.agentId)
      } finally {
        entry.busy = false
      }
      entry = undefined
      if (this.closed || this.resetting) throw abortError()
    }
    if (task.signal?.aborted) throw abortError()
    const openSession = runtime.openSession
    if (!openSession) return runtime.execute(task)

    let detach: (() => void) | undefined
    if (!entry) {
      const startup = new AbortController()
      const forwardAbort = () => startup.abort(task.signal?.reason)
      task.signal?.addEventListener("abort", forwardAbort, { once: true })
      detach = () => task.signal?.removeEventListener("abort", forwardAbort)
      const created: SessionEntry = {
        runtime,
        fingerprint,
        startup,
        busy: true,
        onWarning: task.onWarning,
        // Defer opening until the cache entry is installed, including synchronous failures.
        opening: Promise.resolve()
          .then(() =>
            openSession.call(runtime, {
              agentId: task.agentId,
              systemPrompt: task.systemPrompt,
              tools: task.tools,
              workDir: task.workDir,
              command: task.command,
              args: task.args,
              model: task.model,
              sessionId: task.sessionId,
              resume: task.resume,
              timeout: task.timeout,
              questionForms: Boolean(task.onQuestion),
              signal: startup.signal,
              onWarning: (message) => created.onWarning?.(message),
            })
          )
          .then((session) => {
            created.session = session
            return session
          }),
      }
      entry = created
      this.entries.set(task.agentId, entry)
    } else {
      entry.busy = true
      entry.onWarning = task.onWarning
    }

    try {
      const session = await entry.opening
      detach?.()
      detach = undefined
      if (entry.startup.signal.aborted || this.closed || this.resetting) {
        await this.closeEntry(entry)
        throw abortError()
      }
      if (session.state !== "idle") throw new Error(`Agent session ${task.agentId} is busy`)
      return await session.prompt(task.prompt, {
        signal: task.signal,
        timeout: task.timeout,
        onEvent: task.onEvent,
        permissionMode: task.permissionMode,
        onPermission: task.onPermission,
        onQuestion: task.onQuestion,
      })
    } finally {
      detach?.()
      entry.onWarning = undefined
      try {
        if (entry.session?.state === "closed") {
          await this.closeEntry(entry)
          if (this.entries.get(task.agentId) === entry) this.entries.delete(task.agentId)
        } else if (!entry.session) {
          if (this.entries.get(task.agentId) === entry) this.entries.delete(task.agentId)
        }
      } finally {
        entry.busy = false
      }
    }
  }

  /**
   * Whether this manager still holds a session for `agentId`.
   *
   * A caller about to continue a past conversation uses this to avoid naming a
   * session it already has open: passing the id would change the entry's
   * fingerprint, and the manager would close a perfectly good session and
   * `session/load` it straight back.
   */
  has(agentId: string): boolean {
    if (this.closed) return false
    const entry = this.entries.get(agentId)
    return entry !== undefined && !entry.closing && entry.session?.state !== "closed"
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
          session = await entry.opening
        } catch (error) {
          // Cooperative startup cancellation has no live session to close.
          if (isAbortError(error)) return
          throw error
        }
        await session.close()
      })()
    }
    return entry.closing
  }
}
