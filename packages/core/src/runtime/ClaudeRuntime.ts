import { execSync, spawn } from "node:child_process"
import type { AgentOutput, AgentTask } from "../types/runtime"
import { abortError } from "../utils/abort"
import { RuntimeBase } from "./RuntimeBase"

/** Grace period between SIGTERM and SIGKILL when an agent will not stop. */
const KILL_ESCALATION_MS = 3000

export class ClaudeRuntime extends RuntimeBase {
  readonly name = "claude"

  async checkAvailable(): Promise<boolean> {
    try {
      execSync("claude --version", { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }

  async execute(task: AgentTask): Promise<AgentOutput> {
    // The prompt is *not* an argument. Templates inline whole documents through
    // `{{file:...}}`, and a large one would blow past `ARG_MAX` — the spawn then
    // fails with an opaque E2BIG reported as "Failed to start claude". Feeding it
    // over stdin has no such limit.
    const args = ["-p", "--allowedTools", task.tools.join(",")]
    if (task.systemPrompt) args.push("--system-prompt", task.systemPrompt)
    if (task.model) args.push("--model", task.model)

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
      const stop = (reason: "abort" | "timeout", signal: NodeJS.Signals) => {
        if (stopped) return
        stopped = true
        killTree(signal)
        if (reason === "abort") {
          // A process that ignores SIGTERM would otherwise sit there until the
          // console is closed.
          escalation = setTimeout(() => killTree("SIGKILL"), KILL_ESCALATION_MS)
          escalation.unref()
        }
      }

      task.signal?.addEventListener("abort", () => stop("abort", "SIGTERM"), { once: true })

      // `task.timeout` is the agent's own budget. The orchestrator also enforces
      // it with `withTimeout`, but a runtime that outlives that promise would
      // keep the process running, so the runtime enforces it too.
      let timedOut = false
      const timer =
        task.timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              stop("timeout", "SIGTERM")
            }, task.timeout)

      const clearTimers = () => {
        if (timer) clearTimeout(timer)
        if (escalation) clearTimeout(escalation)
      }

      let output = ""
      let errorOutput = ""
      // A child that dies before reading its prompt makes the write fail with
      // EPIPE. That is not the interesting failure — the close/error handlers
      // below report the real one — so swallow it here.
      child.stdin.on("error", () => {})
      child.stdin.end(task.prompt)
      child.stdout.on("data", (d: Buffer) => {
        const chunk = d.toString()
        output += chunk
        task.onOutput?.(chunk)
      })
      child.stderr.on("data", (d: Buffer) => {
        errorOutput += d.toString()
      })
      child.on("close", (code) => {
        clearTimers()
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
          ? resolve({ output, exitCode: code })
          : reject(new Error(`claude exited with code ${code}: ${errorOutput}`))
      })
      child.on("error", (err) => {
        clearTimers()
        reject(new Error(`Failed to start claude: ${err.message}`))
      })
    })
  }
}
