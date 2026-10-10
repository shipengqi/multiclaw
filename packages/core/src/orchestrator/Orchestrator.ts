import * as fs from "node:fs"
import * as path from "node:path"
import { EventBus } from "../event/EventBus"
import type { AgentDefinition, AgentResult, TaskPlan } from "../types/agent"
import type { MultiClawConfig, OrchestratorResult } from "../types/config"
import type { StageInfo } from "../types/event"
import type { LeaderMessage } from "../types/leader"
import { parseLeaderDecision } from "../utils/leaderDecision"
import { AgentRunner } from "./AgentRunner"
import { ContextManager } from "./ContextManager"
import { buildStages } from "./StageBuilder"

/**
 * What one turn resolved to before any pipeline exists.
 *
 * `message` is the branch that keeps a "hello" from costing a full run: the
 * leader answered in words, so the turn ends there.
 */
type Resolution =
  | { kind: "run"; agents: AgentDefinition[] }
  | { kind: "message"; mode: LeaderMessage["mode"]; message: string }

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

  async run(options: { signal?: AbortSignal } = {}): Promise<OrchestratorResult> {
    const startTime = new Date()
    this.clearStaleTaskPlan()
    const resolution = await this.resolveTurn(options.signal)

    if (resolution.kind === "message") {
      return this.finishWithMessage(resolution.mode, resolution.message, startTime)
    }

    const agents = resolution.agents

    // A leader can only *subtract* from the configured team, so an empty result
    // means it named nothing we recognise. Falling through would run zero stages
    // and report success — a green "done" for a turn in which nobody worked.
    if (agents.length === 0) return this.finishEmpty(startTime)

    this.contextManager.set("pipelineAgents", agents.map((a) => `${a.id}: ${a.name}`).join("\n"))

    let stages = buildStages(agents)

    const getModel = (agent: AgentDefinition): string | undefined => {
      return agent.model ?? agent.models?.[agent.runtime ?? "claude"]
    }

    const stageInfos: StageInfo[] = stages.map((stage, i) => ({
      stageIndex: i,
      agents: stage.map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.icon,
        model: getModel(a),
        description: a.description,
        taskTitle: a.taskTitle,
      })),
    }))

    this.eventBus.emit({
      type: "orchestration:start",
      timestamp: new Date().toISOString(),
      payload: {
        name: this.config.name,
        requirement: this.config.context?.requirement,
        totalAgents: agents.length,
        stages: stageInfos,
      },
    })

    const results: AgentResult[] = []
    let allSuccess = true

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]

      this.eventBus.emit({
        type: "stage:start",
        timestamp: new Date().toISOString(),
        payload: { stageIndex: i, agentIds: stage.map((a) => a.id) },
      })

      const stageResults = await this.runStage(stage, options.signal)
      results.push(...stageResults)

      // Cancelled mid-stage: stop scheduling further stages and fall through to
      // the completion result rather than emitting a misleading stage:complete.
      if (options.signal?.aborted) break

      // After architect stage completes, apply task plan and rebuild stages
      if (
        i === 0 &&
        stage.some((a) => a.id === "architect") &&
        stageResults.some((r) => r.status === "success")
      ) {
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
        type: "stage:complete",
        timestamp: new Date().toISOString(),
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
      name: this.config.name,
      success: allSuccess,
      totalDuration: endTime.getTime() - startTime.getTime(),
      agentResults: results,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    }

    this.eventBus.emit({
      type: "orchestration:complete",
      timestamp: new Date().toISOString(),
      payload: result,
    })
    return result
  }

  /**
   * Drop last run's task plan before the architect gets a chance to write one.
   *
   * The console runs every turn against the same workspace, so the plan file
   * survives between turns. If a turn's architect fails to write a new one,
   * `applyTaskPlan` would silently re-apply the previous turn's titles, scopes
   * and dependencies to a completely different requirement.
   */
  private clearStaleTaskPlan(): void {
    // `force` makes the normal case — a workspace with no plan in it — a no-op
    // rather than a stat followed by a delete.
    fs.rmSync(path.join(this.workDir, "task-plan.json"), { force: true })
  }

  /**
   * Decide what this turn is: a pipeline, an answer, or a question.
   *
   * Only the leader can answer that, so without one the configured team is the
   * whole story. With one, its prose output is *not* a failure mode to be papered
   * over by running everybody — a leader that answers a greeting has done its
   * job, and that is what `message` records.
   */
  private async resolveTurn(signal?: AbortSignal): Promise<Resolution> {
    if (!this.config.leader || this.config.useLeader === false) {
      return { kind: "run", agents: this.config.agents }
    }

    this.contextManager.set(
      "availableAgents",
      this.config.agents.map((a) => `${a.id}: ${a.name}`).join("\n")
    )

    const result = await this.runner.run(this.config.leader, signal)
    if (result.status !== "success") {
      // The leader is infrastructure, not the task. Losing it is worth saying out
      // loud, but the requirement itself may still be perfectly runnable.
      this.warn("The leader could not be reached — running the full configured team.")
      return { kind: "run", agents: this.config.agents }
    }

    const decision = parseLeaderDecision(result.output)
    if (decision) {
      if (decision.mode !== "run") {
        return { kind: "message", mode: decision.mode, message: decision.message }
      }
      return { kind: "run", agents: this.selectAgents(decision.run) }
    }

    // No plan at all. The leader answered in prose, and that prose *is* the
    // answer — running every configured agent on the strength of a "hello" is
    // precisely what this branch exists to prevent.
    const message = result.output.trim()
    if (!message) {
      this.warn("The leader returned no output — running the full configured team.")
      return { kind: "run", agents: this.config.agents }
    }
    return { kind: "message", mode: "reply", message }
  }

  /**
   * Narrow the configured team to the ids the leader named.
   *
   * Always a subset: an id that is not in the config is reported and dropped
   * rather than added, so a typo in a prompt cannot conjure an agent that has no
   * definition behind it.
   */
  private selectAgents(run: string[]): AgentDefinition[] {
    const runSet = new Set(run)
    const known = new Set(this.config.agents.map((a) => a.id))

    // The leader is told to pick from the configured list, but a model can still
    // name something that is not there. Dropping it in silence makes a typo in a
    // prompt indistinguishable from a deliberate decision to skip.
    for (const id of run) {
      if (!known.has(id)) {
        this.warn(`The leader named "${id}", which is not in the config — ignoring it.`)
      }
    }

    const skippedIds = new Set(this.config.agents.filter((a) => !runSet.has(a.id)).map((a) => a.id))

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

  private async runStage(agents: AgentDefinition[], signal?: AbortSignal): Promise<AgentResult[]> {
    const { maxConcurrency } = this.config
    if (!maxConcurrency || agents.length <= maxConcurrency) {
      return Promise.all(agents.map((a) => this.runner.run(a, signal)))
    }
    const results: AgentResult[] = []
    for (let i = 0; i < agents.length; i += maxConcurrency) {
      const batch = agents.slice(i, i + maxConcurrency)
      results.push(...(await Promise.all(batch.map((a) => this.runner.run(a, signal)))))
    }
    return results
  }

  private async applyTaskPlan(agents: AgentDefinition[]): Promise<void> {
    const taskPlanPath = path.join(this.workDir, "task-plan.json")
    if (!fs.existsSync(taskPlanPath)) return

    let taskPlan: TaskPlan
    try {
      taskPlan = JSON.parse(fs.readFileSync(taskPlanPath, "utf-8")) as TaskPlan
    } catch (err) {
      // The architect produced a task-plan.json but we cannot read it. Running
      // the original agent set is a reasonable degradation — but it must not be
      // silent, otherwise a broken plan is indistinguishable from a missing one.
      this.warn(
        `Could not parse task-plan.json — continuing with the original agent set: ${errorMessage(err)}`
      )
      return
    }

    if (!Array.isArray(taskPlan.tasks)) {
      this.warn("task-plan.json has no `tasks` array — ignoring it.")
      return
    }

    const taskMap = new Map(taskPlan.tasks.map((t) => [t.id, t]))
    for (const agent of agents) {
      const task = taskMap.get(agent.id)
      if (task) {
        agent.taskTitle = task.title
        agent.dependsOn = task.dependsOn
        agent.agentScope = task.scope
        if (task.plan?.length) {
          agent.agentPlan = task.plan.map((s, i) => `${i + 1}. ${s}`).join("\n")
        }
      }
    }
  }

  /**
   * Close out a turn the leader answered rather than planned.
   *
   * `success: true` on purpose: the user asked something and got an answer. What
   * keeps that from reading as a completed pipeline is `reply`, which the console
   * uses to say "answered" instead of "done".
   */
  private finishWithMessage(
    mode: LeaderMessage["mode"],
    message: string,
    startTime: Date
  ): OrchestratorResult {
    const endTime = new Date()
    const result: OrchestratorResult = {
      name: this.config.name,
      success: true,
      totalDuration: endTime.getTime() - startTime.getTime(),
      agentResults: [],
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      reply: { mode, message },
    }

    this.eventBus.emit({
      type: "orchestration:complete",
      timestamp: endTime.toISOString(),
      payload: result,
    })
    return result
  }

  private warn(message: string): void {
    this.eventBus.emit({
      type: "orchestration:warning",
      timestamp: new Date().toISOString(),
      payload: { message },
    })
  }

  /**
   * Close out a turn that scheduled no agents.
   *
   * Reported as a failure rather than a no-op: the user asked for work, and the
   * only honest outcome is to say that none was done. Running the whole team
   * instead would contradict the leader's explicit choice.
   */
  private finishEmpty(startTime: Date): OrchestratorResult {
    const usedLeader = this.config.leader !== undefined && this.config.useLeader !== false
    this.warn(
      usedLeader
        ? "The leader selected none of the configured agents — nothing to run."
        : "The config lists no agents — nothing to run."
    )

    const endTime = new Date()
    const result: OrchestratorResult = {
      name: this.config.name,
      success: false,
      totalDuration: endTime.getTime() - startTime.getTime(),
      agentResults: [],
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    }

    this.eventBus.emit({
      type: "orchestration:complete",
      timestamp: endTime.toISOString(),
      payload: result,
    })
    return result
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
