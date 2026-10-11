import { execSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import type {
  AgentOutput,
  AgentTask,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeInfo,
} from "../types/runtime"
import { abortError } from "../utils/abort"
import { RuntimeBase } from "./RuntimeBase"

/** Grace period between SIGTERM and SIGKILL when an agent will not stop. */
const KILL_ESCALATION_MS = 3000

/** A `RuntimeEvent` before the emitter supplies its per-run envelope. */
type RuntimeEventPayload = RuntimeEvent extends infer E
  ? E extends RuntimeEventBase
    ? Omit<E, keyof RuntimeEventBase>
    : never
  : never

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class ClaudeRuntime extends RuntimeBase {
  readonly name = "claude"

  async describe(): Promise<RuntimeInfo> {
    // Capabilities describe *this adapter*, not the upstream binary: `permissions`
    // is false because we never wire a permission handler, and claiming otherwise
    // would let callers hand us a callback we silently drop. Same reasoning for
    // `images` and `sandbox`.
    const capabilities: RuntimeCapabilities = {
      streaming: true,
      sessions: true,
      resume: true,
      permissions: false,
      tools: true,
      models: true,
      images: false,
      usage: true,
      cost: true,
      sandbox: false,
    }
    try {
      // `encoding: "utf8"` (not `stdio: "ignore"`) so the version string is
      // captured. The throw path is unchanged and simply means "not installed".
      const version = execSync("claude --version", { encoding: "utf8" }).trim()
      return { name: this.name, version, available: true, capabilities }
    } catch {
      return { name: this.name, available: false, capabilities }
    }
  }

  async execute(task: AgentTask): Promise<AgentOutput> {
    // The prompt is *not* an argument. Templates inline whole documents through
    // `{{file:...}}`, and a large one would blow past `ARG_MAX` — the spawn then
    // fails with an opaque E2BIG reported as "Failed to start claude". Feeding it
    // over stdin has no such limit.
    //
    // `--output-format stream-json` turns stdout into NDJSON: tool calls, usage,
    // cost and the session id all ride along with the text instead of being
    // flattened into one opaque string.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--allowedTools",
      task.tools.join(","),
    ]
    if (task.systemPrompt) args.push("--system-prompt", task.systemPrompt)
    if (task.model) args.push("--model", task.model)
    if (task.sessionId) args.push("--session-id", task.sessionId)

    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: task.workDir,
        env: process.env,
        // Its own process group, so cancellation reaches the agent's children
        // too: `claude` spawns subprocesses of its own, and signalling only the
        // direct child would leave them running as orphans after the console
        // has moved on to the next turn.
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
        // No pid means there is no group to signal — a fake child in tests, or a
        // process that never started. Signal the child itself and move on.
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
        // A process that ignores SIGTERM would otherwise sit there until the
        // console is closed. That applies to a timeout as much as to an abort:
        // both leave the promise unsettled until `close`, so a stuck agent has
        // to be force-killed either way.
        escalation = setTimeout(() => killTree("SIGKILL"), KILL_ESCALATION_MS)
        escalation.unref()
      }

      task.signal?.addEventListener("abort", () => stop("SIGTERM"), { once: true })

      // `task.timeout` is the agent's own budget. The orchestrator also enforces
      // it with `withTimeout`, but a runtime that outlives that promise would
      // keep the process running, so the runtime enforces it too.
      let timedOut = false
      const timer =
        task.timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              stop("SIGTERM")
            }, task.timeout)

      const clearTimers = () => {
        if (timer) clearTimeout(timer)
        if (escalation) clearTimeout(escalation)
      }

      // A fresh id per run, and a counter that orders the events it carries.
      const runId = randomUUID()
      let seq = 0
      const emit = (event: RuntimeEventPayload) => {
        task.onEvent?.({ ...event, runId, agentId: task.agentId, seq: seq++ } as RuntimeEvent)
      }

      // State assembled from the stream and surfaced on the final AgentOutput.
      let sessionId: string | undefined
      let usage: AgentOutput["usage"]
      let costUsd: number | undefined
      let stopReason: string | undefined

      // Exactly-once text rule: with `--include-partial-messages` the CLI emits
      // both streaming `text_delta`s *and* the completed `assistant` message that
      // repeats the same text. Once a delta has been seen the assistant text
      // block is a duplicate and is dropped — only its `tool_use` blocks still
      // matter. If no delta ever arrives (an older CLI, or the flag being
      // ignored) the assistant message is the sole source of text and is used.
      //
      // The flag is deliberately run-scoped, not per-message:
      // `--include-partial-messages` is process-global, so a single run cannot
      // mix delta-bearing and delta-less turns, whereas resetting after each
      // assistant message would risk re-emitting duplicate text — the very
      // failure this guard exists to prevent.
      let sawAgentDelta = false
      let agentText = ""
      let resultText = ""

      const handleObject = (obj: unknown) => {
        if (!isRecord(obj)) {
          emit({ type: "raw", vendor: "claude", payload: obj })
          return
        }

        switch (obj.type) {
          case "system": {
            if (obj.subtype !== "init") {
              emit({ type: "raw", vendor: "claude", payload: obj })
              break
            }
            if (typeof obj.session_id === "string") sessionId = obj.session_id
            emit({
              type: "run_started",
              model: typeof obj.model === "string" ? obj.model : undefined,
            })
            break
          }
          case "stream_event": {
            const event = isRecord(obj.event) ? obj.event : undefined
            const delta = event && isRecord(event.delta) ? event.delta : undefined
            if (
              event?.type === "content_block_delta" &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              sawAgentDelta = true
              agentText += delta.text
              emit({ type: "message_delta", role: "agent", text: delta.text })
            } else if (
              event?.type === "content_block_delta" &&
              delta?.type === "thinking_delta" &&
              typeof delta.thinking === "string"
            ) {
              emit({ type: "message_delta", role: "thought", text: delta.thinking })
            } else {
              emit({ type: "raw", vendor: "claude", payload: obj })
            }
            break
          }
          case "assistant": {
            const message = isRecord(obj.message) ? obj.message : undefined
            const content = message && Array.isArray(message.content) ? message.content : undefined
            if (!content) {
              emit({ type: "raw", vendor: "claude", payload: obj })
              break
            }
            for (const block of content) {
              if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
                if (sawAgentDelta) continue // Already streamed as deltas.
                agentText += block.text
                emit({ type: "message", role: "agent", text: block.text })
              } else if (isRecord(block) && block.type === "tool_use") {
                emit({
                  type: "tool_call",
                  id: typeof block.id === "string" ? block.id : "",
                  name: typeof block.name === "string" ? block.name : "",
                  input: block.input,
                })
              } else {
                emit({ type: "raw", vendor: "claude", payload: block })
              }
            }
            break
          }
          case "user": {
            const message = isRecord(obj.message) ? obj.message : undefined
            const content = message && Array.isArray(message.content) ? message.content : undefined
            if (!content) {
              emit({ type: "raw", vendor: "claude", payload: obj })
              break
            }
            for (const block of content) {
              if (isRecord(block) && block.type === "tool_result") {
                emit({
                  type: "tool_result",
                  id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
                  output:
                    typeof block.content === "string"
                      ? block.content
                      : JSON.stringify(block.content),
                  isError: block.is_error === true,
                })
              } else {
                emit({ type: "raw", vendor: "claude", payload: block })
              }
            }
            break
          }
          case "result": {
            const rawUsage = isRecord(obj.usage) ? obj.usage : undefined
            const inputTokens =
              typeof rawUsage?.input_tokens === "number" ? rawUsage.input_tokens : undefined
            const outputTokens =
              typeof rawUsage?.output_tokens === "number" ? rawUsage.output_tokens : undefined
            usage = { inputTokens, outputTokens }
            emit({ type: "usage", inputTokens, outputTokens })

            costUsd = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined
            const modelBreakdown = isRecord(obj.modelUsage) ? obj.modelUsage : undefined
            emit({ type: "cost", costUsd, modelBreakdown })

            if (typeof obj.session_id === "string") sessionId = obj.session_id
            if (typeof obj.result === "string") resultText = obj.result

            const subtype = typeof obj.subtype === "string" ? obj.subtype : ""
            const finish: "success" | "max_turns" | "error" =
              subtype === "success"
                ? "success"
                : /max[_ ]?turns/i.test(subtype)
                  ? "max_turns"
                  : "error"
            stopReason = finish
            emit({ type: "run_finished", stopReason: finish })
            break
          }
          default:
            emit({ type: "raw", vendor: "claude", payload: obj })
        }
      }

      const handleLine = (line: string) => {
        const trimmed = line.trim()
        if (trimmed === "") return
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          // A non-JSON line — a stray log, a truncated write — must not kill the
          // run. Surface it as a raw event and carry on.
          emit({ type: "raw", vendor: "claude", payload: line })
          return
        }
        handleObject(parsed)
      }

      // A child that dies before reading its prompt makes the write fail with
      // EPIPE. That is not the interesting failure — the close/error handlers
      // below report the real one — so swallow it here.
      let errorOutput = ""
      child.stdin.on("error", () => {})
      child.stdin.end(task.prompt)

      // NDJSON over a byte stream is chunked arbitrarily, so a chunk can end
      // mid-line. Only complete (newline-terminated) lines are parsed; the
      // trailing partial line stays buffered until the next chunk completes it.
      //
      // Decoding goes through a stateful `StringDecoder` rather than
      // `Buffer.toString()`: the latter decodes each chunk independently, so a
      // multi-byte UTF-8 codepoint split across a chunk boundary (routine for
      // CJK or emoji output) would decode to U+FFFD on both sides and silently
      // corrupt the agent's text.
      let buffer = ""
      const decoder = new StringDecoder("utf8")
      child.stdout.on("data", (d: Buffer) => {
        buffer += decoder.write(d)
        let nl = buffer.indexOf("\n")
        while (nl !== -1) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          handleLine(line)
          nl = buffer.indexOf("\n")
        }
      })
      const stderrDecoder = new StringDecoder("utf8")
      child.stderr.on("data", (d: Buffer) => {
        errorOutput += stderrDecoder.write(d)
      })
      child.on("close", (code) => {
        clearTimers()
        // Flush both decoders first: each may hold the tail of a codepoint whose
        // remaining bytes never arrived, and any decoded bytes must land before
        // the trailing line / error string is handled.
        buffer += decoder.end()
        errorOutput += stderrDecoder.end()
        // No more chunks will arrive, so flush whatever the last, newline-less
        // line held. A truncated line simply fails to parse and becomes `raw`.
        if (buffer.length > 0) {
          handleLine(buffer)
          buffer = ""
        }
        // Settle on cancellation too — returning here without resolving or
        // rejecting would leave the caller's promise pending forever.
        if (task.signal?.aborted) {
          reject(abortError())
          return
        }
        if (timedOut) {
          reject(new Error(`claude timed out (${task.timeout}ms)`))
          return
        }
        code === 0
          ? resolve({
              // Agent-role text, or the final `result` string when the stream
              // carried no deltas/messages. Callers persist this verbatim.
              output: agentText || resultText,
              exitCode: code,
              sessionId,
              usage,
              costUsd,
              stopReason,
            })
          : reject(new Error(`claude exited with code ${code}: ${errorOutput}`))
      })
      child.on("error", (err) => {
        clearTimers()
        reject(new Error(`Failed to start claude: ${err.message}`))
      })
    })
  }
}
