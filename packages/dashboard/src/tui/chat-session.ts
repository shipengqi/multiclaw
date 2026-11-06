import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  AgentSessionManager,
  type CheckpointInfo,
  type CheckpointResponse,
  COORDINATOR_ID,
  Coordinator,
  type EventBus,
  isSessionRecord,
  isWorkContext,
  type MultiClawConfig,
  type MultiClawEvent,
  Orchestrator,
  type OrchestratorResult,
  type RuntimePermissionRequest,
  type RuntimeQuestionRequest,
  type RuntimeQuestionResponse,
  resolvePermissionMode,
  type SessionRecord,
  type WorkContext,
  type WorkSupplement,
} from "@multiclawcli/core"
import { pendingWrite, writeJsonFile } from "./atomic"
import {
  createSession,
  deleteSession,
  listSessions,
  type SessionMeta,
  sessionDir,
  touchSession,
} from "./sessions"
import { createInitialState, seedAgents, type TuiState, tuiReducer } from "./state"

export const CHAT_VERSION = 2
export interface ChatMessage {
  id: string
  sessionId?: string
  requirementRevision?: number
  role: "user" | "assistant" | "system"
  text: string
  workId?: string
  kind?: "ask" | "summary" | "error" | "route"
  status?: "pending" | "handled"
}
export type ChatInteraction =
  | {
      id: string
      kind: "permission"
      request: RuntimePermissionRequest
      settle: (value?: string) => void
    }
  | {
      id: string
      kind: "question"
      request: RuntimeQuestionRequest
      settle: (value: RuntimeQuestionResponse) => void
    }
  | {
      id: string
      kind: "checkpoint"
      request: CheckpointInfo
      settle: (value: CheckpointResponse) => void
    }
interface QueuedWork {
  text: string
  messageId?: string
  resume?: MultiClawConfig["resume"]
  work?: WorkContext
}
export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  draft: string
  draftImages: string[]
  running: boolean
  paused: boolean
  queue: QueuedWork[]
  interactions: ChatInteraction[]
  supplements: WorkSupplement[]
  latestWork?: WorkContext
  coordinatorSession?: SessionRecord
  lastResult?: OrchestratorResult
  view: TuiState
  permissionMode: "auto" | "ask" | "deny"
  unsupported?: string
  phase: string
}
interface LiveSession extends ChatSession {
  workers: AgentSessionManager
  coordinator: Coordinator
  orchestrator?: Orchestrator
  controller?: AbortController
  shutdown: AbortController
  processing: Promise<void>
  execution?: Promise<void>
  ready?: Promise<void>
  markReady?: () => void
  controlRevision: number
}
interface SavedSession {
  version: number
  messages: ChatMessage[]
  queue: QueuedWork[]
  supplements: WorkSupplement[]
  latestWork?: WorkContext
  coordinatorSession?: SessionRecord
  lastResult?: OrchestratorResult
  inFlight?: boolean
  view: TuiState
}
function validView(value: unknown): value is TuiState {
  if (!value || typeof value !== "object") return false
  const v = value as TuiState
  return (
    Number.isInteger(v.turn) &&
    v.turn >= 0 &&
    ["idle", "running", "complete"].includes(v.phase) &&
    typeof v.scroll === "number" &&
    Array.isArray(v.leaderIds) &&
    Array.isArray(v.stages) &&
    v.stages.every(
      (stage) =>
        stage &&
        Array.isArray(stage.agents) &&
        stage.agents.every((a) => a && typeof a.id === "string")
    ) &&
    !!v.agents &&
    typeof v.agents === "object" &&
    Object.values(v.agents).every(
      (a) =>
        a &&
        typeof a.id === "string" &&
        typeof a.name === "string" &&
        [
          "pending",
          "running",
          "retrying",
          "handed_back",
          "success",
          "failed",
          "cancelled",
          "skipped",
        ].includes(a.status) &&
        Array.isArray(a.logs) &&
        a.logs.every(
          (l) =>
            l &&
            typeof l.text === "string" &&
            ["text", "tool", "tool-detail", "system"].includes(l.kind)
        ) &&
        (a.session === undefined || isSessionRecord(a.session))
    ) &&
    Array.isArray(v.history) &&
    v.history.every((turn) => validView({ ...turn, history: [] }))
  )
}
function validSupplement(value: unknown): value is WorkSupplement {
  if (!value || typeof value !== "object") return false
  const v = value as WorkSupplement
  return (
    typeof v.messageId === "string" &&
    typeof v.workId === "string" &&
    Number.isInteger(v.revision) &&
    v.revision > 0 &&
    typeof v.text === "string" &&
    Array.isArray(v.deliveries) &&
    v.deliveries.every(
      (d) =>
        d &&
        typeof d.agentId === "string" &&
        ["pending", "delivered", "applied", "failed", "unknown"].includes(d.status)
    )
  )
}
function validQueue(value: unknown): value is QueuedWork {
  if (!value || typeof value !== "object") return false
  const v = value as QueuedWork
  return (
    typeof v.text === "string" &&
    (v.work === undefined || isWorkContext(v.work)) &&
    (!v.resume ||
      ((!v.resume.agents ||
        (Array.isArray(v.resume.agents) &&
          v.resume.agents.every((id) => typeof id === "string"))) &&
        (!v.resume.sessions || Object.values(v.resume.sessions).every(isSessionRecord))))
  )
}

export interface SessionRuntimeOptions {
  onTurnStart?: (bus: EventBus, logDir: string) => void | (() => void | Promise<void>)
}

/** Owns every chat's async resources; selected chat is only a view selection. */
export class SessionRuntime {
  private live = new Map<string, LiveSession>()
  private listeners = new Set<() => void>()
  private closing = false
  private closePromise?: Promise<void>
  private saveTimer: ReturnType<typeof setInterval>
  selectedId?: string
  blankDraft = ""
  private blankImages: string[] = []
  notice?: string

  constructor(
    readonly config: MultiClawConfig,
    private options: SessionRuntimeOptions = {}
  ) {
    this.saveTimer = setInterval(() => {
      for (const s of this.live.values()) if (s.running) this.persist(s)
    }, 2000)
    this.saveTimer.unref?.()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private changed(): void {
    for (const listener of this.listeners) listener()
  }
  get current(): ChatSession | undefined {
    return this.selectedId ? this.live.get(this.selectedId) : undefined
  }
  get draft(): string {
    return this.current?.draft ?? this.blankDraft
  }
  setDraft(text: string): void {
    const s = this.current
    if (s) s.draft = text
    else this.blankDraft = text
    this.changed()
  }
  get draftImages(): string[] {
    return this.current?.draftImages ?? this.blankImages
  }
  setDraftImages(images: string[]): void {
    if (this.current) this.current.draftImages = images
    else this.blankImages = images
    this.changed()
  }
  get summaries(): Array<SessionMeta & { status: string }> {
    return listSessions(this.config.workDir).map((meta) => {
      const s = this.live.get(meta.id)
      return {
        ...meta,
        status: s?.unsupported
          ? "unsupported"
          : s?.interactions.length
            ? "needs input"
            : s?.running
              ? s.phase
              : s?.paused && s.queue.length
                ? "paused"
                : s?.lastResult
                  ? s.lastResult.cancelled
                    ? "cancelled"
                    : s.lastResult.success
                      ? "complete"
                      : "failed"
                  : "saved",
      }
    })
  }
  newChat(): void {
    if (this.closing) return
    this.selectedId = undefined
    this.changed()
  }

  open(id: string): void {
    if (this.closing) return
    const meta = listSessions(this.config.workDir).find((s) => s.id === id)
    if (!meta) throw new Error("Session not found: " + id)
    if (!this.live.has(id)) this.live.set(id, this.restore(meta))
    this.selectedId = id
    this.changed()
  }

  private make(id: string, title: string): LiveSession {
    const shutdown = new AbortController()
    return {
      id,
      title,
      messages: [],
      draft: "",
      draftImages: [],
      running: false,
      paused: false,
      queue: [],
      interactions: [],
      supplements: [],
      view: createInitialState(this.config),
      permissionMode: resolvePermissionMode(this.config) ?? "ask",
      phase: "ready",
      workers: new AgentSessionManager(),
      coordinator: new Coordinator(this.config),
      shutdown,
      processing: Promise.resolve(),
      controlRevision: 0,
    }
  }

  private restore(meta: SessionMeta): LiveSession {
    const s = this.make(meta.id, meta.title)
    const target = this.file(s.id)
    try {
      const value = JSON.parse(fs.readFileSync(target, "utf-8")) as SavedSession
      if (
        value.version !== CHAT_VERSION ||
        !Array.isArray(value.messages) ||
        !value.messages.every(
          (m) =>
            m &&
            typeof m.id === "string" &&
            typeof m.text === "string" &&
            ["user", "assistant", "system"].includes(m.role)
        ) ||
        !Array.isArray(value.queue) ||
        !value.queue.every(validQueue) ||
        !validView(value.view) ||
        !Array.isArray(value.supplements) ||
        !value.supplements.every(validSupplement) ||
        (value.latestWork !== undefined && !isWorkContext(value.latestWork)) ||
        (value.coordinatorSession !== undefined &&
          (!isSessionRecord(value.coordinatorSession) ||
            value.coordinatorSession.agentId !== COORDINATOR_ID ||
            value.coordinatorSession.workId !== undefined))
      )
        throw new Error("Unsupported or damaged session format; original data retained")
      s.messages = value.messages
      s.queue = value.queue
      for (const message of s.messages)
        if (message.role === "user" && message.status === "pending") {
          this.message(
            s,
            "system",
            "Message processing was interrupted; no automatic replay: " + message.text
          )
          message.status = "handled"
        }
      s.paused = true
      s.supplements = Array.isArray(value.supplements) ? value.supplements : []
      s.latestWork = value.latestWork
      s.lastResult = value.lastResult
      s.view = value.view
      s.coordinatorSession = value.coordinatorSession
        ? { ...value.coordinatorSession, state: "unknown" }
        : undefined
      s.coordinator = new Coordinator(this.config, s.coordinatorSession)
      if (value.inFlight) {
        for (const agent of Object.values(s.view.agents)) {
          if (["running", "pending", "retrying"].includes(agent.status)) agent.status = "cancelled"
          if (agent.session) agent.session.state = "unknown"
        }
        s.view.phase = "complete"
        s.view.interrupted = true
        if (!s.latestWork && s.view.requirement) s.queue.unshift({ text: s.view.requirement })
        if (s.latestWork) {
          s.latestWork.outcome = { execution: "interrupted", completedAgents: [], failedAgents: [] }
          for (const agent of s.latestWork.agents)
            if (agent.session) agent.session.state = "unknown"
        }
        for (const item of s.supplements)
          for (const delivery of item.deliveries)
            if (delivery.status === "pending" || delivery.status === "delivered") {
              delivery.status = "unknown"
              delivery.reason = "Interrupted before processing was confirmed"
            }
        this.message(
          s,
          "system",
          "Previous work was interrupted. Pending requests were discarded; queued work is paused. Review unresolved deliveries before continuing."
        )
      }
    } catch (error) {
      s.unsupported = error instanceof Error ? error.message : String(error)
      this.message(s, "system", s.unsupported)
    }
    return s
  }

  private file(id: string): string {
    return path.join(sessionDir(this.config.workDir, id), "session.json")
  }
  private message(
    s: LiveSession,
    role: ChatMessage["role"],
    text: string,
    kind?: ChatMessage["kind"]
  ): ChatMessage {
    const m = {
      id: randomUUID(),
      sessionId: s.id,
      role,
      text,
      kind,
      workId: s.latestWork?.id,
      requirementRevision: s.latestWork?.revision,
    }
    s.messages.push(m)
    this.changed()
    return m
  }
  private persist(s: LiveSession): void {
    if (s.unsupported) return
    const value: SavedSession = {
      version: CHAT_VERSION,
      messages: s.messages,
      queue: s.queue,
      supplements: s.supplements,
      latestWork: s.latestWork,
      coordinatorSession: s.coordinator.session,
      lastResult: s.lastResult,
      inFlight: s.running,
      view: s.view,
    }
    void writeJsonFile(this.file(s.id), JSON.stringify(value)).catch((error) => {
      this.notice = "Session save failed: " + String(error)
      this.changed()
    })
    touchSession(this.config.workDir, s.id, { title: s.title, turnCount: s.view.turn })
  }

  submit(text: string): Promise<void> {
    if (!text.trim() || this.closing) return Promise.resolve()
    let s = this.selectedId ? this.live.get(this.selectedId) : undefined
    if (!s) {
      const meta = createSession(this.config.workDir)
      s = this.make(meta.id, text.slice(0, 80))
      this.live.set(s.id, s)
      this.selectedId = s.id
      this.blankDraft = ""
      this.blankImages = []
    }
    if (s.unsupported) throw new Error(s.unsupported)
    s.draft = ""
    s.draftImages = []
    const message = this.message(s, "user", text)
    message.status = "pending"
    const owner = s
    const process = owner.processing
      .catch(() => {})
      .then(async () => {
        await this.handle(owner, message)
        message.status = "handled"
        this.persist(owner)
      })
    owner.processing = process.catch((error) => {
      this.message(owner, "system", String(error), "error")
      owner.paused = true
      this.persist(owner)
    })
    this.persist(owner)
    return owner.processing
  }

  private async handle(s: LiveSession, message: ChatMessage): Promise<void> {
    if (this.closing || s.shutdown.signal.aborted) return
    if (!s.running) {
      this.start(s, { text: message.text, messageId: message.id })
      return
    }
    await s.ready
    if (s.controller?.signal.aborted) {
      s.queue.push({ text: message.text, messageId: message.id })
      this.message(
        s,
        "system",
        "Current work is stopping; message queued for the next conversation."
      )
      this.persist(s)
      return
    }
    const controlRevision = s.controlRevision
    const snapshot = s.orchestrator?.snapshot
    if (!snapshot?.work || !s.orchestrator?.isExecuting) {
      s.queue.push({ text: message.text, messageId: message.id })
      this.persist(s)
      this.changed()
      return
    }
    const decision = await s.coordinator.chat(
      message.text,
      {
        work: snapshot.work,
        results: Object.values(s.view.agents).map((a) => ({
          agentId: a.id,
          agentName: a.name,
          status: a.status,
          output: a.logs.map((l) => l.text).join(""),
          duration: a.duration ?? 0,
          attempts: a.attempts ?? 0,
          startTime: "",
          endTime: "",
        })),
        history: s.messages,
        supplements: snapshot.supplements,
      },
      s.shutdown.signal
    )
    if (controlRevision !== s.controlRevision || s.shutdown.signal.aborted) {
      this.message(s, "system", "Work was stopped before this instruction was applied.")
      return
    }
    this.message(s, "assistant", decision.message, decision.mode === "ask" ? "ask" : undefined)
    if (decision.mode === "supplement") {
      if (s.orchestrator?.snapshot.work?.id !== decision.workId || !s.orchestrator.isExecuting)
        throw new Error("Work ended before instruction could be dispatched")
      await s.orchestrator.supplement(decision.text, decision.agents, message.id)
      s.latestWork = s.orchestrator.snapshot.work
    } else if (decision.mode === "queue" || decision.mode === "replace") {
      if (decision.mode === "replace")
        s.queue.unshift({ text: decision.requirement, messageId: message.id })
      else s.queue.push({ text: decision.requirement, messageId: message.id })
      if (decision.mode === "replace") {
        s.controller?.abort()
        s.paused = false
      }
    }
    this.persist(s)
    this.changed()
  }

  private start(s: LiveSession, work: QueuedWork): void {
    if (s.running || this.closing) return
    s.running = true
    s.phase = "routing"
    s.controller = new AbortController()
    s.ready = new Promise((resolve) => {
      s.markReady = resolve
    })
    s.view = tuiReducer(s.view, {
      type: "turn:start",
      requirement: work.text,
      agents: seedAgents(this.config),
      leaderIds: [],
      startedAt: Date.now(),
    })
    const execute = async () => {
      const logDir = path.join(
        this.config.workDir,
        ".multiclaw",
        "runs",
        "run-" + randomUUID(),
        "logs"
      )
      const config: MultiClawConfig = {
        ...this.config,
        context: {
          ...this.config.context,
          requirement: work.text,
          taskPlanPath: path.join(".multiclaw", "sessions", s.id, "task-plan.json"),
        },
        logDir,
        latestWork: work.work ?? s.latestWork,
        resume: work.resume,
        history: s.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-20)
          .map((m) =>
            m.role === "user"
              ? { requirement: m.text }
              : {
                  requirement: "",
                  reply: {
                    mode: m.kind === "ask" ? ("ask" as const) : ("reply" as const),
                    message: m.text,
                  },
                }
          ),
        permissions: {
          mode: s.permissionMode,
          getMode: () => s.permissionMode,
          onRequest: (request, signal) => this.permission(s, request, signal),
        },
        questions: { onRequest: (request, signal) => this.question(s, request, signal) },
        onCheckpoint: (request, signal) => this.checkpoint(s, request, signal),
      }
      const orchestrator = new Orchestrator(config, s.workers, {
        coordinator: s.coordinator,
        sessionId: s.id,
        beforeBoundary: async () => {
          for (;;) {
            const signal = s.controller?.signal
            if (!signal || signal.aborted) return
            const p = s.processing
            let stop!: () => void
            const cancelled = new Promise<void>((resolve) => {
              stop = resolve
            })
            signal.addEventListener("abort", stop, { once: true })
            try {
              await Promise.race([p, cancelled])
            } finally {
              signal.removeEventListener("abort", stop)
            }
            if (signal.aborted) return
            if (p === s.processing) break
          }
        },
      })
      s.orchestrator = orchestrator
      const off = orchestrator.eventBus.subscribe((event) => {
        if (event.type === "orchestration:route" && event.payload.work && work.messageId) {
          const message = s.messages.find((m) => m.id === work.messageId)
          if (message) {
            message.workId = event.payload.work.id
            message.requirementRevision = event.payload.work.revision
          }
        }
        this.event(s, event)
      })
      const dispose = this.options.onTurnStart?.(orchestrator.eventBus, logDir)
      try {
        const result = await orchestrator.run({ signal: s.controller?.signal })
        s.lastResult = result
        s.latestWork = result.work ?? s.latestWork
        if (result.reply?.mode === "ask" || (!result.success && !result.cancelled)) s.paused = true
        if (result.cancelled && !s.queue.length) s.paused = true
        if (result.routing?.error?.includes("cleanup")) s.paused = true
      } catch (error) {
        s.paused = true
        this.message(s, "system", String(error), "error")
      } finally {
        s.markReady?.()
        s.markReady = undefined
        off()
        try {
          await dispose?.()
        } catch (error) {
          s.paused = true
          this.message(s, "system", "Log cleanup failed: " + String(error), "error")
        }
        for (const i of [...s.interactions]) this.dismiss(i)
        s.running = false
        s.phase = "ready"
        s.orchestrator = undefined
        this.persist(s)
        this.changed()
        if (!this.closing && !s.paused && s.queue.length)
          this.start(s, s.queue.shift() as QueuedWork)
      }
    }
    s.execution = execute()
    void s.execution.catch((error) => {
      s.running = false
      s.paused = true
      this.message(s, "system", String(error), "error")
    })
    this.persist(s)
    this.changed()
  }

  private event(s: LiveSession, event: MultiClawEvent): void {
    if (event.type === "coordinator:phase") {
      s.phase = event.payload.phase === "idle" ? "running" : event.payload.phase
    } else if (event.type === "coordinator:message")
      this.message(
        s,
        "assistant",
        event.payload.message,
        event.payload.mode === "ask"
          ? "ask"
          : event.payload.mode === "summary"
            ? "summary"
            : event.payload.mode === "route"
              ? "route"
              : undefined
      )
    else if (event.type === "agent:complete") {
      const payload = event.payload
      if (payload.agentId !== COORDINATOR_ID) {
        const d = (payload.duration / 1000).toFixed(1)
        this.message(s, "system", `✓ ${payload.agentName} (${payload.agentId}) done (${d}s)`)
      }
    } else if (event.type === "agent:failed") {
      const payload = event.payload
      if (payload.agentId !== COORDINATOR_ID) {
        this.message(
          s,
          "system",
          `✗ ${payload.agentName} (${payload.agentId}) failed: ${payload.error ?? "unknown error"}`,
          "error"
        )
      }
    } else if (event.type === "agent:handed-back") {
      const payload = event.payload
      if (payload.agentId !== COORDINATOR_ID) {
        this.message(
          s,
          "system",
          `⎌ ${payload.agentName} (${payload.agentId}) handed back: ${payload.handoffReason}`
        )
      }
    } else if (event.type === "work:supplement") {
      const source = s.messages.find((m) => m.id === event.payload.messageId)
      if (source) {
        source.workId = event.payload.workId
        source.requirementRevision = event.payload.revision
      }
      const index = s.supplements.findIndex((item) => item.messageId === event.payload.messageId)
      if (index < 0) s.supplements.push(event.payload)
      else s.supplements[index] = event.payload
      const text = event.payload.deliveries
        .map((d) => d.agentId + ": " + d.status + (d.reason ? " (" + d.reason + ")" : ""))
        .join(" · ")
      const marker = "delivery:" + event.payload.messageId
      const message = s.messages.find((m) => m.id === marker)
      if (message) message.text = text
      else
        s.messages.push({
          id: marker,
          sessionId: s.id,
          role: "system",
          text,
          workId: event.payload.workId,
          requirementRevision: event.payload.revision,
        })
    } else if (event.type === "orchestration:route") {
      s.latestWork = event.payload.work
      s.markReady?.()
    } else if (
      event.type === "orchestration:routing-error" ||
      event.type === "orchestration:warning"
    )
      this.message(s, "system", event.payload.message)
    else if (event.type === "orchestration:complete") {
      s.markReady?.()
      if (event.payload.summaryError)
        this.message(s, "system", "Summary failed: " + event.payload.summaryError, "error")
      if (!event.payload.reply && !event.payload.summary)
        this.message(
          s,
          "system",
          event.payload.cancelled
            ? "Work cancelled"
            : event.payload.success
              ? "Execution complete"
              : "Execution failed",
          event.payload.success ? undefined : "error"
        )
    }
    // Coordinator raw JSON and tool stream never enter the team roster or chat.
    const payload = event.payload as { agentId?: string; record?: { agentId?: string } }
    if (payload.agentId !== COORDINATOR_ID && payload.record?.agentId !== COORDINATOR_ID)
      s.view = tuiReducer(s.view, { type: "event", event })
    this.changed()
    if (event.type !== "agent:output") this.persist(s)
  }

  private interaction<T>(
    s: LiveSession,
    signal: AbortSignal,
    create: (settle: (value: T) => void) => ChatInteraction,
    cancelled: T
  ): Promise<T> {
    if (signal.aborted || this.closing) return Promise.resolve(cancelled)
    return new Promise((resolve) => {
      let done = false
      const settle = (value: T) => {
        if (done) return
        done = true
        signal.removeEventListener("abort", abort)
        s.interactions = s.interactions.filter((i) => i !== item)
        resolve(value)
        this.persist(s)
        this.changed()
      }
      const item = create(settle)
      const abort = () => settle(cancelled)
      s.interactions.push(item)
      signal.addEventListener("abort", abort, { once: true })
      this.changed()
      this.persist(s)
    })
  }
  private permission(
    s: LiveSession,
    request: RuntimePermissionRequest,
    signal: AbortSignal
  ): Promise<string | undefined> {
    return this.interaction<string | undefined>(
      s,
      signal,
      (settle) => ({ id: randomUUID(), kind: "permission", request, settle }),
      undefined
    )
  }
  private question(
    s: LiveSession,
    request: RuntimeQuestionRequest,
    signal: AbortSignal
  ): Promise<RuntimeQuestionResponse> {
    return this.interaction<RuntimeQuestionResponse>(
      s,
      signal,
      (settle) => ({ id: randomUUID(), kind: "question", request, settle }),
      { action: "cancel" }
    )
  }
  private checkpoint(
    s: LiveSession,
    request: CheckpointInfo,
    signal: AbortSignal
  ): Promise<CheckpointResponse> {
    return this.interaction<CheckpointResponse>(
      s,
      signal,
      (settle) => ({ id: randomUUID(), kind: "checkpoint", request, settle }),
      { action: "cancel" }
    )
  }
  private dismiss(item: ChatInteraction): void {
    if (item.kind === "checkpoint") item.settle({ action: "cancel" })
    else if (item.kind === "question") item.settle({ action: "cancel" })
    else item.settle(undefined)
  }

  cancel(): void {
    const s = this.selectedId ? this.live.get(this.selectedId) : undefined
    if (!s) return
    s.paused = true
    s.controlRevision++
    s.controller?.abort()
    this.changed()
  }
  pause(): void {
    if (this.current) this.current.paused = true
    this.changed()
  }
  continue(): void {
    const s = this.selectedId ? this.live.get(this.selectedId) : undefined
    if (!s || s.unsupported) return
    if (s.supplements.some((item) => item.deliveries.some((d) => d.status === "unknown")))
      throw new Error("Unresolved delivery requires explicit review; automatic replay refused")
    s.paused = false
    if (!s.running && s.latestWork && s.latestWork.outcome?.execution === "interrupted")
      this.start(s, {
        text: s.latestWork.requirement,
        work: s.latestWork,
        resume: {
          agents: s.latestWork.agents.map((a) => a.agentId),
          sessions: Object.fromEntries(
            s.latestWork.agents
              .filter((a) => a.session)
              .map((a) => [a.agentId, a.session as SessionRecord])
          ),
        },
      })
    else if (!s.running && s.queue.length) this.start(s, s.queue.shift() as QueuedWork)
    this.persist(s)
    this.changed()
  }
  async steer(text: string, agentIds: string[]): Promise<void> {
    const s = this.selectedId ? this.live.get(this.selectedId) : undefined
    if (!s?.orchestrator?.isExecuting) throw new Error("No active work")
    await s.orchestrator.supplement(text, agentIds)
  }
  retry(id?: string): void {
    const s = this.selectedId ? this.live.get(this.selectedId) : undefined
    if (!s || s.running || !s.latestWork) throw new Error("Retry requires idle, known work")
    const ids = id
      ? [id]
      : Object.values(s.view.agents)
          .filter((a) => a.status === "failed")
          .map((a) => a.id)
    if (!ids.length || ids.some((id) => !this.config.agents.some((a) => a.id === id)))
      throw new Error("No matching failed agent")
    const sessions = Object.fromEntries(
      s.latestWork.agents
        .filter((a) => ids.includes(a.agentId) && a.session)
        .map((a) => [a.agentId, a.session as SessionRecord])
    )
    this.start(s, {
      text: s.latestWork.requirement,
      work: s.latestWork,
      resume: { agents: ids, sessions },
    })
  }
  async remove(id: string): Promise<void> {
    const s = this.live.get(id)
    if (s?.running) throw new Error("Stop this session before deleting it")
    if (s) {
      s.shutdown.abort()
      await s.processing
      await s.coordinator.close()
      await s.workers.close()
      await pendingWrite(this.file(id))
      this.live.delete(id)
    }
    deleteSession(this.config.workDir, id)
    if (this.selectedId === id) this.selectedId = undefined
    this.changed()
  }
  setPermissionMode(mode: "auto" | "ask" | "deny"): void {
    if (this.current) this.current.permissionMode = mode
    this.changed()
  }
  updateView(action: Parameters<typeof tuiReducer>[1]): void {
    const s = this.current
    if (s) {
      s.view = tuiReducer(s.view, action)
      this.changed()
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    clearInterval(this.saveTimer)
    this.closePromise = (async () => {
      const all = [...this.live.values()]
      for (const s of all) {
        s.shutdown.abort()
        s.controller?.abort()
        for (const i of [...s.interactions]) this.dismiss(i)
      }
      const results = await Promise.allSettled(
        all.map(async (s) => {
          const settled = await Promise.allSettled([
            s.coordinator.close(),
            s.processing,
            s.execution,
          ])
          settled.push(...(await Promise.allSettled([s.workers.close()])))
          this.persist(s)
          settled.push(...(await Promise.allSettled([pendingWrite(this.file(s.id))])))
          const failures = settled.filter(
            (r): r is PromiseRejectedResult => r.status === "rejected"
          )
          if (failures.length)
            throw new AggregateError(
              failures.map((r) => r.reason),
              "Session cleanup failed"
            )
        })
      )
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
      if (errors.length)
        throw new AggregateError(
          errors.map((r) => r.reason),
          "Session shutdown failed"
        )
    })()
    return this.closePromise
  }
}
