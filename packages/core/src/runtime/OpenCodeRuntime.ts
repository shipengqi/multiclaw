import { spawn, execSync } from "child_process"
import { RuntimeBase } from "./RuntimeBase"
import type { AgentTask, AgentOutput } from "../types/runtime"

export class OpenCodeRuntime extends RuntimeBase {
  readonly name = "opencode"

  async checkAvailable(): Promise<boolean> {
    try { execSync("opencode --version", { stdio: "ignore" }); return true }
    catch { return false }
  }

  async execute(task: AgentTask): Promise<AgentOutput> {
    const prompt = task.systemPrompt
      ? `${task.systemPrompt}\n\n${task.prompt}`
      : task.prompt

    const args = ["run", prompt, "-q"]

    return new Promise((resolve, reject) => {
      const child = spawn("opencode", args, { cwd: task.workDir, env: process.env })
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
          : reject(new Error(`opencode exited with code ${code}: ${errorOutput}`))
      })
      child.on("error", (err) => reject(new Error(`Failed to start opencode: ${err.message}`)))
    })
  }
}

