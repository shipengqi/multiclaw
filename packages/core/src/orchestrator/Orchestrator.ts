import * as fs from "node:fs"
import * as path from "node:path"
import { validateToolsPolicy } from "../config/toolsPolicy"
import { EventBus } from "../event/EventBus"
import { resolveModel } from "../providers/resolve"
import type { AgentDefinition, AgentResult, TaskPlan } from "../types/agent"
import type {
  AcceptanceResult,
  MultiClawConfig,
  OrchestrationPreview,
  OrchestratorResult,
  ReviewVerdict,
} from "../types/config"
import type { StageInfo } from "../types/event"
import type { LeaderMessage } from "../types/leader"
import { renderConversation } from "../utils/conversation"
import { parseLeaderDecision } from "../utils/leaderDecision"
import { renderUpstreamOutputs } from "../utils/upstream"
import { AgentRunner } from "./AgentRunner"
import type { AgentSessionManager } from "./AgentSessionManager"
import { ContextManager } from "./ContextManager"
import { buildStages } from "./StageBuilder"

/**
 * What one turn resolved to before any pipeline exists.
 *
 * `message` is the branch that keeps a "hello" from costing a full run: the
 * leader answered in words, so the turn ends there.
 */
type Resolution =
  | { kind: "run"; agents: AgentDefinition[]; reason?: string }
  | { kind: "message"; mode: LeaderMessage["mode"]; message: string }
  | { kind: "cancelled" }

export class Orchestrator {
  readonly eventBus = new EventBus()
  private contextManager: ContextManager
  private runner: AgentRunner
  private workDir: string

  constructor(
    private config: MultiClawConfig,
    sessions?: AgentSessionManager
  ) {
    this.workDir = path.resolve(config.workDir)
    fs.mkdirSync(this.workDir, { recursive: true })
    this.contextManager = new ContextManager(config.context)
    // Set unconditionally, including to "": the leader's template carries the
    // placeholder, and a context key that was never set leaves the literal
    // `{{conversation}}` in the prompt for the model to read.
    this.contextManager.set("conversation", renderConversation(config.history))
    // Set unconditionally, including to "": the built-in task templates carry the
    // placeholder, and a context key that was never set leaves the literal
    // `{{upstreamOutputs}}` in the prompt for the model to read.
    this.contextManager.set("upstreamOutputs", "")
    this.runner = new AgentRunner(
      this.eventBus,
      this.contextManager,
      this.workDir,
      config,
      sessions
    )
  }

  async preview(options: { signal?: AbortSignal } = {}): Promise<OrchestrationPreview> {
    if (options.signal?.aborted)
      return { name: this.config.name, totalAgents: 0, stages: [], ...this.requirementField() }
    const policyError = this.reviewPolicyError()
    if (policyError) throw new Error(policyError)
    try {
      await validateToolsPolicy(this.config, options)
    } catch (error) {
      if (options.signal?.aborted)
        return { name: this.config.name, totalAgents: 0, stages: [], ...this.requirementField() }
      throw error
    }
    if (options.signal?.aborted)
      return { name: this.config.name, totalAgents: 0, stages: [], ...this.requirementField() }
    this.prepareTaskPlan()
    const resolution = await this.resolveTurn(options.signal)
    if (resolution.kind === "cancelled" || options.signal?.aborted) {
      return { name: this.config.name, totalAgents: 0, stages: [], ...this.requirementField() }
    }
    if (resolution.kind === "message") {
      return {
        name: this.config.name,
        totalAgents: 0,
        stages: [],
        reply: { mode: resolution.mode, message: resolution.message },
        ...this.requirementField(),
      }
    }

    const agents = resolution.agents
    this.contextManager.set("pipelineAgents", agents.map((a) => `${a.id}: ${a.name}`).join("\n"))
    const stages = this.buildStagesOrFallback(agents, "Could not order the configured agents")
    const reviewer = this.config.agents.find((agent) => agent.id === this.config.review?.reviewer)
    if (reviewer && agents.length) stages.push([reviewer])
    const stageInfos = this.stageInfos(stages)
    return {
      name: this.config.name,
      totalAgents: agents.length + (reviewer && agents.length ? 1 : 0),
      stages: stageInfos,
      ...this.reasonField(resolution.reason),
      ...this.requirementField(),
    }
  }

  async run(options: { signal?: AbortSignal } = {}): Promise<OrchestratorResult> {
    const startTime = new Date()
    if (options.signal?.aborted) return this.finishCancelled(startTime)
    const policyError = this.reviewPolicyError()
    if (policyError) {
      this.warn(policyError)
      const result = this.finishEmpty(startTime, {
        status: "failed",
        reviewer: this.config.review?.reviewer ?? "",
        repairRounds: 0,
        reviews: [],
        reason: policyError,
      })
      return result
    }
    try {
      await validateToolsPolicy(this.config, options)
    } catch (error) {
      if (options.signal?.aborted) return this.finishCancelled(startTime)
      this.warn(errorMessage(error))
      return this.finishEmpty(startTime, undefined, false)
    }
    if (options.signal?.aborted) return this.finishCancelled(startTime)
    this.prepareTaskPlan()
    const resolution = await this.resolveTurn(options.signal)
    if (resolution.kind === "cancelled" || options.signal?.aborted) {
      return this.finishCancelled(startTime)
    }

    if (resolution.kind === "message") {
      return this.finishWithMessage(resolution.mode, resolution.message, startTime)
    }

    const agents = resolution.agents
    // No planner stage runs in a resumed turn, so nothing would re-apply the
    // plan that describes the very task being continued. Without this every
    // retried agent is handed the generic "no plan was provided" fallback.
    if (this.config.resume) this.applyResumeTaskPlan(agents)

    // A leader can only *subtract* from the configured team, so an empty result
    // means it named nothing we recognise. Falling through would run zero stages
    // and report success — a green "done" for a turn in which nobody worked.
    if (agents.length === 0)
      return this.finishEmpty(
        startTime,
        this.config.review
          ? {
              status: "failed",
              reviewer: this.config.review.reviewer,
              repairRounds: 0,
              reviews: [],
              reason: "No worker was selected for the review-gated task.",
            }
          : undefined
      )

    this.contextManager.set("pipelineAgents", agents.map((a) => `${a.id}: ${a.name}`).join("\n"))

    let stages = this.buildStagesOrFallback(agents, "Could not order the configured agents")
    const toStageInfos = (list: AgentDefinition[][]): StageInfo[] => this.stageInfos(list)

    this.eventBus.emit({
      type: "orchestration:start",
      timestamp: new Date().toISOString(),
      payload: {
        name: this.config.name,
        requirement: this.contextManager.get("requirement"),
        totalAgents: agents.length,
        stages: toStageInfos(stages),
        ...this.reasonField(resolution.reason),
      },
    })

    const results: AgentResult[] = []
    let allSuccess = true
    let cancelled = false
    // Guards the task-plan application to the first stage that runs the planner.
    // Keying off the planner's *position* instead of "stage 0" is the whole
    // point: a preset can put a product-manager first and the architect second,
    // and the old `i === 0` test silently skipped the plan for every such team.
    let planApplied = false
    const executedIds = new Set<string>()

    for (let i = 0; i < stages.length; i++) {
      if (options.signal?.aborted) {
        cancelled = true
        allSuccess = false
        break
      }
      const stage = stages[i]

      this.eventBus.emit({
        type: "stage:start",
        timestamp: new Date().toISOString(),
        payload: { stageIndex: i, agentIds: stage.map((a) => a.id) },
      })

      const stageResults = await this.runStage(stage, options.signal)
      results.push(...stageResults)
      for (const result of stageResults) executedIds.add(result.agentId)

      // Hand the next stage what this one produced. Only what succeeded: a
      // failed agent's partial output is not a conclusion a downstream agent
      // should build on. Set before the abort check so the loop's invariant —
      // "the context reflects every completed stage" — holds on every exit.
      this.contextManager.set(
        "upstreamOutputs",
        renderUpstreamOutputs(
          results
            .filter((r) => r.status === "success")
            .map((r) => ({ agentId: r.agentId, name: r.agentName, output: r.output }))
        )
      )

      // Cancelled mid-stage: stop scheduling further stages and fall through to
      // the completion result rather than emitting a misleading stage:complete.
      // Both flags are needed — `AgentRunner` records an abort as `cancelled`
      // (not `failed`), and `cancelled` is still not a `success`, so leaving
      // `allSuccess` alone here would report a cancelled run as a success and
      // make the CLI exit 0 on Ctrl-C.
      if (options.signal?.aborted || stageResults.some((r) => r.status === "cancelled")) {
        cancelled = true
        allSuccess = false
        break
      }

      // After the planner's stage completes, apply the task plan and rebuild the
      // stages. The planner is not always stage 0 — a preset may front-load a
      // product-manager — so the trigger is "the first stage that ran a planner",
      // not a fixed index.
      if (
        !planApplied &&
        stage.some((a) => this.isPlanner(a)) &&
        stageResults.some(
          (r) =>
            r.status === "success" && stage.some((a) => a.id === r.agentId && this.isPlanner(a))
        )
      ) {
        planApplied = true
        await this.applyTaskPlan(agents, executedIds)
        const remaining = agents
          .filter((a) => !executedIds.has(a.id))
          .map((a) => ({
            ...a,
            dependsOn: a.dependsOn?.filter((dep) => !executedIds.has(dep)),
          }))
        const rebuilt = this.buildStagesOrFallback(
          remaining,
          "The task plan's dependencies could not be satisfied"
        )
        // Completed stages are immutable history; their dependencies are satisfied.
        stages = [...stages.slice(0, i + 1), ...rebuilt]
        // The plan regrouped the team, and the console drew the pre-plan
        // grouping from the `orchestration:start` above. Publishing the new
        // stages is what keeps what is on screen matching what actually runs.
        this.eventBus.emit({
          type: "orchestration:stages",
          timestamp: new Date().toISOString(),
          payload: { totalAgents: agents.length, stages: toStageInfos(stages) },
        })
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

    let acceptance: AcceptanceResult | undefined
    if (this.config.review) {
      acceptance = await this.reviewDelivery(
        agents,
        results,
        stages,
        allSuccess,
        cancelled,
        options.signal
      )
      cancelled ||= acceptance.status === "cancelled"
      allSuccess = allSuccess && acceptance.status === "approved"
    }

    const endTime = new Date()
    // Only agents that reported a cost contribute; when none did, the field is
    // absent rather than 0 — "no data" is not the same as "free".
    const totalCostUsd = sumCosts(results)
    const result: OrchestratorResult = {
      name: this.config.name,
      success: allSuccess,
      ...(acceptance ? { acceptance } : {}),
      totalDuration: endTime.getTime() - startTime.getTime(),
      agentResults: results,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      ...(cancelled ? { cancelled: true } : {}),
      ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      ...this.reasonField(resolution.reason),
      ...this.requirementField(),
    }

    this.eventBus.emit({
      type: "orchestration:complete",
      timestamp: new Date().toISOString(),
      payload: result,
    })
    return result
  }

  private reviewPolicyError(): string | undefined {
    const policy = this.config.review
    if (!policy) return undefined
    const ids = this.config.agents.map((agent) => agent.id)
    if (new Set(ids).size !== ids.length) return "Review policy requires unique agent ids."
    if (!ids.includes(policy.reviewer) || policy.reviewer === this.config.leader?.id) {
      return "Review policy must name a configured non-leader reviewer."
    }
    if (
      !Array.isArray(policy.repairAgents) ||
      !policy.repairAgents.length ||
      new Set(policy.repairAgents).size !== policy.repairAgents.length ||
      policy.repairAgents.some(
        (id) => !ids.includes(id) || id === policy.reviewer || id === this.config.leader?.id
      )
    ) {
      return "Review policy must name unique configured repair workers, excluding the reviewer and leader."
    }
    const limit = policy.maxRepairRounds ?? 1
    if (!Number.isInteger(limit) || limit < 0 || limit > 5) {
      return "Review policy maxRepairRounds must be an integer from 0 to 5."
    }
    return undefined
  }

  private async reviewDelivery(
    agents: AgentDefinition[],
    results: AgentResult[],
    stages: AgentDefinition[][],
    executionSuccess: boolean,
    cancelled: boolean,
    signal?: AbortSignal
  ): Promise<AcceptanceResult> {
    const policy = this.config.review
    if (!policy) throw new Error("Delivery review requires a configured policy.")
    const acceptance: AcceptanceResult = {
      status: "failed",
      reviewer: policy.reviewer,
      repairRounds: 0,
      reviews: [],
    }
    if (cancelled || signal?.aborted) return { ...acceptance, status: "cancelled" }
    if (!executionSuccess)
      return { ...acceptance, reason: "Pipeline execution failed; delivery was not reviewed." }
    const reviewer = this.config.agents.find((agent) => agent.id === policy.reviewer)
    if (!reviewer) return { ...acceptance, reason: "Configured reviewer is unavailable." }
    const repairs = agents.filter((agent) => policy.repairAgents.includes(agent.id))
    const repairIds = new Set(repairs.map((agent) => agent.id))
    const repairStages = this.buildStagesOrFallback(
      repairs.map((agent) => ({
        ...agent,
        dependsOn: agent.dependsOn?.filter((id) => repairIds.has(id)),
      })),
      "Could not order repair workers"
    ).flatMap((stage) => stage.map((agent) => [agent]))
    let stageIndex = stages.length
    const execute = async (stage: AgentDefinition[], instruction: string): Promise<boolean> => {
      if (signal?.aborted) {
        acceptance.status = "cancelled"
        return false
      }
      stages.push(stage)
      this.eventBus.emit({
        type: "orchestration:stages",
        timestamp: new Date().toISOString(),
        payload: {
          totalAgents: new Set(stages.flat().map((agent) => agent.id)).size,
          stages: this.stageInfos(stages),
        },
      })
      const index = stageIndex++
      this.eventBus.emit({
        type: "stage:start",
        timestamp: new Date().toISOString(),
        payload: { stageIndex: index, agentIds: stage.map((agent) => agent.id) },
      })
      // Repairs run sequentially to avoid overlapping edits in the shared workspace.
      for (const agent of stage) {
        if (signal?.aborted) {
          acceptance.status = "cancelled"
          return false
        }
        const result = await this.runner.run(
          agent,
          signal,
          `${instruction}\n\n## Latest worker outputs\n${this.contextManager.get("upstreamOutputs") ?? ""}`
        )
        results.push(result)
        // Repeated agents replace their earlier upstream output, not their audit results.
        const latest = new Map<string, AgentResult>()
        for (const item of results) latest.set(item.agentId, item)
        this.contextManager.set(
          "upstreamOutputs",
          renderUpstreamOutputs(
            [...latest.values()]
              .filter((item) => item.status === "success" && item.agentId !== policy.reviewer)
              .map((item) => ({ agentId: item.agentId, name: item.agentName, output: item.output }))
          )
        )
        if (result.status !== "success" || signal?.aborted) {
          acceptance.status =
            result.status === "cancelled" || signal?.aborted ? "cancelled" : "failed"
          acceptance.reason = result.error ?? `${agent.name} did not complete.`
          return false
        }
      }
      this.eventBus.emit({
        type: "stage:complete",
        timestamp: new Date().toISOString(),
        payload: { stageIndex: index },
      })
      return true
    }
    while (true) {
      if (
        !(await execute(
          [reviewer],
          `## Delivery acceptance review\nInspect the current workspace against the complete task and verify the changes. Do not repair files. Return ONLY a JSON object with this exact contract:\n{"verdict":"approved"|"changes_required","summary":"non-empty explanation","issues":["actionable unresolved issue"]}\nApproval requires an empty issues array; changes_required requires at least one issue. A successful process exit is not approval.`
        ))
      )
        return acceptance
      const verdict = parseReviewVerdict(results[results.length - 1].output)
      if (!verdict) {
        acceptance.reason = "Reviewer returned an invalid delivery verdict; acceptance is blocked."
        this.warn(acceptance.reason)
        return acceptance
      }
      acceptance.reviews.push(verdict)
      if (verdict.verdict === "approved") return { ...acceptance, status: "approved" }
      acceptance.status = "changes_required"
      if (acceptance.repairRounds >= (policy.maxRepairRounds ?? 1) || !repairs.length) {
        acceptance.reason = !repairs.length
          ? "No configured repair worker was selected for this task."
          : "Repair budget exhausted."
        return acceptance
      }
      acceptance.repairRounds++
      this.warn(
        `Delivery requires changes — repair pass ${acceptance.repairRounds}/${policy.maxRepairRounds ?? 1}.`
      )
      const instruction = `## Repair requested by delivery review\n${JSON.stringify(verdict)}\nAddress these findings within your assigned scope, preserve the complete task requirements, and report what you changed and verified.`
      for (const stage of repairStages) if (!(await execute(stage, instruction))) return acceptance
      acceptance.status = "failed"
    }
  }

  private stageInfos(stages: AgentDefinition[][]): StageInfo[] {
    // The model an agent will *actually* run with, resolved the same way the
    // runner resolves it. A tier-only or defaults-only agent would otherwise
    // report `undefined` here while it really runs a concrete model.
    const getModel = (agent: AgentDefinition): string | undefined =>
      resolveModel(agent, this.config)

    return stages.map((stage, i) => ({
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
  }

  /**
   * Order the agents into stages, degrading to declaration order if the graph is
   * broken.
   *
   * `buildStages` throws on a missing dependency and on a cycle. Letting that
   * escape would reject `run()` before `orchestration:complete` is emitted, so
   * the caller sees an unhandled rejection instead of a structured failure. A
   * bad ordering is not a reason to run nothing.
   */
  private buildStagesOrFallback(agents: AgentDefinition[], context: string): AgentDefinition[][] {
    try {
      return buildStages(agents)
    } catch (err) {
      this.warn(`${context} (${errorMessage(err)}) — running the agents in declaration order.`)
      return agents.map((agent) => [agent])
    }
  }

  /**
   * Decide what to do with last run's task plan before this turn starts.
   *
   * The console runs every turn against the same workspace, so the plan file
   * survives between turns. If a turn's architect fails to write a new one,
   * `applyTaskPlan` would silently re-apply the previous turn's titles, scopes
   * and dependencies to a completely different requirement.
   *
   * A resumed turn is the exception: the plan in the workspace describes the
   * task being continued, and it is the only record of what each resumed agent
   * was asked to do. Deleting it would leave every retried agent with the
   * generic "no plan was provided" fallback.
   */
  private prepareTaskPlan(): void {
    if (this.config.resume) return
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
    if (signal?.aborted) return { kind: "cancelled" }
    // A resume that names its agents already knows who runs: re-deciding with
    // the leader would re-route the turn and could pick a different team than
    // the one being resumed. Reusing `selectAgents` keeps the unknown-id
    // warning, the `agent:skipped` emission and — crucially — the pruning of a
    // `dependsOn` that points outside the resumed set, which is what lets a
    // single-agent retry run without its (absent) dependency.
    //
    // A resume carrying only `sessions` is the other case: it continues a
    // conversation rather than redoing a known pipeline, so the turn still has
    // to be routed — the sessions are for whichever agents the route picks.
    if (this.config.resume?.agents) {
      return {
        kind: "run",
        agents: this.selectAgents(this.config.resume.agents, "The resume list"),
      }
    }

    if (!this.config.leader || this.config.useLeader === false) {
      return { kind: "run", agents: this.configuredAgents() }
    }

    this.contextManager.set(
      "availableAgents",
      this.configuredAgents()
        .map((a) => `${a.id}: ${a.name}`)
        .join("\n")
    )

    const result = await this.runner.run(this.config.leader, signal)
    if (signal?.aborted || result.status === "cancelled") return { kind: "cancelled" }
    if (result.status !== "success") {
      // The leader is infrastructure, not the task. Losing it is worth saying out
      // loud, but the requirement itself may still be perfectly runnable.
      this.warn("The leader could not be reached — running the full configured team.")
      return { kind: "run", agents: this.configuredAgents() }
    }

    const decision = parseLeaderDecision(result.output)
    if (decision) {
      if (decision.mode !== "run") {
        return { kind: "message", mode: decision.mode, message: decision.message }
      }
      if (decision.requirement) this.contextManager.set("requirement", decision.requirement)
      return { kind: "run", agents: this.selectAgents(decision.run), reason: decision.reason }
    }

    // No plan at all. The leader answered in prose, and that prose *is* the
    // answer — running every configured agent on the strength of a "hello" is
    // precisely what this branch exists to prevent.
    const message = result.output.trim()
    if (!message) {
      this.warn("The leader returned no output — running the full configured team.")
      return { kind: "run", agents: this.configuredAgents() }
    }
    return { kind: "message", mode: "reply", message }
  }

  /**
   * The configured team, as copies.
   *
   * `applyTaskPlan` writes `taskTitle` / `dependsOn` / `agentScope` onto whatever
   * objects it is handed. The console reuses a single config across turns, so
   * returning the config's own objects would leak turn 1's dependency graph into
   * turn 2 — the exact cross-turn contamination `prepareTaskPlan` exists to
   * prevent, but for the in-memory fields rather than the file.
   */
  private configuredAgents(): AgentDefinition[] {
    // `dependsOn` is copied too: a shallow spread would leave the array shared
    // with the config, and a later `push` onto the copy would edit the caller's
    // config. The key is added only when it existed — spreading a missing
    // `dependsOn` back as `undefined` would invent the key on agents that never
    // had one.
    return this.config.agents
      .filter((a) => a.id !== this.config.review?.reviewer)
      .map((a) =>
        a.dependsOn
          ? {
              ...a,
              dependsOn: a.dependsOn.filter((id) => id !== this.config.review?.reviewer),
            }
          : { ...a }
      )
  }

  /**
   * Narrow the configured team to the ids `namedBy` asked for.
   *
   * Always a subset: an id that is not in the config is reported and dropped
   * rather than added, so a typo in a prompt cannot conjure an agent that has no
   * definition behind it.
   *
   * `namedBy` labels the warning. A resume names agents too — with no leader in
   * the run at all — so blaming "the leader" for a bad resumed id would send the
   * reader looking in the wrong place.
   */
  private selectAgents(run: string[], namedBy = "The leader"): AgentDefinition[] {
    const runSet = new Set(run.filter((id) => id !== this.config.review?.reviewer))
    const known = new Set(this.config.agents.map((a) => a.id))

    // The caller is told to pick from the configured list, but a model (or a
    // hand-written resume list) can still name something that is not there.
    // Dropping it in silence makes a typo indistinguishable from a deliberate
    // decision to skip.
    for (const id of run) {
      if (!known.has(id)) {
        this.warn(`${namedBy} named "${id}", which is not in the config — ignoring it.`)
      }
    }

    const skippedIds = new Set(this.config.agents.filter((a) => !runSet.has(a.id)).map((a) => a.id))

    for (const agent of this.config.agents.filter(
      (a) => skippedIds.has(a.id) && a.id !== this.config.review?.reviewer
    )) {
      this.eventBus.emit({
        type: "agent:skipped",
        timestamp: new Date().toISOString(),
        payload: { agentId: agent.id, agentName: agent.name, icon: agent.icon },
      })
    }

    return this.config.agents
      .filter((a) => runSet.has(a.id) && a.id !== this.config.review?.reviewer)
      .map((a) => ({
        ...a,
        dependsOn: a.dependsOn?.filter(
          (dep) => !skippedIds.has(dep) && dep !== this.config.review?.reviewer
        ),
      }))
  }

  private async runStage(agents: AgentDefinition[], signal?: AbortSignal): Promise<AgentResult[]> {
    const { maxConcurrency } = this.config

    // `maxConcurrency` is a cap, not a batch size. A fixed `Promise.all` chunk
    // waits for the slowest member of the chunk before launching the next one,
    // leaving empty slots idle. Keep the stage semantics and declaration-order
    // result shape, but refill each slot as soon as its current agent settles.
    const results = new Map<number, AgentResult>()
    let next = 0
    let cancelled = false
    const workers = Array.from(
      { length: Math.min(maxConcurrency || agents.length, agents.length) },
      async () => {
        while (next < agents.length && !signal?.aborted && !cancelled) {
          const index = next
          next += 1
          const result = await this.runner.run(agents[index], signal)
          results.set(index, result)
          if (result.status === "cancelled") cancelled = true
        }
      }
    )
    await Promise.all(workers)
    return [...results.entries()].sort(([a], [b]) => a - b).map(([, result]) => result)
  }

  /**
   * Whether `agent` owns task decomposition.
   *
   * The explicit `role` is the source of truth, so a config can name its planner
   * anything. The id `"architect"` is kept as a fallback so every config written
   * before `role` existed keeps working unchanged.
   */
  private isPlanner(agent: AgentDefinition): boolean {
    return agent.role === "planner" || agent.id === "architect"
  }

  /**
   * Read and validate `task-plan.json`, one entry per agent id.
   *
   * `undefined` means "there is no usable plan" — no file, unparseable JSON, or
   * no `tasks` array. Each of those is reported rather than treated as an empty
   * plan: a broken plan must not be indistinguishable from a missing one.
   *
   * Validation stops at "is this entry well-formed and unique". Whether an id
   * belongs to the run is the caller's question, because a normal turn and a
   * resume answer it differently — a resume must not warn about every teammate
   * it deliberately left out.
   */
  private readTaskPlan(): Map<string, Partial<TaskPlan["tasks"][number]>> | undefined {
    const taskPlanPath = path.join(this.workDir, "task-plan.json")
    if (!fs.existsSync(taskPlanPath)) return undefined

    let taskPlan: unknown
    try {
      taskPlan = JSON.parse(fs.readFileSync(taskPlanPath, "utf-8"))
    } catch (err) {
      // The architect produced a task-plan.json but we cannot read it. Running
      // the original agent set is a reasonable degradation — but it must not be
      // silent, otherwise a broken plan is indistinguishable from a missing one.
      this.warn(
        `Could not parse task-plan.json — continuing with the original agent set: ${errorMessage(err)}`
      )
      return undefined
    }

    if (
      typeof taskPlan !== "object" ||
      taskPlan === null ||
      !("tasks" in taskPlan) ||
      !Array.isArray(taskPlan.tasks)
    ) {
      this.warn("task-plan.json has no `tasks` array — ignoring it.")
      return undefined
    }

    const taskMap = new Map<string, Partial<TaskPlan["tasks"][number]>>()
    for (const [index, entry] of taskPlan.tasks.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        this.warn(`task-plan.json contains a malformed task at index ${index} — ignoring it.`)
        continue
      }
      const task = entry as Record<string, unknown>
      if (
        typeof task.id !== "string" ||
        !task.id.trim() ||
        (task.title !== undefined && typeof task.title !== "string") ||
        (task.scope !== undefined && typeof task.scope !== "string") ||
        (task.dependsOn !== undefined &&
          (!Array.isArray(task.dependsOn) ||
            !task.dependsOn.every((dep) => typeof dep === "string"))) ||
        (task.plan !== undefined &&
          (!Array.isArray(task.plan) || !task.plan.every((step) => typeof step === "string")))
      ) {
        this.warn(`task-plan.json contains a malformed task at index ${index} — ignoring it.`)
        continue
      }
      if (taskMap.has(task.id)) {
        this.warn(`The task plan contains a duplicate task for "${task.id}" — ignoring that task.`)
        continue
      }
      taskMap.set(task.id, task as Partial<TaskPlan["tasks"][number]>)
    }
    return taskMap
  }

  private async applyTaskPlan(
    agents: AgentDefinition[],
    executedIds: ReadonlySet<string>
  ): Promise<void> {
    const taskMap = this.readTaskPlan()
    if (!taskMap) return

    const selected = new Set(agents.map((a) => a.id))
    for (const id of taskMap.keys()) {
      if (!selected.has(id)) {
        this.warn(`The task plan names "${id}", which is not in this run — ignoring that task.`)
      }
    }
    for (const agent of agents) {
      const task = taskMap.get(agent.id)
      if (task) {
        // The plan is written by a model and can name a dependency the leader did
        // not select. Keeping it would make `buildStages` throw on a dependency
        // that is not in the set, so drop it here and say so.
        const dependsOn = task.dependsOn?.filter((dep) => selected.has(dep))
        for (const dep of task.dependsOn ?? []) {
          if (!selected.has(dep)) {
            this.warn(
              `The task plan makes "${agent.id}" depend on "${dep}", which is not in this run — ignoring that dependency.`
            )
          }
        }
        if (executedIds.has(agent.id)) continue
        agent.taskTitle = task.title
        agent.dependsOn = dependsOn
        agent.agentScope = task.scope
        if (task.plan?.length) {
          agent.agentPlan = task.plan.map((s, i) => `${i + 1}. ${s}`).join("\n")
        }
      }
    }
  }

  /**
   * Hand a resumed agent the plan entry it was originally given.
   *
   * `dependsOn` is deliberately not applied: `selectAgents` has already pruned
   * the stage graph for this run, and re-applying the plan's dependencies would
   * undo that pruning — including the one that lets a single-agent retry run
   * without the teammate it depends on.
   */
  private applyResumeTaskPlan(agents: AgentDefinition[]): void {
    const taskMap = this.readTaskPlan()
    if (!taskMap) return
    for (const agent of agents) {
      const task = taskMap.get(agent.id)
      if (!task) continue
      agent.taskTitle = task.title
      agent.agentScope = task.scope
      if (task.plan?.length) {
        agent.agentPlan = task.plan.map((s, i) => `${i + 1}. ${s}`).join("\n")
      }
    }
  }

  /**
   * The `requirement` field for a result, present only when the caller set one.
   *
   * Spread into every result builder so all three outcomes carry it the same
   * way: a completion event doubles as the report a resume driver reads back,
   * and a requirement that never reaches the report cannot be resumed.
   */
  private requirementField(): { requirement?: string } {
    const requirement = this.contextManager.get("requirement")
    return requirement !== undefined ? { requirement } : {}
  }

  /**
   * The `selectionReason` field, present only when the leader explained itself.
   *
   * Omitted rather than sent as `undefined`/`""` so a run without an
   * explanation stays byte-identical to one from before the field existed.
   */
  private reasonField(reason: string | undefined): { selectionReason?: string } {
    return reason ? { selectionReason: reason } : {}
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
      ...this.requirementField(),
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

  private finishCancelled(startTime: Date): OrchestratorResult {
    const endTime = new Date()
    const result: OrchestratorResult = {
      name: this.config.name,
      success: false,
      cancelled: true,
      totalDuration: endTime.getTime() - startTime.getTime(),
      agentResults: [],
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      ...this.requirementField(),
    }
    this.eventBus.emit({
      type: "orchestration:complete",
      timestamp: endTime.toISOString(),
      payload: result,
    })
    return result
  }

  /**
   * Close out a turn that scheduled no agents.
   *
   * Reported as a failure rather than a no-op: the user asked for work, and the
   * only honest outcome is to say that none was done. Running the whole team
   * instead would contradict the leader's explicit choice.
   */
  private finishEmpty(
    startTime: Date,
    acceptance?: AcceptanceResult,
    warnEmpty = true
  ): OrchestratorResult {
    const usedLeader = this.config.leader !== undefined && this.config.useLeader !== false
    if (warnEmpty && !acceptance?.reason)
      this.warn(
        usedLeader
          ? "The leader selected none of the configured agents — nothing to run."
          : "The config lists no agents — nothing to run."
      )

    const endTime = new Date()
    const result: OrchestratorResult = {
      name: this.config.name,
      success: false,
      ...(acceptance ? { acceptance } : {}),
      totalDuration: endTime.getTime() - startTime.getTime(),
      agentResults: [],
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      ...this.requirementField(),
    }

    this.eventBus.emit({
      type: "orchestration:complete",
      timestamp: endTime.toISOString(),
      payload: result,
    })
    return result
  }
}

function parseReviewVerdict(output: string): ReviewVerdict | undefined {
  let text = output.trim()
  // ACP streams tool narration and the final answer together. Accept one terminal
  // fenced verdict, not arbitrary prose or multiple competing JSON blocks.
  if (text.includes("```")) {
    const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)]
    if (blocks.length !== 1 || !text.endsWith(blocks[0][0])) return undefined
    const prefix = text.slice(0, blocks[0].index)
    if (prefix.includes("```") || /"verdict"\s*:/.test(prefix)) return undefined
    text = blocks[0][1]
  }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    const item = value as Record<string, unknown>
    if (
      (item.verdict !== "approved" && item.verdict !== "changes_required") ||
      typeof item.summary !== "string" ||
      !item.summary.trim() ||
      !Array.isArray(item.issues) ||
      !item.issues.every((issue) => typeof issue === "string" && issue.trim())
    )
      return undefined
    if ((item.verdict === "approved") !== (item.issues.length === 0)) return undefined
    return {
      verdict: item.verdict,
      summary: item.summary.trim(),
      issues: item.issues.map((issue: string) => issue.trim()),
    }
  } catch {
    return undefined
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Sum the per-agent costs that were actually reported, in USD.
 *
 * Returns `undefined` when no agent reported one, so the caller can leave the
 * field off the result entirely: a run nobody priced must not read as costing
 * nothing.
 */
function sumCosts(results: AgentResult[]): number | undefined {
  let total = 0
  let reported = false
  for (const result of results) {
    if (typeof result.costUsd === "number") {
      total += result.costUsd
      reported = true
    }
  }
  return reported ? total : undefined
}
