import * as fs from "fs"
import * as path from "path"
import type { MultiClawConfig, OrchestratorResult } from "../types/config"
import type { AgentDefinition, AgentResult } from "../types/agent"
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
    const stages = buildStages(agents)

    const stageInfos: StageInfo[] = stages.map((stage, i) => ({
      stageIndex: i,
      agents: stage.map((a) => ({ id: a.id, name: a.name, icon: a.icon })),
    }))

    this.eventBus.emit({
      type: "orchestration:start",
      timestamp: new Date().toISOString(),
      payload: { name: this.config.name, totalAgents: agents.length, stages: stageInfos },
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
    if (!this.config.leader) return this.config.agents

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
}
