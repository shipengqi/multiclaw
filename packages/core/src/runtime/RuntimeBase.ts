import type { AgentOutput, AgentRuntime, AgentTask, RuntimeInfo } from "../types/runtime"

export abstract class RuntimeBase implements AgentRuntime {
  abstract readonly name: string
  abstract describe(): Promise<RuntimeInfo>
  abstract execute(task: AgentTask): Promise<AgentOutput>
}
