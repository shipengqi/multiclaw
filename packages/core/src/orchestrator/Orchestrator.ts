import * as fs from "fs"
import * as path from "path"
import type { MultiClawConfig, OrchestratorResult } from "../types/config"
import type { AgentDefinition, AgentResult, TaskPlan } from "../types/agent"
import type { StageInfo } from "../types/event"
import { EventBus } from "../event/EventBus"
import { ContextManager } from "./ContextManager"
import { AgentRunner } from "./AgentRunner"
import { buildStages } from "./StageBuilder"

export class Orchestrator {
  readonly eventBus = new EventBus()
  private contextManager: ContextManager
  private runner: AgentRunner
  private workDir: string

  constructor(private config: MultiClawConfig) {
    this.workDir = path.resolve(config.workDir)
    fs.mkdirSync(this.workDir, { recursive: true })
    this.contextManager = new ContextManager(config.context)
    this.runner = new AgentRunner(this.eventBus, this.contextManager, this.workDir)
  }

  async run(): Promise<OrchestratorResult> {
    const startTime = new Date()
    const agents = await this.resolveAgents()
    this.contextManager.set(
      "pipelineAgents",
      agents.map((a) => `${a.id}: ${a.name}`).join("\n")
    )

    let stages = buildStages(agents)

    const getModel = (agent: AgentDefinition): string | undefined => {
      return agent.model ?? agent.models?.[agent.runtime ?? "claude"]
    }

    const stageInfos: StageInfo[] = stages.map((stage, i) => ({
      stageIndex: i,
      agents: stage.map((a) => ({ id: a.id, name: a.name, icon: a.icon, model: getModel(a), taskTitle: a.taskTitle })),
    }))

    this.eventBus.emit({
      type: "orchestration:start",
      timestamp: new Date().toISOString(),
      payload: { name: this.config.name, requirement: this.config.context?.requirement, totalAgents: agents.length, stages: stageInfos },
    })

    const results: AgentResult[] = []
    let allSuccess = true

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]

      this.eventBus.emit({
        type: "stage:start", timestamp: new Date().toISOString(),
        payload: { stageIndex: i, agentIds: stage.map((a) => a.id) },
      })

      const stageResults = await this.runStage(stage)
      results.push(...stageResults)

      // After architect stage completes, apply task plan and rebuild stages
      if (i === 0 && stage.some((a) => a.id === "architect") && stageResults.some((r) => r.status === "success")) {
        await this.applyTaskPlan(agents)
        stages = buildStages(agents)
      }

      for (const r of stageResults) {
        if (r.status !== "success") {
          allSuccess = false
          if (!this.config.continueOnError) break
        }
      }

      this.eventBus.emit({
        type: "stage:complete", timestamp: new Date().toISOString(),
        payload: { stageIndex: i },
      })

      if (!allSuccess && !this.config.continueOnError) {
        for (const remainingStage of stages.slice(i + 1)) {
          for (const agent of remainingStage) {
            this.eventBus.emit({
              type: "agent:skipped",
              timestamp: new Date().toISOString(),
              payload: { agentId: agent.id, agentName: agent.name, icon: agent.icon },
            })
          }
        }
        break
      }
    }

    const endTime = new Date()
    const result: OrchestratorResult = {
      name: this.config.name, success: allSuccess,
      totalDuration: endTime.getTime() - startTime.getTime(),
      agentResults: results,
      startTime: startTime.toISOString(), endTime: endTime.toISOString(),
    }

    this.eventBus.emit({
      type: "orchestration:complete", timestamp: new Date().toISOString(), payload: result,
    })
    return result
  }

  private async resolveAgents(): Promise<AgentDefinition[]> {
    if (!this.config.leader || this.config.useLeader === false) return this.config.agents

    this.contextManager.set(
      "availableAgents",
      this.config.agents.map((a) => `${a.id}: ${a.name}`).join("\n")
    )

    const result = await this.runner.run(this.config.leader)
    if (result.status !== "success") return this.config.agents

    const match = result.output.match(/\{[\s\S]*?"run"\s*:\s*\[[\s\S]*?\]\s*\}/)
    if (!match) return this.config.agents

    let plan: { run: string[] }
    try { plan = JSON.parse(match[0]) } catch { return this.config.agents }

    const runSet = new Set(plan.run)
    const skippedIds = new Set(
      this.config.agents.filter((a) => !runSet.has(a.id)).map((a) => a.id)
    )

    for (const agent of this.config.agents.filter((a) => skippedIds.has(a.id))) {
      this.eventBus.emit({
        type: "agent:skipped",
        timestamp: new Date().toISOString(),
        payload: { agentId: agent.id, agentName: agent.name, icon: agent.icon },
      })
    }

    return this.config.agents
      .filter((a) => runSet.has(a.id))
      .map((a) => ({
        ...a,
        dependsOn: a.dependsOn?.filter((dep) => !skippedIds.has(dep)),
      }))
  }

  private async runStage(agents: AgentDefinition[]): Promise<AgentResult[]> {
    const { maxConcurrency } = this.config
    if (!maxConcurrency || agents.length <= maxConcurrency) {
      return Promise.all(agents.map((a) => this.runner.run(a)))
    }
    const results: AgentResult[] = []
    for (let i = 0; i < agents.length; i += maxConcurrency) {
      const batch = agents.slice(i, i + maxConcurrency)
      results.push(...(await Promise.all(batch.map((a) => this.runner.run(a)))))
    }
    return results
  }

  private async applyTaskPlan(agents: AgentDefinition[]): Promise<void> {
    try {
      const taskPlanPath = path.join(this.workDir, "task-plan.json")
      if (!fs.existsSync(taskPlanPath)) return

      const content = fs.readFileSync(taskPlanPath, "utf-8")
      const taskPlan: TaskPlan = JSON.parse(content)

      const taskMap = new Map(taskPlan.tasks.map((t) => [t.id, t]))
      for (const agent of agents) {
        const task = taskMap.get(agent.id)
        if (task) {
          agent.taskTitle = task.title
          agent.dependsOn = task.dependsOn
        }
      }
    } catch {
      // Silently ignore parsing errors
    }
  }
}
