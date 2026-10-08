import { spawn, execSync } from "child_process"
import { RuntimeBase } from "./RuntimeBase"
import type { AgentTask, AgentOutput } from "../types/runtime"

export class CodexRuntime extends RuntimeBase {
  readonly name = "codex"

  async checkAvailable(): Promise<boolean> {
    try { execSync("codex --version", { stdio: "ignore" }); return true }
    catch { return false }
  }

  async execute(task: AgentTask): Promise<AgentOutput> {
    const prompt = task.systemPrompt
      ? `${task.systemPrompt}\n\n${task.prompt}`
      : task.prompt

    const sandbox = task.tools.includes("Bash")
      ? "danger-full-access"
      : task.tools.some((t) => ["Write", "Edit", "MultiEdit"].includes(t))
        ? "workspace-write"
        : "read-only"

    const args = [
      "exec", prompt,
      "-C", task.workDir,
      "--sandbox", sandbox,
      "--skip-git-repo-check",
      "--color", "never",
    ]

    return new Promise((resolve, reject) => {
      const child = spawn("codex", args, { cwd: task.workDir, env: process.env })
      task.signal?.addEventListener("abort", () => child.kill())

      let output = ""
      let errorOutput = ""
      child.stdout.on("data", (d: Buffer) => {
        const chunk = d.toString(); output += chunk; task.onOutput?.(chunk)
      })
      child.stderr.on("data", (d: Buffer) => { errorOutput += d.toString() })
      child.on("close", (code) => {
        if (task.signal?.aborted) return
        code === 0
          ? resolve({ output, exitCode: code })
          : reject(new Error(`codex exited with code ${code}: ${errorOutput}`))
      })
      child.on("error", (err) => reject(new Error(`Failed to start codex: ${err.message}`)))
    })
  }
}

