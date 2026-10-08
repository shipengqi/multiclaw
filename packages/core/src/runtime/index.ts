import type { AgentRuntime } from "../types/runtime"
import { ClaudeRuntime } from "./ClaudeRuntime"
import { CodexRuntime } from "./CodexRuntime"
import { OpenCodeRuntime } from "./OpenCodeRuntime"
import { CursorRuntime } from "./CursorRuntime"

class RuntimeRegistry {
  private runtimes = new Map<string, AgentRuntime>()
  constructor() {
    this.register(new ClaudeRuntime())
    this.register(new CodexRuntime())
    this.register(new OpenCodeRuntime())
    this.register(new CursorRuntime())
  }
  register(r: AgentRuntime) { this.runtimes.set(r.name, r) }
  get(name: string): AgentRuntime {
    const r = this.runtimes.get(name)
    if (!r) throw new Error(`Runtime not found: "${name}". Available: ${[...this.runtimes.keys()].join(", ")}`)
    return r
  }
  has(name: string) { return this.runtimes.has(name) }
  list(): string[] { return [...this.runtimes.keys()] }
}

export const runtimeRegistry = new RuntimeRegistry()
export { ClaudeRuntime, CodexRuntime, OpenCodeRuntime, CursorRuntime }
