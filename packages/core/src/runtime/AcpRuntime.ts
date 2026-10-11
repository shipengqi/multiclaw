import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Readable, Writable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import type {
  AgentOutput,
  AgentTask,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeInfo,
  RuntimeQuery,
} from "../types/runtime"
import { abortError } from "../utils/abort"
import { RuntimeBase } from "./RuntimeBase"

/** Grace period between SIGTERM and SIGKILL when an agent will not stop. */
const KILL_ESCALATION_MS = 3000

/**
 * Grace period between asking the agent to cancel (`session/cancel`) and killing
 * its process group. A well-behaved agent stops the turn on its own; this is the
 * fallback for one that does not.
 */
const CANCEL_GRACE_MS = 2000

/** Default ACP agent: opencode speaks ACP natively under `opencode acp`. */
const DEFAULT_COMMAND = "opencode"
const DEFAULT_ARGS = ["acp"]

/**
 * ACP bridges that honour `_meta.systemPrompt` / `_meta.claudeCode.options`.
 *
 * ACP carries no capability flag for these, so the only signal available is
 * which binary we were told to launch. Keyed on basename so a path or a
 * Windows `.cmd`/`.exe` suffix does not defeat the lookup.
 */
const META_CAPABLE_COMMANDS = new Set(["claude-agent-acp"])

/** A `RuntimeEvent` before the emitter supplies its per-run envelope. */
type RuntimeEventPayload = RuntimeEvent extends infer E
  ? E extends RuntimeEventBase
    ? Omit<E, keyof RuntimeEventBase>
    : never
  : never

/** The SDK module, imported lazily (see `execute`). */
type AcpModule = typeof import("@agentclientprotocol/sdk")
type AcpSessionNotification = import("@agentclientprotocol/sdk").SessionNotification
type AcpPermissionRequest = import("@agentclientprotocol/sdk").RequestPermissionRequest
type AcpPermissionResponse = import("@agentclientprotocol/sdk").RequestPermissionResponse

/**
 * What *this adapter* implements — not what an ACP agent could do.
 *
 * `permissions` is true: a `session/request_permission` is answered against
 * `task.tools` — a tool named there is approved and everything else is rejected
 * (see `decidePermission`). `models` is false because ACP negotiates no model
 * here; `images`, `usage` and `cost` are false because those updates are
 * surfaced as `raw` rather than mapped. `resume` is true because a set
 * `sessionId` drives `session/load`.
 */
const CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  sessions: true,
  resume: true,
  permissions: true,
  tools: true,
  models: false,
  images: false,
  usage: false,
  cost: false,
  sandbox: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True when `command` names an executable file on PATH. */
function resolvesOnPath(command: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  // PATHEXT is Windows-only; the bare name covers POSIX and extensionless
  // binaries. Trying both is harmless and avoids a platform branch.
  const exts = (process.env.PATHEXT ?? "").split(";").filter(Boolean)
  const suffixes = exts.length > 0 ? exts : [""]
  for (const dir of dirs) {
    for (const ext of suffixes) {
      if (isExecutableFile(path.join(dir, command + ext))) return true
    }
  }
  return false
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Text of an ACP content block, or undefined when it is not a text block. */
function textOf(content: unknown): string | undefined {
  if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
    return content.text
  }
  return undefined
}

/** Render arbitrary tool output as the string the `tool_result` event carries. */
function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  return JSON.stringify(value)
}

/** Map an ACP `stopReason` onto the runtime union. */
function mapStopReason(reason: string): "success" | "max_turns" | "cancelled" | "error" {
  switch (reason) {
    case "end_turn":
      return "success"
    case "cancelled":
      return "cancelled"
    case "max_tokens":
    case "max_turn_requests":
      return "max_turns"
    default:
      // "refusal" and anything unknown: the agent did not complete the task.
      return "error"
  }
}

/**
 * Claude tool names an ACP `ToolKind` stands for.
 *
 * A fallback only: `claude-agent-acp` always sends the real tool name, so
 * `name` is the primary path (verified against the live bridge — its `Write`
 * and `Bash` permission requests both carried `name`). A bridge that omits
 * `name` still gets a chance here. `delete`, `move`, `think`, `switch_mode`
 * and `other` map to nothing — no Claude tool corresponds to them, so they
 * fail closed.
 */
const KIND_TO_TOOLS: Record<string, string[]> = {
  read: ["Read"],
  edit: ["Edit", "Write"],
  execute: ["Bash"],
  search: ["Grep", "Glob"],
  fetch: ["WebFetch"],
}

/** The tool a permission request was rejected for — surfaced as a visible event. */
interface RejectedPermission {
  toolCallId: string
  name?: string
  kind?: string
  title?: string
}

/**
 * Answer a `session/request_permission` against `task.tools`.
 *
 * Mirrors `ClaudeRuntime`'s `--allowedTools`: a tool is approved only when it
 * is named in `tools`, and everything else is rejected — fail-closed, so an
 * unidentifiable request never widens the agent's reach.
 *
 * Identification is name-first. The live `claude-agent-acp` bridge always sends
 * the real Claude tool name, so a name that is absent from `tools` is a
 * rejection, not a prompt to consult `kind`; `kind` is only a fallback for a
 * bridge that omits `name` entirely. A request carrying another session's id is
 * not ours to answer and is cancelled rather than silently ignored.
 *
 * The decision is synchronous — the handler returns the outcome directly — so
 * there is no pending-request state to track or clean up.
 */
function decidePermission(
  params: AcpPermissionRequest,
  tools: string[],
  sessionId: string | undefined
): { response: AcpPermissionResponse; rejected?: RejectedPermission } {
  if (sessionId !== undefined && params.sessionId !== sessionId) {
    return { response: { outcome: { outcome: "cancelled" } } }
  }

  const allowed = new Set(tools.map((tool) => tool.toLowerCase()))
  const name = params.toolCall.name ?? undefined
  const kind = params.toolCall.kind ?? undefined
  const approved =
    name !== undefined
      ? allowed.has(name.toLowerCase())
      : (KIND_TO_TOOLS[kind ?? ""] ?? []).some((candidate) => allowed.has(candidate.toLowerCase()))

  // Prefer the durable option in the direction the decision went; an empty or
  // one-directional `options` list must not throw.
  const option = approved
    ? (params.options.find((o) => o.kind === "allow_always") ??
      params.options.find((o) => o.kind === "allow_once"))
    : (params.options.find((o) => o.kind === "reject_always") ??
      params.options.find((o) => o.kind === "reject_once"))

  // No option in the needed direction: cancel rather than fall back to the
  // opposite one, which would be the agent's decision to make, not ours.
  const response: AcpPermissionResponse = option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } }

  if (approved) return { response }
  return {
    response,
    rejected: {
      toolCallId: params.toolCall.toolCallId,
      name,
      kind,
      title: params.toolCall.title ?? undefined,
    },
  }
}

/** Normalise a launch command to a bare, lowercased binary name. */
function commandKey(command: string): string {
  return path
    .basename(command)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/, "")
}

/**
 * How this agent's role prompt reaches the bridge.
 *
 * `"meta"` — the bridge honours `_meta.systemPrompt`, so send a real
 * system-level prompt. `"prompt"` — the safe default: prefix the prompt text,
 * which every ACP agent understands, at the cost of weaker instruction
 * adherence. The two modes are mutually exclusive: sending both would double
 * the instructions on a bridge that honours both.
 *
 * Known limitation of `"prompt"` mode: there is no tool-restriction mechanism
 * at all — only a `_meta`-capable bridge reads `claudeCode.options.tools`, so a
 * prompt-mode agent (e.g. `codex-acp`) runs with whatever its binary defaults
 * to. That is a gap in the bridge, not an oversight in this adapter.
 */
function deliveryFor(command: string): "meta" | "prompt" {
  return META_CAPABLE_COMMANDS.has(commandKey(command)) ? "meta" : "prompt"
}

/**
 * `_meta` for a session-defining request, or undefined when it would be empty.
 *
 * ACP has no system-prompt field (`systemPrompt` appears in no `$defs`), so a
 * role prompt can only travel in `_meta`. `claude-agent-acp` merges an object
 * with its Claude Code preset, but a *string* replaces the preset — and that is
 * what we want: multiclaw's system prompt is the agent's whole identity.
 *
 * `systemPrompt` is omitted when empty (matching `ClaudeRuntime`, which also
 * skips `--system-prompt` for an empty value). Tools are always sent, including
 * an empty array — see the inline note.
 */
function buildMeta(task: AgentTask): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {}
  if (task.systemPrompt) meta.systemPrompt = task.systemPrompt
  // Always sent, including an empty array. AgentRunner
  // (orchestrator/AgentRunner.ts:50) defaults `task.tools` to
  // ["Read", "Write", "Bash"], so an empty array can only be an explicit
  // `tools: []` — and an explicit "no tools" must not silently fall back to the
  // bridge's full claude_code preset. Note this is a different axis from
  // ClaudeRuntime's `--allowedTools` (a permission allowlist layered on the
  // preset, not the set of tools that exist), so the two are not interchangeable.
  meta.claudeCode = { options: { tools: task.tools } }
  return Object.keys(meta).length > 0 ? meta : undefined
}

/**
 * Add a login hint to a JSON-RPC "authentication required" error.
 *
 * `claude-agent-acp` reuses the ambient Claude Code login and advertises no ACP
 * login flow (`authMethods: []`), so the SDK's bare "Authentication required"
 * is a dead end for the user. Detected by the SDK's own error code — the client
 * rejects a failed request with a real `RequestError` — not by matching text.
 */
function withAuthHint(acp: AcpModule, err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err))
  if (error instanceof acp.RequestError && error.code === acp.RequestError.authRequired().code) {
    return new Error(`${error.message} — run \`claude\` to log in`)
  }
  return error
}

export class AcpRuntime extends RuntimeBase {
  readonly name = "acp"

  async describe(options?: RuntimeQuery): Promise<RuntimeInfo> {
    // Deliberately does NOT import the SDK. `describe()` runs at CLI startup
    // (`assertRuntimesAvailable`), and importing the SDK pulls in zod — measured
    // at ~5s here — so doing it here would add seconds to every `multiclaw`
    // launch for an ACP config. Availability is about the agent binary, not the
    // client library, so a PATH lookup is both cheaper and more accurate.
    //
    // The command is caller-supplied: an ACP agent is whatever binary the config
    // pinned (`opencode`, `codex-acp`, …), so probing the default would report a
    // perfectly installed non-default agent as missing.
    return {
      name: this.name,
      available: resolvesOnPath(options?.command ?? DEFAULT_COMMAND),
      capabilities: { ...CAPABILITIES },
    }
  }

  async execute(task: AgentTask): Promise<AgentOutput> {
    // Lazy, never a top-level import: the SDK drags in zod (~5s, ~6MB), so a
    // static import would tax every CLI startup even for runs that never touch
    // ACP.
    const acp: AcpModule = await import("@agentclientprotocol/sdk")

    const command = task.command ?? DEFAULT_COMMAND
    const args = task.args ?? DEFAULT_ARGS

    // The role prompt has no ACP field, so it is delivered one of two ways (see
    // `deliveryFor`). Both are pure functions of the task, so compute them once.
    const delivery = deliveryFor(command)
    const meta = delivery === "meta" ? buildMeta(task) : undefined
    const promptText =
      delivery === "prompt" && task.systemPrompt
        ? `${task.systemPrompt}\n\n---\n\n${task.prompt}`
        : task.prompt

    return new Promise<AgentOutput>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: task.workDir,
        env: process.env,
        // Own process group, so a kill reaches whatever the agent spawned too.
        detached: true,
      })

      /**
       * Signal the whole group, falling back to the child alone.
       *
       * `process.kill(-pid)` throws once the group is gone, and a fake child in
       * tests has no pid at all — neither is a reason to fail a cancellation.
       */
      const signalChild = (signal: NodeJS.Signals) => {
        try {
          child.kill(signal)
        } catch {
          // Already gone.
        }
      }
      const killTree = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) {
          signalChild(signal)
          return
        }
        try {
          process.kill(-child.pid, signal)
        } catch {
          signalChild(signal)
        }
      }

      let stopped = false
      let escalation: NodeJS.Timeout | undefined
      const stop = (signal: NodeJS.Signals) => {
        if (stopped) return
        stopped = true
        killTree(signal)
        // Escalate for every stop reason — timeout, abort and normal teardown
        // alike. A long-lived agent that ignores SIGTERM must not linger.
        escalation = setTimeout(() => killTree("SIGKILL"), KILL_ESCALATION_MS)
        escalation.unref()
      }

      let timedOut = false
      const timer =
        task.timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              stop("SIGTERM")
            }, task.timeout)

      let cancelGrace: NodeJS.Timeout | undefined
      const clearTimers = () => {
        if (timer) clearTimeout(timer)
        if (escalation) clearTimeout(escalation)
        if (cancelGrace) clearTimeout(cancelGrace)
      }

      // A fresh id per run, and a counter that orders the events it carries.
      const runId = randomUUID()
      let seq = 0
      const emit = (event: RuntimeEventPayload) => {
        task.onEvent?.({ ...event, runId, agentId: task.agentId, seq: seq++ } as RuntimeEvent)
      }

      let sessionId: string | undefined
      let agentText = ""
      let errorOutput = ""
      let connectionError: Error | undefined
      let settled = false

      const settleResolve = (output: AgentOutput) => {
        if (settled) return
        settled = true
        clearTimers()
        resolve(output)
      }
      const settleReject = (error: Error) => {
        if (settled) return
        settled = true
        clearTimers()
        reject(error)
      }

      // ── session/update → RuntimeEvent ────────────────────────────────────
      const handleUpdate = (notification: AcpSessionNotification) => {
        // A shared agent process could in principle host several sessions; only
        // this run's session is ours.
        if (sessionId && notification.sessionId !== sessionId) return

        // The SDK validated `update` against the ACP schema before delivering
        // it, so the typed union can be trusted — no defensive re-parsing.
        const update = notification.update
        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            const text = textOf(update.content)
            if (text === undefined) {
              emit({ type: "raw", vendor: "acp", payload: update })
              break
            }
            agentText += text
            emit({ type: "message_delta", role: "agent", text })
            break
          }
          case "user_message_chunk": {
            const text = textOf(update.content)
            if (text === undefined) {
              emit({ type: "raw", vendor: "acp", payload: update })
              break
            }
            // Deliberately NOT appended to `agentText`: that accumulator is the
            // agent's own output and feeds `AgentOutput.output`.
            emit({ type: "message_delta", role: "user", text })
            break
          }
          case "agent_thought_chunk": {
            const text = textOf(update.content)
            if (text === undefined) {
              emit({ type: "raw", vendor: "acp", payload: update })
              break
            }
            emit({ type: "message_delta", role: "thought", text })
            break
          }
          case "tool_call": {
            emit({
              type: "tool_call",
              id: update.toolCallId,
              name: update.name ?? update.title,
              input: update.rawInput,
            })
            break
          }
          case "tool_call_update": {
            emit({
              type: "tool_result",
              id: update.toolCallId,
              output: stringifyOutput(update.rawOutput ?? update.content),
              isError: update.status === "failed",
            })
            break
          }
          case "plan": {
            emit({ type: "plan", entries: update.entries.map((entry) => entry.content) })
            break
          }
          default:
            // Unknown / extension updates (usage_update, notice, `_`-prefixed
            // extensions, …) must never break the run — surface and move on.
            emit({ type: "raw", vendor: "acp", payload: update })
        }
      }

      const app = acp.client({ name: "multiclaw" })
      app.onNotification(acp.methods.client.session.update, (nctx) => {
        handleUpdate(nctx.params)
      })
      // Answered synchronously against `task.tools` (see `decidePermission`), so
      // there is no pending-request bookkeeping: the outcome goes back in one
      // shot, with nothing to track or clean up.
      app.onRequest(acp.methods.client.session.requestPermission, (rctx) => {
        const { response, rejected } = decidePermission(rctx.params, task.tools, sessionId)
        if (rejected) {
          // A rejection is invisible on the wire — the tool simply does not run
          // — so surface it: the user must see which tool the agent asked for
          // and was refused.
          emit({
            type: "raw",
            vendor: "acp",
            payload: { type: "permission_rejected", ...rejected },
          })
        }
        return response
      })

      // stderr is diagnostics only — the protocol lives on stdout. Never parse
      // it as protocol; keep it for the error message if the agent dies.
      //
      // Decoded statefully: stderr is chunked arbitrarily, so a multi-byte
      // codepoint can straddle a chunk boundary and a per-chunk
      // `Buffer.toString()` would corrupt it into U+FFFD.
      const stderrDecoder = new StringDecoder("utf8")
      child.stderr.on("data", (d: Buffer) => {
        errorOutput += stderrDecoder.write(d)
      })

      // `Readable.toWeb` is typed against Node's web-stream types, which do not
      // line up with the DOM `ReadableStream<Uint8Array>` the SDK declares.
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      )
      const connection = app.connect(stream)
      const ctx = connection.agent

      const teardown = () => {
        try {
          connection.close()
        } catch {
          // Already closed.
        }
        stop("SIGTERM")
      }

      // Abort: ask the agent to stop the turn (protocol-correct), but do not
      // trust it — kill the process group if it does not exit promptly.
      task.signal?.addEventListener(
        "abort",
        () => {
          if (sessionId) {
            void ctx.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {})
          }
          cancelGrace = setTimeout(() => stop("SIGTERM"), CANCEL_GRACE_MS)
          cancelGrace.unref()
        },
        { once: true }
      )

      child.on("close", (code) => {
        // Flush the decoder first: it may hold the tail of a codepoint whose
        // remaining bytes never arrived, and any decoded bytes must land before
        // `errorOutput` is interpolated into the message below.
        errorOutput += stderrDecoder.end()
        if (settled) return
        // Settle on cancellation too — a cancelled run must not leave the
        // caller's promise pending forever.
        if (task.signal?.aborted) {
          settleReject(abortError())
          return
        }
        if (timedOut) {
          settleReject(new Error(`acp timed out (${task.timeout}ms)`))
          return
        }
        if (connectionError) {
          settleReject(connectionError)
          return
        }
        settleReject(new Error(`${command} exited with code ${code}: ${errorOutput}`))
      })
      child.on("error", (err) => {
        settleReject(new Error(`Failed to start ${command}: ${err.message}`))
      })

      const run = async () => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
        })
        emit({ type: "run_started", model: task.model })

        if (task.sessionId) {
          // `session/load` only exists when the agent advertises it; sending it
          // blind earns a cryptic protocol error. Do NOT fall back to a fresh
          // session — the caller asked to resume and would wrongly believe it did.
          if (init.agentCapabilities?.loadSession !== true) {
            throw new Error(
              `Agent does not support session/load (loadSession=false); cannot resume session ${task.sessionId}`
            )
          }
          await ctx.request(acp.methods.agent.session.load, {
            sessionId: task.sessionId,
            cwd: task.workDir,
            mcpServers: [],
            // Both session-defining requests carry `_meta`: the bridge's own
            // session fingerprint includes it, so a changed prompt rebuilds the
            // session on resume.
            ...(meta ? { _meta: meta } : {}),
          })
          sessionId = task.sessionId
        } else {
          const created = await ctx.request(acp.methods.agent.session.new, {
            cwd: task.workDir,
            mcpServers: [],
            ...(meta ? { _meta: meta } : {}),
          })
          sessionId = created.sessionId
        }

        const response = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        })

        if (task.signal?.aborted) {
          settleReject(abortError())
          teardown()
          return
        }

        const stopReason = mapStopReason(response.stopReason)
        emit({ type: "run_finished", stopReason })
        settleResolve({ output: agentText, exitCode: 0, sessionId, stopReason })
        // ACP agents are long-lived: the turn is done, so end the process.
        teardown()
      }

      void run().catch((err: unknown) => {
        connectionError = withAuthHint(acp, err)
        settleReject(connectionError)
        teardown()
      })
    })
  }
}
