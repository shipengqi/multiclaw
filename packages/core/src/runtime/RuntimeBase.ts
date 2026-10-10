import type { AgentOutput, AgentRuntime, AgentTask } from "../types/runtime"

export abstract class RuntimeBase implements AgentRuntime {
  abstract readonly name: string
  abstract checkAvailable(): Promise<boolean>
  abstract execute(task: AgentTask): Promise<AgentOutput>
}
