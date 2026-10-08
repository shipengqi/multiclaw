export interface AgentTask {
  agentId: string
  systemPrompt: string
  prompt: string
  tools: string[]
  workDir: string
  timeout: number
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}

export interface AgentOutput {
  output: string
  exitCode: number
}

export interface AgentRuntime {
  readonly name: string
  checkAvailable(): Promise<boolean>
  execute(task: AgentTask): Promise<AgentOutput>
}

