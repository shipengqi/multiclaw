import * as fs from "node:fs"
import * as path from "node:path"
import type { EventBus } from "../event/EventBus"
import { resolveArgs, resolveCommand, resolveModel } from "../providers/resolve"
import { runtimeRegistry } from "../runtime"
import type { AgentDefinition, AgentResult } from "../types/agent"
import type { MultiClawConfig } from "../types/config"
import { renderPrompt } from "../utils/prompt"
import { withRetry } from "../utils/retry"
import { withTimeout } from "../utils/timeout"
import type { ContextManager } from "./ContextManager"

export class AgentRunner {
  constructor(
    private eventBus: EventBus,
    private contextManager: ContextManager,
    private globalWorkDir: string,
    private config: MultiClawConfig
  ) {}

  async run(agent: AgentDefinition, signal?: AbortSignal): Promise<AgentResult> {
    const startTime = new Date()
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
      const tools = agent.tools ?? ["Read", "Write", "Bash"]

      output = await withTimeout(
        (innerSignal) =>
          withRetry(
            async (attempt) => {
              attempts = attempt
              const agentContext: Record<string, string> = {
                ...this.contextManager.snapshot(),
                // Every built-in task template references both. The leader only
                // fills them in when the architect wrote a plan entry for this
                // agent, and the no-leader path has no plan at all — so without a
                // default the model is handed the literal text `{{agentScope}}`
                // and has to guess what it was supposed to say.
                agentScope: agent.agentScope ?? "Not narrowed down — cover the whole task.",
                agentPlan:
                  agent.agentPlan ?? "No step-by-step plan was provided — use your judgement.",
              }
              const prompt = await renderPrompt(agent.taskPrompt, agentContext, this.globalWorkDir)
              return (
                await runtime.execute({
                  agentId: agent.id,
                  systemPrompt: agent.systemPrompt,
                  prompt,
                  tools,
                  workDir,
                  timeout,
                  signal: innerSignal,
                  model,
                  // Resolve through provider/defaults exactly as the CLI's
                  // availability gate does — an agent that pins `provider` (or
                  // leans on `defaults`) must launch that provider's bridge, not
                  // the runtime's built-in default. Passing the raw `agent.command`
                  // here sent a `provider: "claude"` config straight to `opencode`.
                  command: resolveCommand(agent, this.config),
                  args: resolveArgs(agent, this.config),
                  onEvent: (e) => {
                    // Only text reaches the TUI's stream pane. Tool calls, usage
                    // and cost are carried by the runtime event but the bus
                    // surface is unchanged, so the console needs no changes.
                    if (
                      (e.type === "message_delta" || e.type === "message") &&
                      e.role === "agent" &&
                      e.text
                    ) {
                      this.eventBus.emit({
                        type: "agent:output",
                        timestamp: new Date().toISOString(),
                        payload: { agentId: agent.id, chunk: e.text },
                      })
                    }
                  },
                })
              ).output
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
            2000,
            innerSignal
          ),
        timeout,
        agent.name,
        signal
      )

      const endTime = new Date()
      const result: AgentResult = {
        agentId: agent.id,
        agentName: agent.name,
        status: "success",
        output,
        duration: endTime.getTime() - startTime.getTime(),
        attempts,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      }
      this.eventBus.emit({
        type: "agent:complete",
        timestamp: new Date().toISOString(),
        payload: result,
      })
      return result
    } catch (err) {
      const endTime = new Date()
      const result: AgentResult = {
        agentId: agent.id,
        agentName: agent.name,
        status: "failed",
        output,
        duration: endTime.getTime() - startTime.getTime(),
        attempts,
        error: (err as Error).message,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      }
      this.eventBus.emit({
        type: "agent:failed",
        timestamp: new Date().toISOString(),
        payload: result,
      })
      return result
    }
  }
}
