import { EventBus } from "../event/EventBus"
import type { AgentResult } from "../types/agent"
import type { MultiClawConfig, OrchestratorResult, WorkContext } from "../types/config"
import type { CoordinationDecision } from "../types/coordination"
import type { LeaderDecision } from "../types/leader"
import type { SessionRecord } from "../types/session"
import { abortError } from "../utils/abort"
import { extractJsonObjects } from "../utils/json"
import { parseLeaderDecision } from "../utils/leaderDecision"
import { AgentRunner } from "./AgentRunner"
import { AgentSessionManager } from "./AgentSessionManager"
import { ContextManager } from "./ContextManager"
import { coordinatorAgent } from "./coordinatorAgent"

/** Serializes host calls without holding the worker execution loop. */
export class Coordinator {
  readonly eventBus = new EventBus()
  private tail: Promise<unknown> = Promise.resolve()
  private sessions = new AgentSessionManager()
  private closed = false
  private controller = new AbortController()
  session?: SessionRecord
  readonly costs: Array<{ costUsd?: number }> = []

  constructor(
    private config: MultiClawConfig,
    session?: SessionRecord
  ) {
    this.session = session
  }

  async idle(): Promise<void> {
    for (;;) {
      const tail = this.tail
      await tail.catch(() => {})
      if (tail === this.tail) return
    }
  }

  private execute(
    phase: "routing" | "chat" | "summary",
    request: string,
    signal?: AbortSignal
  ): Promise<AgentResult> {
    const next = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.closed) throw new Error("Coordinator is closed")
        this.eventBus.emit({
          type: "coordinator:phase",
          timestamp: new Date().toISOString(),
          payload: { phase },
        })
        const config: MultiClawConfig = {
          ...this.config,
          resume: this.session ? { sessions: { __coordinator: this.session } } : undefined,
          permissions: { mode: "deny", getMode: () => "deny" },
          questions: undefined,
        }
        const context = new ContextManager({ ...config.context, coordinatorRequest: request })
        try {
          const result = await new AgentRunner(
            this.eventBus,
            context,
            config.workDir,
            config,
            this.sessions
          ).run(
            coordinatorAgent(),
            signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
          )
          if (result.session) this.session = result.session
          this.costs.push({ costUsd: result.costUsd })
          if (result.status === "cancelled") throw abortError()
          if (result.status !== "success")
            throw new Error(result.error ?? "Coordinator did not complete")
          return result
        } finally {
          this.eventBus.emit({
            type: "coordinator:phase",
            timestamp: new Date().toISOString(),
            payload: { phase: "idle" },
          })
        }
      })
    this.tail = next
    return next
  }

  async route(request: string, signal?: AbortSignal): Promise<LeaderDecision> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.execute(
        "routing",
        "## Phase: routing\n" +
          request +
          (attempt ? "\nPrevious decision was invalid. Return one valid decision." : ""),
        signal
      )
      const decision = parseLeaderDecision(result.output)
      if (decision) return decision
    }
    throw new Error("Coordinator returned an invalid routing decision")
  }

  async chat(
    message: string,
    facts: { work: WorkContext; results: AgentResult[]; history: unknown; supplements: unknown },
    signal?: AbortSignal
  ): Promise<CoordinationDecision> {
    const request =
      "## Phase: chat\nA team is already executing. Answer status/questions from facts. Clarify ambiguous changes. Supplement only this exact workId and known agent IDs. Queue independent new work. Replace only when the user explicitly requests stopping/replacing current work. Preserve the complete goal.\nReturn ONLY one JSON object:\n" +
      '{"mode":"reply"|"ask","message":"text"}\n' +
      '{"mode":"supplement","message":"explanation","workId":"exact ID","text":"additional requirement","agents":["id"]}\n' +
      '{"mode":"queue"|"replace","message":"explanation","requirement":"complete new goal and constraints"}\n' +
      JSON.stringify({ message, ...facts })
    const result = await this.execute("chat", request, signal)
    for (const value of extractJsonObjects(result.output)) {
      if (!value || typeof value !== "object") continue
      const v = value as Record<string, unknown>
      if (typeof v.message !== "string" || !v.message.trim()) continue
      if (v.mode === "reply" || v.mode === "ask") return { mode: v.mode, message: v.message }
      if (
        (v.mode === "queue" || v.mode === "replace") &&
        typeof v.requirement === "string" &&
        v.requirement.trim()
      )
        return { mode: v.mode, message: v.message, requirement: v.requirement }
      if (
        v.mode === "supplement" &&
        v.workId === facts.work.id &&
        typeof v.text === "string" &&
        v.text.trim() &&
        Array.isArray(v.agents) &&
        v.agents.length &&
        v.agents.every(
          (id) => typeof id === "string" && this.config.agents.some((a) => a.id === id)
        ) &&
        new Set(v.agents).size === v.agents.length
      )
        return {
          mode: "supplement",
          message: v.message,
          workId: v.workId as string,
          text: v.text,
          agents: v.agents as string[],
        }
    }
    throw new Error(
      "Coordinator returned an invalid live interaction; no instruction was dispatched"
    )
  }

  async summarize(result: OrchestratorResult, signal?: AbortSignal): Promise<string> {
    const response = await this.execute(
      "summary",
      "## Phase: summary\nSummarize observed work in the user's language. State completed changes, verification and unresolved items. Execution success and acceptance are different facts. Do not dispatch work or use tools. Output natural language only.\n" +
        JSON.stringify(result),
      signal
    )
    const text = response.output.trim()
    if (!text) throw new Error("Coordinator returned an empty summary")
    return text
  }

  async close(): Promise<void> {
    this.closed = true
    this.controller.abort()
    await this.idle()
    await this.sessions.close()
  }
}
