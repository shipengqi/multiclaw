import type {
  AgentOutput,
  AgentRuntime,
  AgentTask,
  RuntimeInfo,
  RuntimeQuery,
} from "../types/runtime"

export abstract class RuntimeBase implements AgentRuntime {
  abstract readonly name: string
  abstract describe(options?: RuntimeQuery): Promise<RuntimeInfo>
  abstract execute(task: AgentTask): Promise<AgentOutput>
}
