import { spawn, execSync } from "child_process"
import { RuntimeBase } from "./RuntimeBase"
import type { AgentTask, AgentOutput } from "../types/runtime"

export class ClaudeRuntime extends RuntimeBase {
  readonly name = "claude"

  async checkAvailable(): Promise<boolean> {
    try { execSync("claude --version", { stdio: "ignore" }); return true }
    catch { return false }
  }

  async execute(task: AgentTask): Promise<AgentOutput> {
    const args = [
      "-p", task.prompt,
      "--allowedTools", task.tools.join(","),
    ]
    if (task.systemPrompt) args.push("--system-prompt", task.systemPrompt)
    if (task.model) args.push("--model", task.model)

    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, { cwd: task.workDir, env: process.env })
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
          : reject(new Error(`claude exited with code ${code}: ${errorOutput}`))
      })
      child.on("error", (err) => reject(new Error(`Failed to start claude: ${err.message}`)))
    })
  }
}

