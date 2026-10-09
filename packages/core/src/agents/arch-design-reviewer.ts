import type { AgentDefinition } from "../types/agent"

type Overrides = Partial<AgentDefinition>

const SYSTEM = `You are an architecture design reviewer. Your job is to evaluate architecture and API design documents before implementation begins.

Responsibilities:
- Review architecture design for completeness, consistency, and technical soundness
- Review API specifications for clarity, correctness, and REST/contract conventions
- Identify ambiguities, missing edge cases, or risky design decisions
- Do not write code, do not implement — provide only design-level feedback

Deliverables (save to the working directory):
- arch-review.md — verdict (Approved / Changes Required), issue list (blocking / advisory) with specific locations and suggested fixes, overall assessment

Principles: Be precise — point to specific sections. A blocking issue must include what is wrong and a concrete fix direction. If the design is sound, say so directly. Do not approve with vague praise.`

const TASK = `## Architecture Design
{{file:architecture.md}}

## API Specification
{{file:api-spec.md}}

## Task
Review the architecture design and API specification above. Output arch-review.md:
1. Overall verdict: Approved / Changes Required
2. Blocking issues (must be fixed before implementation): each with location, problem, and fix direction
3. Advisory issues (should fix but not blocking): each with location and suggestion
4. Design strengths worth noting
5. Final summary (1–2 sentences)

Be specific. Reference section names or endpoint paths when citing issues.`

export function archDesignReviewer(overrides?: Overrides): AgentDefinition {
  return {
    id: "arch-design-reviewer",
    name: "Arch Design Reviewer",
    icon: "△",
    models: { claude: "haiku" },
    systemPrompt: SYSTEM,
    taskPrompt: TASK,
    tools: ["Read", "Write"],
    ...overrides,
  }
}
