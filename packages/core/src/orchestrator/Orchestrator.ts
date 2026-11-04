import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { EventBus } from "../event/EventBus"
import { resolveModel } from "../providers/resolve"
import type { AgentDefinition, AgentResult, TaskPlan } from "../types/agent"
import type {
  AcceptanceResult,
  CheckpointInfo,
  CheckpointResponse,
  MultiClawConfig,
  OrchestrationPreview,
  OrchestratorResult,
  ReviewPolicy,
  ReviewVerdict,
  RoutingInfo,
  WorkContext,
} from "../types/config"
import type { WorkSupplement } from "../types/coordination"
import type { StageInfo } from "../types/event"
import type { LeaderMessage } from "../types/leader"
import type { SessionRecord } from "../types/session"
import { isAbortError } from "../utils/abort"
import { renderConversation } from "../utils/conversation"
import { imagePaths, imageReference } from "../utils/images"
import { parseLeaderDecision } from "../utils/leaderDecision"
import { renderUpstreamOutputs } from "../utils/upstream"
import { isWorkContext } from "../utils/work"
import { AgentRunner } from "./AgentRunner"
import { AgentSessionManager } from "./AgentSessionManager"
import { ContextManager } from "./ContextManager"
import { Coordinator } from "./Coordinator"
import { COORDINATOR_ID } from "./coordinatorAgent"
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
  | { kind: "error"; message: string }

export class Orchestrator {
  readonly eventBus = new EventBus()
  private contextManager: ContextManager
  private runner: AgentRunner
  private workDir: string
  /** Which configured checkpoints have already been triggered this run. */
  private checkpointTriggered = new Set<number>()
  private originalRequirement: string
  private work?: WorkContext
  private routing?: RoutingInfo
  private assignments = new Map<string, string>()
  private excluded = new Set<string>()
  private rerouting = false
  private repairSpent = new Map<string, number>()
  private gateResults = new Map<string, AcceptanceResult>()
  private leaderCosts: Array<{ costUsd?: number }> = []
  private ownsSessions: boolean
  private cleanupAttempted = false
  private offSessions: () => void
  private sessionRecords = new Map<string, SessionRecord>()
  private recovery = ""
  private routeError?: string
  private coordinator: Coordinator
  private ownsCoordinator: boolean
  private offCoordinator: () => void
  private executing = true
  private dirty = new Map<string, number>()
  private supplements: WorkSupplement[] = []
  private deliveries = new Set<Promise<unknown>>()
  private activeAgents: AgentDefinition[] = []
  private addedAgents = new Set<string>()
  private revisionBlocked = false
  private revisionCancelled = false
  private executionSignal?: AbortSignal

  constructor(
    private config: MultiClawConfig,
    private sessions?: AgentSessionManager,
    private coordination: {
      coordinator?: Coordinator
      sessionId?: string
      beforeBoundary?: () => Promise<void>
    } = {}
  ) {
    config = {
      ...config,
      latestWork: isWorkContext(config.latestWork) ? config.latestWork : undefined,
      resume: config.resume ? { ...config.resume } : undefined,
    }
    this.config = config
    if ("leader" in config || "useLeader" in config)
      throw new Error(
        "leader/useLeader configuration is no longer supported. Remove these fields; the coordinator uses project defaults."
      )
    if (config.agents.some((a) => a.id === COORDINATOR_ID))
      throw new Error("Reserved coordinator agent ID")
    this.ownsCoordinator = !coordination.coordinator
    this.coordinator = coordination.coordinator ?? new Coordinator(config)
    this.offCoordinator = this.coordinator.eventBus.subscribe((event) => this.eventBus.emit(event))
    this.ownsSessions = !sessions
    this.sessions = sessions ?? new AgentSessionManager()
    this.offSessions = this.sessions.subscribe((event) => {
      this.sessionRecords.set(event.record.bindingId, event.record)
      if (event.record.sessionId && this.work && this.work.id === event.record.workId) {
        let entry = this.work.agents.find((item) => item.agentId === event.record.agentId)
        if (!entry) {
          entry = { agentId: event.record.agentId }
          this.work.agents.push(entry)
        }
        if (
          !entry.session ||
          entry.session.bindingId === event.record.bindingId ||
          event.action === "created" ||
          event.action === "loaded"
        )
          entry.session = event.record
      }
      this.eventBus.emit({
        type: "agent:session",
        timestamp: event.record.observedAt,
        payload: event,
      })
      if (
        event.record.sessionId &&
        this.work &&
        this.work.id === event.record.workId &&
        this.routing
      )
        this.eventBus.emit({
          type: "orchestration:route",
          timestamp: event.record.observedAt,
          payload: { routing: { ...this.routing }, work: structuredClone(this.work) },
        })
    })
    this.originalRequirement = config.context?.requirement ?? ""
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
      this.sessions
    )
  }

  async preview(options: { signal?: AbortSignal } = {}): Promise<OrchestrationPreview> {
    try {
      return await this.previewManaged(options)
    } finally {
      try {
        if (this.ownsSessions) await this.sessions?.close()
      } finally {
        this.offSessions()
        this.offCoordinator()
        this.executing = false
        if (this.ownsCoordinator) await this.coordinator.close()
      }
    }
  }

  private async previewManaged(
    options: { signal?: AbortSignal } = {}
  ): Promise<OrchestrationPreview> {
    if (options.signal?.aborted)
      return { name: this.config.name, totalAgents: 0, stages: [], ...this.requirementField() }
    const policyError = this.reviewPolicyError()
    if (policyError) throw new Error(policyError)
    if (options.signal?.aborted)
      return { name: this.config.name, totalAgents: 0, stages: [], ...this.requirementField() }
    const resolution = await this.resolveTurn(options.signal)
    if (resolution.kind === "cancelled" || options.signal?.aborted) {
      return { name: this.config.name, totalAgents: 0, stages: [], ...this.requirementField() }
    }
    if (resolution.kind === "error") throw new Error(resolution.message)
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
    this.activeAgents = agents
    this.contextManager.set("pipelineAgents", agents.map((a) => `${a.id}: ${a.name}`).join("\n"))
    const stages = this.buildStagesOrFallback(agents, "Could not order the configured agents")
    const reviewer = this.config.agents.find((agent) => agent.id === this.config.review?.reviewer)
    if (reviewer && agents.length) stages.push([reviewer])
    const stageInfos = this.stageInfos(stages)
    return {
      name: this.config.name,
      totalAgents: agents.length + (reviewer && agents.length ? 1 : 0),
      stages: stageInfos,
      sessions: [...agents, ...(reviewer && agents.length ? [reviewer] : [])].map((agent) =>
        this.runner.previewSession(agent)
      ),
      ...this.reasonField(resolution.reason),
      ...this.requirementField(),
      originalRequirement: this.originalRequirement,
      routing: this.routing,
    }
  }

  async run(options: { signal?: AbortSignal } = {}): Promise<OrchestratorResult> {
    this.executionSignal = options.signal
    try {
      return await this.runManaged(options)
    } finally {
      try {
        if (this.ownsSessions && !this.cleanupAttempted) await this.sessions?.close()
      } finally {
        this.offSessions()
        this.offCoordinator()
        this.executing = false
        if (this.ownsCoordinator) await this.coordinator.close()
      }
    }
  }

  private async runManaged(options: { signal?: AbortSignal } = {}): Promise<OrchestratorResult> {
    const started = new Date()
    const coordinatorCostStart = this.coordinator.costs.length
    const audit: AgentResult[] = []
    let result: OrchestratorResult
    for (;;) {
      this.checkpointTriggered.clear()
      result = await this.runPass(options)
      await this.boundary()
      if (
        !result.cancelled &&
        !options.signal?.aborted &&
        !this.revisionBlocked &&
        this.dirty.size &&
        this.activeAgents.length &&
        result.agentResults.every((r) => r.status === "success") &&
        [...this.gateResults.values()].every((g) => g.status === "approved") &&
        !this.supplements.some((s) =>
          s.deliveries.some((d) => d.status === "unknown" || d.status === "failed")
        )
      ) {
        audit.push(...result.agentResults)
        this.config.latestWork = this.work
        this.config.resume = { agents: this.activeAgents.map((a) => a.id) }
        continue
      }
      const effective = [
        ...new Map(result.agentResults.map((item) => [item.agentId, item])).values(),
      ]
      audit.push(...result.agentResults)
      const handbacks = effective.filter((item) => item.status === "handed_back")
      const failure = effective.some(
        (item) => item.status === "failed" || item.status === "cancelled"
      )
      if (!handbacks.length || failure || result.cancelled || options.signal?.aborted) break
      if (this.rerouting || this.config.resume?.agents) {
        this.routeError = this.rerouting
          ? "Work handed back again; rerouting budget exhausted."
          : "Work handed back; automatic rerouting is unavailable for this fixed team."
        result.success = false
        break
      }
      this.rerouting = true
      for (const item of handbacks) this.excluded.add(item.agentId)
      if (this.routing) this.routing.reroutes = 1
      this.recovery =
        "## Rerouting after worker handoff\nPreserve the complete requirement. Check the workspace before repeating completed operations.\n" +
        JSON.stringify({
          originalRequirement: this.work?.originalRequirement,
          requirement: this.contextManager.get("requirement"),
          handbacks: handbacks.map((item) => ({
            agentId: item.agentId,
            handoffReason: item.handoffReason,
            session: item.session,
          })),
          completed: effective
            .filter((item) => item.status === "success")
            .map((item) => ({ agentId: item.agentId, output: item.output.slice(-4000) })),
          assignments: this.work?.agents,
        })
      this.contextManager.set("rerouting", this.recovery)
      this.contextManager.set("upstreamOutputs", "")
    }
    this.executing = false
    const effective = [...new Map(result.agentResults.map((item) => [item.agentId, item])).values()]
    result.effectiveAgentResults = effective
    result.agentResults = audit
    if (this.rerouting && result.reply)
      this.routeError = "Work remains incomplete: " + result.reply.message
    result.originalRequirement = this.originalRequirement
    result.routing = this.routing
    if (this.routeError) {
      result.success = false
      result.routing = {
        mode: this.routing?.mode ?? "run",
        workId: this.work?.id,
        reroutes: this.rerouting ? 1 : 0,
        error: this.routeError,
      }
      this.eventBus.emit({
        type: "orchestration:routing-error",
        timestamp: new Date().toISOString(),
        payload: { message: this.routeError },
      })
    }
    if (this.work) {
      this.work.requirement = this.contextManager.get("requirement") ?? this.work.requirement
      const workers = effective.filter((item) => item.agentId !== this.config.review?.reviewer)
      this.work.outcome = {
        execution: result.cancelled
          ? "cancelled"
          : !this.routeError &&
              workers.length > 0 &&
              workers.every((item) => item.status === "success")
            ? "success"
            : "failed",
        completedAgents: effective
          .filter(
            (item) => item.status === "success" && item.agentId !== this.config.review?.reviewer
          )
          .map((item) => item.agentId),
        failedAgents: workers
          .filter((item) => item.status !== "success")
          .map((item) => ({ agentId: item.agentId, reason: item.error ?? item.handoffReason })),
        ...(result.acceptance
          ? { acceptance: { status: result.acceptance.status, reason: result.acceptance.reason } }
          : {}),
      }
      result.work = this.work
    }
    if (this.ownsSessions) {
      this.cleanupAttempted = true
      try {
        await this.sessions?.close()
      } catch (error) {
        result.success = false
        result.routing = {
          mode: this.routing?.mode ?? "run",
          workId: this.work?.id,
          reroutes: this.rerouting ? 1 : 0,
          error: "Session cleanup failed: " + errorMessage(error),
        }
        if (this.work?.outcome) this.work.outcome.execution = "failed"
        this.eventBus.emit({
          type: "orchestration:routing-error",
          timestamp: new Date().toISOString(),
          payload: { message: result.routing.error! },
        })
      }
      for (const item of [...result.agentResults, ...(result.effectiveAgentResults ?? [])]) {
        const latest = item.session && this.sessionRecords.get(item.session.bindingId)
        if (latest) item.session = { ...latest, action: item.session!.action }
      }
    }
    await this.coordination.beforeBoundary?.()
    result.supplements = structuredClone(this.supplements)
    this.executing = false
    if (!result.reply && !result.cancelled && !options.signal?.aborted) {
      try {
        result.summary = await this.coordinator.summarize(result, options.signal)
      } catch (error) {
        result.summaryError = errorMessage(error)
      }
    } else if (result.cancelled)
      result.summary =
        "Work cancelled. Completed output is retained; remaining work was not verified."
    result.coordinatorSession = this.coordinator.session
    if (result.reply || result.summary)
      this.eventBus.emit({
        type: "coordinator:message",
        timestamp: new Date().toISOString(),
        payload: {
          mode: result.reply?.mode ?? "summary",
          message: result.reply?.message ?? result.summary ?? "",
        },
      })
    const cost = sumCosts([
      ...audit,
      ...this.leaderCosts,
      ...this.coordinator.costs.slice(coordinatorCostStart),
    ])
    if (cost !== undefined) result.totalCostUsd = cost
    result.startTime = started.toISOString()
    result.endTime = new Date().toISOString()
    result.totalDuration = Date.now() - started.getTime()
    this.eventBus.emit({
      type: "orchestration:complete",
      timestamp: result.endTime,
      payload: result,
    })
    return result
  }

  private async runPass(options: { signal?: AbortSignal }): Promise<OrchestratorResult> {
    const startTime = new Date()
    if (options.signal?.aborted) return this.finishCancelled(startTime)
    const policyError = this.reviewPolicyError()
    if (policyError) {
      this.warn(policyError)
      const result = this.finishEmpty(startTime, {
        status: "failed",
        reviewer: this.config.review?.reviewer ?? this.config.reviewGates?.[0]?.reviewer ?? "",
        repairRounds: 0,
        reviews: [],
        reason: policyError,
      })
      return result
    }
    if (options.signal?.aborted) return this.finishCancelled(startTime)
    const resolution = await this.resolveTurn(options.signal)
    if (resolution.kind === "cancelled" || options.signal?.aborted) {
      return this.finishCancelled(startTime)
    }

    if (resolution.kind === "error") {
      this.routeError = resolution.message
      return this.finishEmpty(startTime, undefined, false)
    }
    if (resolution.kind === "message") {
      return this.finishWithMessage(resolution.mode, resolution.message, startTime)
    }

    const agents = resolution.agents
    this.activeAgents = agents
    // No planner stage runs in a resumed turn, so nothing would re-apply the
    // plan that describes the very task being continued. Without this every
    // retried agent is handed the generic "no plan was provided" fallback.
    if (this.routing?.mode === "run" && !this.rerouting && !this.config.resume?.agents) {
      try {
        await this.sessions?.resetAgents(
          this.config.agents.filter((agent) => agent.id !== COORDINATOR_ID).map((agent) => agent.id)
        )
        this.prepareTaskPlan()
      } catch (error) {
        this.routeError = "Routing incomplete: could not prepare new work: " + errorMessage(error)
        return this.finishEmpty(startTime, undefined, false)
      }
    }
    // A selected planner must produce a fresh plan, including on continuation or reroute.
    if (
      !this.config.resume?.agents &&
      (this.rerouting || this.routing?.mode === "continue") &&
      agents.some((agent) => this.isPlanner(agent))
    ) {
      try {
        fs.rmSync(
          path.resolve(this.workDir, this.config.context?.taskPlanPath ?? "task-plan.json"),
          { force: true }
        )
      } catch (error) {
        this.routeError =
          "Routing incomplete: could not clear the previous plan: " + errorMessage(error)
        return this.finishEmpty(startTime, undefined, false)
      }
    }
    if (this.config.resume?.agents && !this.config.latestWork) this.applyResumeTaskPlan(agents)

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
    let acceptance: AcceptanceResult | undefined
    let gateFailed = false
    let allSuccess = true
    let cancelled = false
    // Guards the task-plan application to the first stage that runs the planner.
    // Keying off the planner's *position* instead of "stage 0" is the whole
    // point: a preset can put a product-manager first and the architect second,
    // and the old `i === 0` test silently skipped the plan for every such team.
    let planApplied = false
    const executedIds = new Set<string>()

    let handedBack = false
    for (let i = 0; i < stages.length; i++) {
      if (options.signal?.aborted) {
        cancelled = true
        allSuccess = false
        break
      }
      await this.boundary()
      await this.reconcile(agents, results, options.signal)
      if (this.revisionBlocked) {
        allSuccess = false
        gateFailed = true
        break
      }
      const stage = stages[i].filter((a) => {
        const last = [...results].reverse().find((r) => r.agentId === a.id)
        return !last || last.status !== "success" || this.dirty.has(a.id)
      })
      if (!stage.length) continue

      this.eventBus.emit({
        type: "stage:start",
        timestamp: new Date().toISOString(),
        payload: { stageIndex: i, agentIds: stage.map((a) => a.id) },
      })

      const stageResults = await this.runStage(stage, options.signal)
      results.push(...stageResults)
      await this.reconcile(agents, results, options.signal)
      if (this.revisionBlocked) {
        allSuccess = false
        gateFailed = true
      }
      for (let n = 0; n < stageResults.length; n++)
        stageResults[n] =
          [...results].reverse().find((r) => r.agentId === stageResults[n].agentId) ??
          stageResults[n]
      for (const result of stageResults) executedIds.add(result.agentId)

      // Hand the next stage what this one produced. Only what succeeded: a
      // failed agent's partial output is not a conclusion a downstream agent
      // should build on. Set before the abort check so the loop's invariant —
      // "the context reflects every completed stage" — holds on every exit.
      this.updateUpstream(results)

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

      this.captureWork(agents, results)
      handedBack = stageResults.some((item) => item.status === "handed_back")
      if (handedBack) {
        allSuccess = false
        this.eventBus.emit({
          type: "stage:complete",
          timestamp: new Date().toISOString(),
          payload: { stageIndex: i },
        })
        for (const pending of stages.slice(i + 1).flat())
          this.eventBus.emit({
            type: "agent:skipped",
            timestamp: new Date().toISOString(),
            payload: { agentId: pending.id, agentName: pending.name, icon: pending.icon },
          })
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
        this.captureWork(agents, results)
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

      // A process completing is not approval. Finish gates before downstream work.
      const cursor = { index: i + 1 }
      for (const agent of stage) {
        const policy = this.config.reviewGates?.find((gate) => gate.reviewer === agent.id)
        if (!policy) continue
        acceptance = await this.reviewDelivery(
          agents,
          results,
          stages,
          allSuccess,
          cancelled,
          options.signal,
          policy,
          cursor,
          stageResults.find((item) => item.agentId === agent.id)
        )
        this.gateResults.set(policy.reviewer, acceptance)
        if (acceptance.status !== "approved") {
          gateFailed = true
          allSuccess = false
          cancelled ||= acceptance.status === "cancelled"
          break
        }
      }
      i = cursor.index - 1
      for (const item of results) executedIds.add(item.agentId)
      // Repaired planners may change scopes and dependencies of pending workers.
      if (
        stage.some((agent) =>
          this.config.reviewGates?.some(
            (gate) =>
              gate.reviewer === agent.id &&
              gate.repairAgents.some((id) =>
                agents.some((worker) => worker.id === id && this.isPlanner(worker))
              )
          )
        )
      ) {
        await this.applyTaskPlan(agents, executedIds)
        const pending = agents
          .filter((agent) => !executedIds.has(agent.id))
          .map((agent) => ({
            ...agent,
            dependsOn: agent.dependsOn?.filter((id) => !executedIds.has(id)),
          }))
        stages = [
          ...stages.slice(0, i + 1),
          ...this.buildStagesOrFallback(pending, "Could not order pending workers"),
        ]
        this.eventBus.emit({
          type: "orchestration:stages",
          timestamp: new Date().toISOString(),
          payload: { totalAgents: agents.length, stages: toStageInfos(stages) },
        })
      }

      // Check for human checkpoints after this stage.
      if (!gateFailed && this.config.checkpoints?.length && this.config.onCheckpoint) {
        for (let cpIdx = 0; cpIdx < this.config.checkpoints.length; cpIdx++) {
          if (this.checkpointTriggered.has(cpIdx)) continue
          const cp = this.config.checkpoints[cpIdx]
          if (cp.afterAgents.every((id) => executedIds.has(id))) {
            this.checkpointTriggered.add(cpIdx)
            const response = await this.handleCheckpoint(cp, results, options.signal)
            if (response.action === "cancel") {
              cancelled = true
              allSuccess = false
              break
            }
            if (response.action === "modify") {
              await this.supplement(response.instruction, cp.afterAgents)
            }
          }
        }
      }

      if (gateFailed || cancelled || (!allSuccess && !this.config.continueOnError)) {
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

    cancelled ||= this.revisionCancelled
    if (this.config.review && !handedBack && !gateFailed && !this.revisionBlocked) {
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

    await this.boundary()
    await this.reconcile(agents, results, options.signal)
    if (
      this.config.review &&
      this.work &&
      acceptance?.revision !== this.work.revision &&
      !this.revisionBlocked &&
      !cancelled
    ) {
      acceptance = await this.reviewDelivery(agents, results, stages, true, false, options.signal)
      allSuccess = acceptance.status === "approved"
    }
    if (
      this.supplements.some((item) => item.deliveries.some((d) => d.status !== "applied")) ||
      this.dirty.size ||
      [...new Map(results.map((r) => [r.agentId, r])).values()].some(
        (r) => r.status !== "success"
      ) ||
      [...this.gateResults.values()].some((g) => g.status !== "approved")
    )
      allSuccess = false
    this.captureWork(agents, results)
    const endTime = new Date()
    // Only agents that reported a cost contribute; when none did, the field is
    // absent rather than 0 — "no data" is not the same as "free".
    const totalCostUsd = sumCosts(results)
    const result: OrchestratorResult = {
      name: this.config.name,
      success: allSuccess,
      ...(acceptance ? { acceptance } : {}),
      ...(this.gateResults.size ? { gateResults: [...this.gateResults.values()] } : {}),
      totalDuration: endTime.getTime() - startTime.getTime(),
      agentResults: results,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      ...(cancelled ? { cancelled: true } : {}),
      ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      ...this.reasonField(resolution.reason),
      ...this.requirementField(),
    }

    return result
  }

  private reviewPolicyError(): string | undefined {
    const policies = [
      ...(this.config.reviewGates ?? []),
      ...(this.config.review ? [this.config.review] : []),
    ]
    if (!policies.length) return undefined
    const ids = this.config.agents.map((agent) => agent.id)
    if (new Set(ids).size !== ids.length) return "Review policy requires unique agent ids."
    if (new Set(policies.map((policy) => policy.reviewer)).size !== policies.length)
      return "Review policies require unique reviewers."
    for (const policy of policies) {
      if (!ids.includes(policy.reviewer) || policy.reviewer === COORDINATOR_ID)
        return "Review policy must name a configured non-leader reviewer."
      if (
        !Array.isArray(policy.repairAgents) ||
        !policy.repairAgents.length ||
        new Set(policy.repairAgents).size !== policy.repairAgents.length ||
        policy.repairAgents.some(
          (id) => !ids.includes(id) || id === policy.reviewer || id === COORDINATOR_ID
        )
      )
        return "Review policy must name unique configured repair workers, excluding the reviewer and leader."
      const limit = policy.maxRepairRounds ?? 1
      if (!Number.isInteger(limit) || limit < 0 || limit > 5)
        return "Review policy maxRepairRounds must be an integer from 0 to 5."
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false
      if (visited.has(id)) return true
      visiting.add(id)
      for (const child of policies.find((policy) => policy.reviewer === id)?.repairAgents ?? [])
        if (policies.some((policy) => policy.reviewer === child) && !visit(child)) return false
      visiting.delete(id)
      visited.add(id)
      return true
    }
    if (policies.some((policy) => !visit(policy.reviewer)))
      return "Review policies contain a recursive repair cycle."
    if (
      this.config.reviewGates?.some((gate) =>
        gate.repairAgents.includes(this.config.review?.reviewer ?? "")
      )
    )
      return "Pipeline gates cannot repair the reserved delivery reviewer."
    return undefined
  }

  private reviewInstruction(policy: ReviewPolicy): string {
    return [
      "## Delivery acceptance review",
      `Review gate: ${policy.reviewer}. Inspect the current workspace against the complete requirement and your assigned responsibility.`,
      "Verify current artifacts and tests, not earlier reports. Testers must execute tests; design reviewers evaluate design documents without requiring implementation.",
      "Do not repair the artifacts under review. You may execute tests and write your report; testers may create or update test files, but must not weaken assertions or change product code to obtain approval.",
      "Return ONLY a JSON object with this exact contract:",
      '{"verdict":"approved"|"changes_required","summary":"non-empty explanation","issues":["actionable unresolved issue with owner, location, reproduction/evidence and fix direction"]}',
      "Approval requires an empty issues array; changes_required requires at least one issue. Missing verification prerequisites are changes_required with the exact blocker. A successful process exit is not approval.",
    ].join("\n")
  }

  private updateUpstream(results: AgentResult[]): void {
    const latest = new Map<string, AgentResult>()
    for (const item of results) {
      latest.delete(item.agentId)
      latest.set(item.agentId, item)
    }
    this.contextManager.set(
      "upstreamOutputs",
      renderUpstreamOutputs(
        [...latest.values()]
          .filter(
            (item) => item.status === "success" && item.agentId !== this.config.review?.reviewer
          )
          .map((item) => ({ agentId: item.agentId, name: item.agentName, output: item.output }))
      )
    )
  }

  private async reviewDelivery(
    agents: AgentDefinition[],
    results: AgentResult[],
    stages: AgentDefinition[][],
    executionSuccess: boolean,
    cancelled: boolean,
    signal?: AbortSignal,
    policy = this.config.review,
    cursor = { index: stages.length },
    initialReview?: AgentResult
  ): Promise<AcceptanceResult> {
    if (!policy) throw new Error("Delivery review requires a configured policy.")
    const acceptance: AcceptanceResult = {
      status: "failed",
      reviewer: policy.reviewer,
      repairRounds: this.repairSpent.get(policy.reviewer) ?? 0,
      reviews: [...(this.gateResults.get(policy.reviewer)?.reviews ?? [])],
      revision: this.work?.revision ?? 1,
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
    const execute = async (stage: AgentDefinition[], instruction: string): Promise<boolean> => {
      if (signal?.aborted) {
        acceptance.status = "cancelled"
        return false
      }
      const index = cursor.index++
      stages.splice(index, 0, stage)
      this.eventBus.emit({
        type: "orchestration:stages",
        timestamp: new Date().toISOString(),
        payload: {
          totalAgents: new Set(stages.flat().map((agent) => agent.id)).size,
          stages: this.stageInfos(stages),
        },
      })
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
        const gate = this.config.reviewGates?.find((gate) => gate.reviewer === agent.id)
        const result = await this.runAgent(
          agent,
          signal,
          `${this.recovery}\n${instruction}\n${gate ? this.reviewInstruction(gate) : ""}\n\n## Latest worker outputs\n${this.contextManager.get("upstreamOutputs") ?? ""}`
        )
        results.push(result)
        this.updateUpstream(results)
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
      for (const agent of stage) {
        const gate = this.config.reviewGates?.find((gate) => gate.reviewer === agent.id)
        if (gate && gate.reviewer !== policy.reviewer) {
          const nested = await this.reviewDelivery(
            agents,
            results,
            stages,
            true,
            false,
            signal,
            gate,
            cursor,
            [...results].reverse().find((item) => item.agentId === agent.id)
          )
          this.gateResults.set(gate.reviewer, nested)
          if (nested.status !== "approved") {
            acceptance.status = nested.status
            acceptance.reason = `${gate.reviewer}: ${nested.reason ?? "Acceptance did not pass."}`
            return false
          }
        }
      }
      return true
    }
    let reviewed = initialReview
    while (true) {
      if (!reviewed) {
        if (!(await execute([reviewer], this.reviewInstruction(policy)))) return acceptance
        reviewed = [...results].reverse().find((item) => item.agentId === reviewer.id)
      }
      const verdict =
        reviewed?.status === "success" ? parseReviewVerdict(reviewed.output) : undefined
      reviewed = undefined
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
      this.repairSpent.set(policy.reviewer, acceptance.repairRounds)
      this.warn(
        `Delivery requires changes (${reviewer.name}) — repair pass ${acceptance.repairRounds}/${policy.maxRepairRounds ?? 1}: ${verdict.summary}`
      )
      const instruction = `## Repair requested by delivery review\n${JSON.stringify(verdict)}\nAddress these findings within your assigned scope, preserve the complete task requirements, and report what you changed and verified.`
      for (const stage of repairStages) if (!(await execute(stage, instruction))) return acceptance
      // Approval before an edit cannot authorize the modified artifacts.
      for (let cpIdx = 0; cpIdx < (this.config.checkpoints?.length ?? 0); cpIdx++) {
        const cp = this.config.checkpoints?.[cpIdx]
        if (!cp) continue
        if (
          !this.config.onCheckpoint ||
          !cp.afterAgents.some((id) => repairIds.has(id)) ||
          !cp.afterAgents.every((id) =>
            results.some((item) => item.agentId === id && item.status === "success")
          )
        )
          continue
        const response = await this.handleCheckpoint(cp, results, signal)
        this.checkpointTriggered.add(cpIdx)
        if (response.action === "cancel" || signal?.aborted)
          return { ...acceptance, status: "cancelled" }
        if (response.action === "modify") {
          await this.supplement(response.instruction, cp.afterAgents)
        }
      }
      acceptance.status = "failed"
    }
  }

  private async handleCheckpoint(
    policy: { afterAgents: string[]; label?: string },
    results: AgentResult[],
    signal?: AbortSignal
  ): Promise<CheckpointResponse> {
    if (signal?.aborted) return { action: "cancel" }
    // The caller only reaches here with a handler configured. Reading it into a
    // local keeps that contract checked rather than asserted — and a missing
    // handler means "nobody wants to be asked", which is a continue, not a
    // cancelled run.
    const onCheckpoint = this.config.onCheckpoint
    if (!onCheckpoint) return { action: "continue" }
    const completedAgents = policy.afterAgents
      .map((id) => {
        const r = [...results]
          .reverse()
          .find((res) => res.agentId === id && res.status === "success")
        if (!r) return undefined
        return { id: r.agentId, name: r.agentName, output: r.output }
      })
      .filter((a): a is NonNullable<typeof a> => a !== undefined)
    const info: CheckpointInfo = {
      label: policy.label || "review checkpoint",
      completedAgents,
    }
    return onCheckpoint(info, signal ?? new AbortController().signal)
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
      const gates = new Set(this.config.reviewGates?.map((gate) => gate.reviewer))
      return buildStages(agents).flatMap((stage) => {
        const reviewers = stage.filter((agent) => gates.has(agent.id)).map((agent) => [agent])
        const workers = stage.filter((agent) => !gates.has(agent.id))
        return [...reviewers, ...(workers.length ? [workers] : [])]
      })
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
    if (this.config.resume?.agents) return
    // `force` makes the normal case — a workspace with no plan in it — a no-op
    // rather than a stat followed by a delete.
    fs.rmSync(path.resolve(this.workDir, this.config.context?.taskPlanPath ?? "task-plan.json"), {
      force: true,
    })
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
      const agents = this.selectAgents(this.config.resume.agents, "The resume list")
      this.beginWork(agents, "continue", this.config.latestWork)
      return { kind: "run", agents }
    }

    const available = this.configuredAgents().filter((agent) => !this.excluded.has(agent.id))
    this.contextManager.set(
      "availableAgents",
      available
        .map((agent) => agent.id + ": " + agent.name + " — " + (agent.description ?? ""))
        .join("\n")
    )
    this.contextManager.set(
      "latestWork",
      JSON.stringify(this.rerouting ? this.work : this.config.latestWork) ?? "No previous work."
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      let output: string
      try {
        output = JSON.stringify(
          await this.coordinator.route(
            JSON.stringify({
              requirement: this.originalRequirement,
              history: this.config.history,
              latestWork: this.rerouting ? this.work : this.config.latestWork,
              availableAgents: available.map((a) => ({
                id: a.id,
                name: a.name,
                description: a.description,
              })),
              recovery: this.recovery,
            }),
            signal
          )
        )
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return { kind: "cancelled" }
        this.warn(errorMessage(error))
        continue
      }
      const result = { status: "success", output }
      if (signal?.aborted || result.status === "cancelled") return { kind: "cancelled" }
      const decision = result.status === "success" ? parseLeaderDecision(result.output) : undefined
      if (decision && (decision.mode === "run" || decision.mode === "continue")) {
        const known = new Set(available.map((agent) => agent.id))
        if (
          !decision.run.length ||
          decision.run.some((id) => !known.has(id)) ||
          new Set(decision.run).size !== decision.run.length
        ) {
          this.warn("Invalid routing agents: " + decision.run.join(", "))
          continue
        }
        const previous = this.rerouting ? this.work : this.config.latestWork
        if (
          decision.mode === "continue" &&
          (!previous ||
            previous.outcome?.execution === "cancelled" ||
            decision.workId !== previous.id)
        )
          continue
        if (decision.requirement) {
          // A leader may rewrite the prose; keep the caller's image attachments.
          const images = imagePaths(
            this.contextManager.get("requirement") ?? this.originalRequirement
          )
          const present = new Set(imagePaths(decision.requirement))
          this.contextManager.set(
            "requirement",
            [
              decision.requirement,
              ...images.filter((file) => !present.has(file)).map(imageReference),
            ].join("\n\n")
          )
        } else if (decision.mode === "continue" && previous)
          this.contextManager.set(
            "requirement",
            previous.requirement + "\n\n[Follow-up] " + this.originalRequirement
          )
        const agents = this.selectAgents(decision.run)
        this.beginWork(agents, decision.mode, previous)
        this.assignments = new Map((decision.tasks ?? []).map((task) => [task.agentId, task.scope]))
        for (const task of decision.tasks ?? []) {
          const agent = agents.find((item) => item.id === task.agentId)
          if (agent)
            agent.agentScope = this.assignments.get(agent.id) ?? task.scope ?? agent.agentScope
        }
        this.captureWork(agents, [])
        return { kind: "run", agents, reason: decision.reason }
      }
      if (decision && (decision.mode === "reply" || decision.mode === "ask"))
        return { kind: "message", mode: decision.mode, message: decision.message }
      const message = result.output.trim()
      if (
        result.status === "success" &&
        message &&
        !/^[{[]|"(?:mode|run|tasks|workId)"\s*:|multiclaw-handoff/.test(message)
      )
        return { kind: "message", mode: "reply", message }
    }
    return {
      kind: "error",
      message: "Routing incomplete: the leader did not return a valid decision after one retry.",
    }
  }

  private beginWork(
    agents: AgentDefinition[],
    mode: "run" | "continue",
    previous?: WorkContext
  ): void {
    const continuing = mode === "continue" || this.rerouting || !!this.config.resume?.agents
    this.work =
      continuing && previous
        ? structuredClone(previous)
        : {
            id: randomUUID(),
            originalRequirement: this.originalRequirement,
            requirement: this.contextManager.get("requirement") ?? this.originalRequirement,
            agents: [],
          }
    this.routing = {
      mode: continuing ? "continue" : "run",
      workId: this.work.id,
      reroutes: this.rerouting ? 1 : 0,
    }
    this.work.revision ??= 1
    this.contextManager.set("workId", this.work.id)
    if (continuing) {
      const sessions: Record<string, SessionRecord> = {
        ...(this.config.resume?.agents ? this.config.resume.sessions : {}),
      }
      for (const agent of agents) {
        const prior = this.work.agents.find((item) => item.agentId === agent.id)
        if (prior) {
          agent.agentScope = prior.scope ?? agent.agentScope
          agent.agentPlan = prior.plan ?? agent.agentPlan
          agent.taskTitle = prior.taskTitle ?? agent.taskTitle
          if (prior.dependsOn)
            agent.dependsOn = prior.dependsOn.filter((id) => agents.some((item) => item.id === id))
          if (prior.session) sessions[agent.id] = prior.session
        }
      }
      this.config.resume = {
        ...(this.config.resume?.agents ? { agents: this.config.resume.agents } : {}),
        sessions,
      }
      this.recovery =
        this.recovery ||
        "## Continued work\nInspect the workspace and git state before repeating operations. Previous execution and acceptance facts (partial output is not verified):\n" +
          JSON.stringify(this.work)
    } else {
      this.config.resume = undefined
      this.recovery = ""
    }
  }

  private captureWork(agents: AgentDefinition[], results: AgentResult[]): void {
    if (!this.work || !this.routing) return
    this.work.requirement = this.contextManager.get("requirement") ?? this.work.requirement
    for (const agent of agents) {
      const result = [...results].reverse().find((item) => item.agentId === agent.id)
      const old = this.work.agents.find((item) => item.agentId === agent.id)
      const entry = {
        agentId: agent.id,
        scope: agent.agentScope,
        plan: agent.agentPlan,
        taskTitle: agent.taskTitle,
        dependsOn: agent.dependsOn ? [...agent.dependsOn] : undefined,
        session:
          result?.session?.sessionId || result?.session?.failure?.code === "cleanup_failed"
            ? result.session
            : (old?.session ?? result?.session),
      }
      this.work.agents = this.work.agents.filter((item) => item.agentId !== agent.id)
      this.work.agents.push(entry)
    }
    this.eventBus.emit({
      type: "orchestration:route",
      timestamp: new Date().toISOString(),
      payload: { routing: { ...this.routing }, work: structuredClone(this.work) },
    })
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

    const agentMap = new Map(this.config.agents.map((a) => [a.id, a]))

    return this.config.agents
      .filter((a) => runSet.has(a.id) && a.id !== this.config.review?.reviewer)
      .map((a) => ({
        ...a,
        dependsOn:
          a.dependsOn !== undefined
            ? this.resolveEffectiveDeps(a.dependsOn, skippedIds, agentMap)
            : undefined,
      }))
  }

  // When an intermediate agent is skipped, replace it in dependsOn with its own
  // dependencies (recursively). This preserves topological ordering across gaps:
  // code-reviewer → tester (skip) → backend-developer becomes
  // code-reviewer → backend-developer, so the reviewer never runs before the code is written.
  private resolveEffectiveDeps(
    deps: string[],
    skippedIds: Set<string>,
    agentMap: Map<string, AgentDefinition>,
    visited = new Set<string>()
  ): string[] {
    const reviewerId = this.config.review?.reviewer
    const result = new Set<string>()
    for (const id of deps) {
      if (id === reviewerId) continue
      if (visited.has(id)) continue
      if (!skippedIds.has(id)) {
        result.add(id)
      } else {
        visited.add(id)
        for (const transitive of this.resolveEffectiveDeps(
          agentMap.get(id)?.dependsOn ?? [],
          skippedIds,
          agentMap,
          visited
        )) {
          result.add(transitive)
        }
      }
    }
    return [...result]
  }

  get isExecuting(): boolean {
    return this.executing
  }

  get snapshot(): { work?: WorkContext; supplements: WorkSupplement[] } {
    return structuredClone({ work: this.work, supplements: this.supplements })
  }

  /** Commits intent before any asynchronous delivery; stage boundaries wait for its result. */
  async supplement(
    text: string,
    agentIds: string[],
    messageId: string = randomUUID()
  ): Promise<WorkSupplement> {
    const existing = this.supplements.find((item) => item.messageId === messageId)
    if (existing) {
      if (
        existing.text !== text ||
        existing.deliveries.length !== agentIds.length ||
        existing.deliveries.some((d) => !agentIds.includes(d.agentId))
      )
        throw new Error("Conflicting duplicate supplement ID")
      await Promise.all([...this.deliveries])
      return structuredClone(existing)
    }
    if (!this.executing || !this.work || this.executionSignal?.aborted)
      throw new Error("No active work to supplement")
    if (
      !text.trim() ||
      !agentIds.length ||
      new Set(agentIds).size !== agentIds.length ||
      agentIds.some((id) => !this.config.agents.some((a) => a.id === id))
    )
      throw new Error("Invalid supplement recipients")
    const revision = (this.work.revision ?? 1) + 1
    this.work.revision = revision
    this.work.requirement += "\n\n[Additional requirement] " + text
    this.contextManager.set("requirement", this.work.requirement)
    const affected = new Set(agentIds)
    const include = (id: string, seen = new Set<string>()) => {
      if (seen.has(id)) return
      seen.add(id)
      const existing = this.activeAgents.find((a) => a.id === id)
      const agent = existing ?? this.config.agents.find((a) => a.id === id)
      if (!agent) return
      for (const dep of agent.dependsOn ?? []) include(dep, seen)
      if (!existing) {
        this.activeAgents.push({
          ...agent,
          dependsOn: agent.dependsOn ? [...agent.dependsOn] : undefined,
        })
        this.addedAgents.add(id)
      }
    }
    for (const id of agentIds) include(id)
    const graph = [
      ...this.activeAgents,
      ...this.config.agents.filter((a) => a.id === this.config.review?.reviewer),
    ]
    for (;;) {
      const size = affected.size
      for (const agent of graph)
        if (agent.dependsOn?.some((id) => affected.has(id))) affected.add(agent.id)
      for (const gate of [
        ...(this.config.reviewGates ?? []),
        ...(this.config.review ? [this.config.review] : []),
      ])
        if (
          graph.some((a) => a.id === gate.reviewer) &&
          gate.repairAgents.some((id) => affected.has(id))
        )
          affected.add(gate.reviewer)
      if (affected.size === size) break
    }
    for (const id of affected) if (graph.some((a) => a.id === id)) this.dirty.set(id, revision)
    const item: WorkSupplement = {
      messageId,
      sessionId: this.coordination.sessionId,
      workId: this.work.id,
      revision,
      text,
      deliveries: agentIds.map((agentId) => ({ agentId, status: "pending" })),
    }
    this.supplements.push(item)
    this.emitSupplement(item)
    const delivery = this.sessions!.supplement(text, agentIds).then((reports) => {
      for (const d of item.deliveries) {
        const report = reports.find((r) => r.agentId === d.agentId)
        d.bindingId = report?.bindingId
        if (report?.status === "injected") d.status = "delivered"
        else if (report?.status === "unknown") {
          d.status = "unknown"
          d.reason = report.error
        } else if (report?.status === "error") {
          d.status = "failed"
          d.reason = report.error
        }
      }
      this.emitSupplement(item)
      return item
    })
    this.deliveries.add(delivery)
    try {
      return await delivery
    } finally {
      this.deliveries.delete(delivery)
    }
  }

  private emitSupplement(item: WorkSupplement): void {
    this.eventBus.emit({
      type: "work:supplement",
      timestamp: new Date().toISOString(),
      payload: structuredClone(item),
    })
  }

  private async boundary(): Promise<void> {
    await this.coordination.beforeBoundary?.()
    await Promise.all([...this.deliveries])
  }

  private async runAgent(
    agent: AgentDefinition,
    signal?: AbortSignal,
    instruction?: string
  ): Promise<AgentResult> {
    await this.boundary()
    const unknown = this.supplements.some((s) =>
      s.deliveries.some(
        (d) => d.agentId === agent.id && (d.status === "unknown" || d.status === "failed")
      )
    )
    if (unknown) {
      this.revisionBlocked = true
      const now = new Date().toISOString()
      const result: AgentResult = {
        agentId: agent.id,
        agentName: agent.name,
        status: "failed",
        output: "",
        error: "Supplement delivery is unresolved; refusing automatic replay",
        duration: 0,
        attempts: 0,
        startTime: now,
        endTime: now,
      }
      this.eventBus.emit({ type: "agent:failed", timestamp: now, payload: result })
      return result
    }
    const revision = this.work?.revision ?? 1
    const result = await this.runner.run(agent, signal, instruction)
    result.revision = revision
    if (result.status === "success" && (this.dirty.get(agent.id) ?? 0) <= revision) {
      this.dirty.delete(agent.id)
      for (const supplement of this.supplements)
        for (const d of supplement.deliveries)
          if (
            d.agentId === agent.id &&
            supplement.revision <= revision &&
            (d.status === "pending" || d.status === "delivered")
          ) {
            d.status = "applied"
            this.emitSupplement(supplement)
          }
    }
    return result
  }

  /** Rework only affected completed agents, in dependency order, before releasing downstream. */
  private async reconcile(
    agents: AgentDefinition[],
    results: AgentResult[],
    signal?: AbortSignal
  ): Promise<void> {
    rework: for (;;) {
      await this.boundary()
      if (signal?.aborted) return
      const completed = new Set(results.map((r) => r.agentId))
      const needed = new Set(this.addedAgents)
      const includeDeps = (id: string, seen = new Set<string>()) => {
        if (seen.has(id)) return
        seen.add(id)
        for (const dep of agents.find((a) => a.id === id)?.dependsOn ?? []) {
          if (!completed.has(dep)) needed.add(dep)
          includeDeps(dep, seen)
        }
      }
      for (const id of this.addedAgents) includeDeps(id)
      const rerun = [
        ...new Map(
          [...this.config.agents.filter((a) => completed.has(a.id)), ...agents].map((a) => [
            a.id,
            a,
          ])
        ).values(),
      ].filter((a) => (this.dirty.has(a.id) && completed.has(a.id)) || needed.has(a.id))
      if (!rerun.length) return
      const ids = new Set(rerun.map((a) => a.id))
      for (const stage of this.buildStagesOrFallback(
        rerun.map((a) => ({ ...a, dependsOn: a.dependsOn?.filter((id) => ids.has(id)) })),
        "Could not order revised work"
      )) {
        for (const agent of stage) {
          const gate = this.config.reviewGates?.find((g) => g.reviewer === agent.id)
          const result = await this.runAgent(
            agent,
            signal,
            "The requirement changed. Inspect existing artifacts; complete and verify the latest requirement without repeating completed operations unnecessarily.\n" +
              (gate ? this.reviewInstruction(gate) : "")
          )
          results.push(result)
          this.updateUpstream(results)
          if (result.status !== "success") {
            this.revisionBlocked = true
            return
          }
          this.addedAgents.delete(agent.id)
          if (gate) {
            const verdict = parseReviewVerdict(result.output)
            if (verdict?.verdict !== "approved") {
              const acceptance = await this.reviewDelivery(
                agents,
                results,
                [],
                true,
                false,
                signal,
                gate,
                { index: 0 },
                result
              )
              this.gateResults.set(gate.reviewer, acceptance)
              if (acceptance.status !== "approved") {
                this.revisionBlocked = true
                return
              }
            } else
              this.gateResults.set(gate.reviewer, {
                status: "approved",
                reviewer: gate.reviewer,
                repairRounds: this.repairSpent.get(gate.reviewer) ?? 0,
                reviews: [verdict],
                revision: this.work?.revision,
              })
          }
        }
        await this.boundary()
        if (stage.some((agent) => this.dirty.has(agent.id))) continue rework
        for (let index = 0; index < (this.config.checkpoints?.length ?? 0); index++) {
          const cp = this.config.checkpoints?.[index]
          if (
            !cp ||
            !this.checkpointTriggered.has(index) ||
            !this.config.onCheckpoint ||
            !cp.afterAgents.some((id) => stage.some((agent) => agent.id === id))
          )
            continue
          if (
            !cp.afterAgents.every((id) => {
              const latest = [...results].reverse().find((r) => r.agentId === id)
              return latest?.status === "success" && !this.dirty.has(id)
            })
          )
            continue
          const response = await this.handleCheckpoint(cp, results, signal)
          if (response.action === "cancel") {
            this.revisionBlocked = true
            this.revisionCancelled = true
            return
          }
          if (response.action === "modify")
            await this.supplement(response.instruction, cp.afterAgents)
        }
        if (stage.some((agent) => this.dirty.has(agent.id))) continue rework
      }
    }
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
          const gate = this.config.reviewGates?.find((gate) => gate.reviewer === agents[index].id)
          const result = await this.runAgent(
            agents[index],
            signal,
            gate ? `${this.recovery}\n${this.reviewInstruction(gate)}` : this.recovery || undefined
          )
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
    const taskPlanPath = path.resolve(
      this.workDir,
      this.config.context?.taskPlanPath ?? "task-plan.json"
    )
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
        // A generated plan cannot bypass a configured, selected review barrier.
        const gates = new Set(this.config.reviewGates?.map((gate) => gate.reviewer))
        const barriers =
          this.config.agents
            .find((item) => item.id === agent.id)
            ?.dependsOn?.filter((id) => selected.has(id) && gates.has(id)) ?? []
        agent.dependsOn = dependsOn ? [...new Set([...dependsOn, ...barriers])] : agent.dependsOn
        agent.agentScope = this.assignments.get(agent.id) ?? task.scope ?? agent.agentScope
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
      agent.agentScope = this.assignments.get(agent.id) ?? task.scope ?? agent.agentScope
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
    const usedLeader = true
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
function sumCosts(results: Array<{ costUsd?: number }>): number | undefined {
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
