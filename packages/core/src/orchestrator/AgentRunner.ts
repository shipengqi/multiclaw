import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { resolvePermissionMode } from "../config/permissionMode"
import type { EventBus } from "../event/EventBus"
import { resolveArgs, resolveCommand, resolveModel, resolveProvider } from "../providers/resolve"
import { KILL_ESCALATION_MS, runtimeRegistry } from "../runtime"
import type { AgentDefinition, AgentResult } from "../types/agent"
import type { MultiClawConfig } from "../types/config"
import type { AgentOutput, AgentTask } from "../types/runtime"
import type { SessionIntent, SessionRecord } from "../types/session"
import { abortError, isAbortError } from "../utils/abort"
import { isPermanent } from "../utils/errors"
import { HANDOFF_INSTRUCTION, parseHandoff } from "../utils/handoff"
import { renderPrompt } from "../utils/prompt"
import { DEFAULT_RETRY_DELAY_MS, retryBudgetMs, withRetry } from "../utils/retry"
import { withTimeout } from "../utils/timeout"
import { summarizeToolInput, summarizeToolOutput } from "../utils/toolSummary"
import { AgentSessionManager } from "./AgentSessionManager"
import type { ContextManager } from "./ContextManager"

/** The `kind` a chunk of agent output carries on the `agent:output` event. */
type OutputKind = "text" | "tool" | "tool-detail"

export class AgentRunner {
  constructor(
    private eventBus: EventBus,
    private contextManager: ContextManager,
    private globalWorkDir: string,
    private config: MultiClawConfig,
    private sessionManager?: AgentSessionManager
  ) {}

  private sessionTask(agent: AgentDefinition): AgentTask {
    return {
      agentId: agent.id,
      workId: agent.id === this.config.leader?.id ? undefined : this.contextManager.get("workId"),
      systemPrompt: agent.systemPrompt,
      prompt: "",
      workDir: agent.workDir ? path.resolve(this.globalWorkDir, agent.workDir) : this.globalWorkDir,
      timeout: agent.timeout ?? 600_000,
      model: resolveModel(agent, this.config),
      provider: resolveProvider(agent, this.config),
      command: resolveCommand(agent, this.config),
      args: resolveArgs(agent, this.config),
      onQuestion: this.config.questions?.onRequest,
    }
  }

  previewSession(agent: AgentDefinition): SessionIntent {
    const task = this.sessionTask(agent)
    return (this.sessionManager ?? new AgentSessionManager()).inspect(
      runtimeRegistry.get(agent.runtime ?? "acp"),
      task,
      { session: this.config.resume?.sessions?.[agent.id], strict: !!this.config.resume?.agents }
    )
  }

  async run(
    agent: AgentDefinition,
    signal?: AbortSignal,
    instruction?: string
  ): Promise<AgentResult> {
    const startTime = new Date()
    const executionId = randomUUID()
    const manager = this.sessionManager ?? new AgentSessionManager()
    let session: SessionRecord | undefined
    let finalResult: AgentResult | undefined
    const offSession = manager.subscribe((event) => {
      if (event.executionId !== executionId) return
      session = event.record
      if (!this.sessionManager)
        this.eventBus.emit({
          type: "agent:session",
          timestamp: event.record.observedAt,
          payload: event,
        })
    })
    const model = resolveModel(agent, this.config)

    this.eventBus.emit({
      type: "agent:start",
      timestamp: new Date().toISOString(),
      payload: {
        agentId: agent.id,
        agentName: agent.name,
        icon: agent.icon,
        model,
        taskTitle: agent.taskTitle,
      },
    })

    let attempts = 0
    let output = ""
    // Populated only on the success path: a run that never returned has no
    // usage or cost to report, so both stay undefined rather than becoming 0.
    let usage: AgentOutput["usage"]
    let costUsd: number | undefined

    try {
      // Everything that can throw lives inside the try. `run` promises to always
      // resolve to an AgentResult, and callers rely on it: `runStage` batches
      // agents with Promise.all, so one rejection would discard the results of
      // every sibling that did finish.
      const workDir = agent.workDir
        ? path.resolve(this.globalWorkDir, agent.workDir)
        : this.globalWorkDir
      fs.mkdirSync(workDir, { recursive: true })

      const runtime = runtimeRegistry.get(agent.runtime ?? "acp")
      const retries = agent.retries ?? 0
      const timeout = agent.timeout ?? 600_000
      const permissionMode = resolvePermissionMode(this.config, agent)

      // The inner timeout bounds one attempt; the outer deadline covers every
      // attempt and its backoff. Include the SIGKILL grace so execute-only runtimes
      // get their full attempt budget. Session runtimes can also spend time in
      // startup and teardown: the outer deadline aborts them, but waits for
      // their cleanup acknowledgement before publishing a final agent event.
      const completed = await withTimeout(
        (innerSignal) =>
          withRetry(
            async (attempt) => {
              attempts = attempt
              if (signal?.aborted) throw abortError()
              const agentContext: Record<string, string> = {
                ...this.contextManager.snapshot(),
                // Every built-in task template references both. The leader only
                // fills them in when the architect wrote a plan entry for this
                // agent, and the no-leader path has no plan at all — so without a
                // default the model is handed the literal text `{{agentScope}}`
                // and has to guess what it was supposed to say.
                agentScope:
                  agent.agentScope?.trim() ||
                  "Fulfil the current requirement within your role: " +
                    (agent.description ?? agent.name),
                agentPlan:
                  agent.agentPlan?.trim() ||
                  "No step-by-step plan was provided — use your judgement.",
              }
              let prompt = await renderPrompt(agent.taskPrompt, agentContext, this.globalWorkDir)
              const requirement =
                this.contextManager.get("requirement") ?? this.config.context?.requirement
              if (agent.id !== this.config.leader?.id && requirement !== undefined) {
                prompt = `## Current task\n${requirement}\n\n${prompt}`
              }
              if (agent.id !== this.config.leader?.id && agent.id !== this.config.review?.reviewer)
                prompt =
                  "## Assigned responsibility\n" +
                  agentContext.agentScope +
                  "\n\n## Planning\n" +
                  agentContext.agentPlan +
                  "\n\n" +
                  prompt
              if (agent.id !== this.config.leader?.id && agent.id !== this.config.review?.reviewer)
                prompt += "\n\n" + HANDOFF_INSTRUCTION
              if (instruction) prompt += `\n\n${instruction}`
              // One row per tool call, printed once it can say what the tool was
              // asked to do. ACP announces a call before its arguments have
              // finished streaming, so the first sighting usually carries none;
              // holding the row until they arrive is what turns `› Read {}` into
              // `› Read {"file_path":"src/App.tsx"}`.
              const toolRows = new Set<string>()
              const toolNames = new Map<string, string>()
              const printToolRow = (id: string, name: string, input: unknown) => {
                if (toolRows.has(id)) return
                toolRows.add(id)
                const summary = summarizeToolInput(input)
                this.emitOutput(agent.id, `\n› ${name}${summary ? ` ${summary}` : ""}\n`, "tool")
              }
              const task: AgentTask = {
                ...this.sessionTask(agent),
                prompt,
                permissionMode,
                onPermission: this.config.permissions?.onRequest,
                onQuestion: this.config.questions?.onRequest,
                signal:
                  runtime.openSession && signal
                    ? AbortSignal.any([innerSignal, signal])
                    : innerSignal,
                model,
                provider: resolveProvider(agent, this.config),
                // A runtime's diagnostics travel on the event bus rather than
                // stderr: under the TUI's alternate screen a stderr write is
                // never seen. The agent name prefixes the line so it is
                // locatable in the one-row status area.
                onWarning: (message) => {
                  this.eventBus.emit({
                    type: "orchestration:warning",
                    timestamp: new Date().toISOString(),
                    payload: { message: `[${agent.name}] ${message}` },
                  })
                },
                onEvent: (e) => {
                  // The agent's prose is untagged; tool activity is tagged so a
                  // consumer can decide how much of it to show.
                  if (
                    (e.type === "message_delta" || e.type === "message") &&
                    e.role === "agent" &&
                    e.text
                  ) {
                    this.emitOutput(agent.id, e.text)
                    return
                  }
                  if (e.type === "tool_call") {
                    toolNames.set(e.id, e.name)
                    // No arguments yet: the row would read `› Read {}`, so wait
                    // for the refinement instead of printing a placeholder.
                    if (summarizeToolInput(e.input)) printToolRow(e.id, e.name, e.input)
                    return
                  }
                  if (e.type === "tool_result") {
                    // A call whose arguments never arrived still happened; show
                    // the bare name rather than dropping the row entirely.
                    const name = toolNames.get(e.id)
                    if (name !== undefined) printToolRow(e.id, name, undefined)
                    const summary = summarizeToolOutput(e.output)
                    // A failed tool is a summary line the user needs; a
                    // successful one is detail, shown only in verbose mode.
                    this.emitOutput(
                      agent.id,
                      `  ${e.isError ? "✗" : "✓"} ${summary}\n`,
                      e.isError ? "tool" : "tool-detail"
                    )
                  }
                },
              }
              return await manager.execute(runtime, task, {
                session: this.config.resume?.sessions?.[agent.id],
                strict: !!this.config.resume?.agents,
                executionId,
                attempt,
              })
            },
            retries,
            (attempt, err) => {
              this.eventBus.emit({
                type: "agent:retrying",
                timestamp: new Date().toISOString(),
                payload: {
                  agentId: agent.id,
                  agentName: agent.name,
                  attempt,
                  maxAttempts: retries + 1,
                  error: (err as Error).message,
                },
              })
            },
            DEFAULT_RETRY_DELAY_MS,
            runtime.openSession && signal ? AbortSignal.any([innerSignal, signal]) : innerSignal,
            // A permanent failure (a missing binary, an unsupported capability)
            // will fail the same way on every attempt, so let the loop fail fast
            // instead of burning the whole backoff budget on a doomed run.
            (err) => !isPermanent(err)
          ),
        retryBudgetMs(timeout + KILL_ESCALATION_MS, retries),
        agent.name,
        // Session runtimes acknowledge cancellation only after process cleanup.
        // Neither caller cancellation nor the outer timeout may race that barrier.
        runtime.openSession ? undefined : signal,
        { waitForCleanup: !!runtime.openSession }
      )

      output = completed.output
      usage = completed.usage
      costUsd = completed.costUsd
      const incomplete = completed.stopReason !== undefined && completed.stopReason !== "success"
      const cancelled = completed.stopReason === "cancelled"
      const handoff =
        completed.exitCode === 0 &&
        !incomplete &&
        agent.id !== this.config.leader?.id &&
        agent.id !== this.config.review?.reviewer
          ? parseHandoff(output)
          : undefined
      const failed = completed.exitCode !== 0 || incomplete || !!(handoff && "error" in handoff)
      const error =
        handoff && "error" in handoff
          ? handoff.error
          : failed
            ? `Runtime turn did not complete (${completed.stopReason ?? `exit code ${completed.exitCode}`})`
            : undefined

      const endTime = new Date()
      const result: AgentResult = {
        agentId: agent.id,
        agentName: agent.name,
        status: cancelled ? "cancelled" : failed ? "failed" : handoff ? "handed_back" : "success",
        ...(handoff && "reason" in handoff ? { handoffReason: handoff.reason } : {}),
        ...(error ? { error } : {}),
        output,
        duration: endTime.getTime() - startTime.getTime(),
        attempts,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        model,
        ...(usage ? { usage } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(session ? { session } : {}),
      }
      finalResult = result
      return result
    } catch (err) {
      const endTime = new Date()
      const result: AgentResult = {
        agentId: agent.id,
        agentName: agent.name,
        // An abort is a cancellation, not a failure: the team stopped because it
        // was told to, and the roster must not paint every agent as broken.
        status: isAbortError(err) ? "cancelled" : "failed",
        output,
        duration: endTime.getTime() - startTime.getTime(),
        attempts,
        error: (err as Error).message,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        model,
        ...(session ? { session } : {}),
      }
      finalResult = result
      return result
    } finally {
      try {
        if (!this.sessionManager) await manager.close()
      } catch (error) {
        if (finalResult) {
          finalResult.status = "failed"
          finalResult.error =
            (finalResult.error ? finalResult.error + "; " : "") +
            "Session cleanup failed: " +
            String(error)
        }
      } finally {
        if (finalResult && session) finalResult.session = session
        offSession()
        if (finalResult)
          this.eventBus.emit({
            type:
              finalResult.status === "success"
                ? "agent:complete"
                : finalResult.status === "handed_back"
                  ? "agent:handed-back"
                  : "agent:failed",
            timestamp: finalResult.endTime,
            payload: finalResult,
          })
      }
    }
  }

  /**
   * Publish one chunk of agent output.
   *
   * `kind` is omitted for text so the payload shape is unchanged for every
   * consumer written before tool activity was surfaced.
   */
  private emitOutput(agentId: string, chunk: string, kind?: OutputKind): void {
    this.eventBus.emit({
      type: "agent:output",
      timestamp: new Date().toISOString(),
      payload: { agentId, chunk, ...(kind ? { kind } : {}) },
    })
  }
}
