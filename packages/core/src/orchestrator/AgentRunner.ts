import * as fs from "fs"
import * as path from "path"
import type { AgentDefinition, AgentResult } from "../types/agent"
import { runtimeRegistry } from "../runtime"
import { EventBus } from "../event/EventBus"
import { ContextManager } from "./ContextManager"
import { withRetry } from "../utils/retry"
import { withTimeout } from "../utils/timeout"
import { renderPrompt } from "../utils/prompt"

export class AgentRunner {
  constructor(
    private eventBus: EventBus,
    private contextManager: ContextManager,
    private globalWorkDir: string
  ) {}

  async run(agent: AgentDefinition): Promise<AgentResult> {
    const startTime = new Date()
    const workDir = agent.workDir
      ? path.resolve(this.globalWorkDir, agent.workDir)
      : this.globalWorkDir
    fs.mkdirSync(workDir, { recursive: true })

    const runtime = runtimeRegistry.get(agent.runtime ?? "claude")
    const retries = agent.retries ?? 0
    const timeout = agent.timeout ?? 600_000
    const tools = agent.tools ?? ["Read", "Write", "Bash"]

    this.eventBus.emit({
      type: "agent:start",
      timestamp: new Date().toISOString(),
      payload: { agentId: agent.id, agentName: agent.name, icon: agent.icon },
    })

    let attempts = 0
    let output = ""

    try {
      output = await withTimeout(
        (signal) => withRetry(async (attempt) => {
          attempts = attempt
          const prompt = await renderPrompt(
            agent.taskPrompt,
            this.contextManager.snapshot(),
            this.globalWorkDir
          )
          return (await runtime.execute({
            agentId: agent.id,
            systemPrompt: agent.systemPrompt,
            prompt, tools, workDir, timeout, signal,
            onOutput: (chunk) => {
              this.eventBus.emit({
                type: "agent:output",
                timestamp: new Date().toISOString(),
                payload: { agentId: agent.id, chunk },
              })
            },
          })).output
        }, retries, (attempt, err) => {
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
        }),
        timeout,
        agent.name
      )

      const endTime = new Date()
      const result: AgentResult = {
        agentId: agent.id, agentName: agent.name, status: "success",
        output, duration: endTime.getTime() - startTime.getTime(),
        attempts, startTime: startTime.toISOString(), endTime: endTime.toISOString(),
      }
      this.eventBus.emit({
        type: "agent:complete", timestamp: new Date().toISOString(), payload: result,
      })
      return result
    } catch (err) {
      const endTime = new Date()
      const result: AgentResult = {
        agentId: agent.id, agentName: agent.name, status: "failed",
        output, duration: endTime.getTime() - startTime.getTime(),
        attempts, error: (err as Error).message,
        startTime: startTime.toISOString(), endTime: endTime.toISOString(),
      }
      this.eventBus.emit({
        type: "agent:failed", timestamp: new Date().toISOString(), payload: result,
      })
      return result
    }
  }
}

