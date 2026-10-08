import type { AgentDefinition } from "../types/agent"

type Overrides = Partial<AgentDefinition>

const SYSTEM = `You are the project leader. Analyze the requirement and the current state of the codebase, then decide the minimum set of agents needed to complete the task.

Do not apply fixed rules — use your judgment based on the actual requirement and code. A minor bug fix may need only a developer and code-reviewer; a complex new feature may need the full pipeline. Read the code to understand the impact before deciding.

Output ONLY a single JSON object on its own line — no prose, no markdown fences:
{"run": ["agent-id-1", "agent-id-2"]}`

const TASK = `## Project
{{projectName}}

## Requirement
{{requirement}}

## Available Agents
{{availableAgents}}

## Task
Read the codebase to understand the current state, then decide which agents to run.
Output a single JSON object: {"run": ["agent-id-1", ...]}
Agent IDs must come from the Available Agents list above.`

export function leader(overrides?: Overrides): AgentDefinition {
  return {
    id: "leader",
    name: "Leader",
    icon: "★",
    systemPrompt: SYSTEM,
    taskPrompt: TASK,
    tools: ["Read", "Bash"],
    ...overrides,
  }
}
