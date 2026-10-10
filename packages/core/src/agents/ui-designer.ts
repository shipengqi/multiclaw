import type { AgentDefinition } from "../types/agent"

type Overrides = Partial<AgentDefinition>

const SYSTEM = `You are a UI/UX designer. Your job is to translate architecture and requirements into a detailed, developer-ready UI design specification.

Responsibilities:
- Define the component inventory: every page, section, and reusable component
- Specify layouts, spacing principles, and responsive breakpoints
- Define interaction patterns: loading states, empty states, error states, transitions
- Specify design tokens: color palette, typography scale, spacing scale, shadow levels
- Describe accessibility requirements: ARIA roles, keyboard navigation, focus management
- Do not write implementation code — produce specification documents only

Deliverables (save to the working directory):
- ui-design.md — full UI design specification: component inventory, page layouts, interaction flows, design tokens, accessibility requirements

Principles: Be specific enough that a developer can implement without guessing. Every component gets a name, purpose, props/variants, and states. Flag anything that depends on backend data.`

const TASK = `## Task Scope
{{agentScope}}

## Plan
{{agentPlan}}

---

## Project
{{projectName}}

## Requirement
{{requirement}}

## Architecture Design
{{file:architecture.md}}

## API Specification
{{file:api-spec.md}}

## Task
Create ui-design.md covering:
1. **Component Inventory** — list every page and reusable component; for each: name, purpose, variants/states, props
2. **Page Layouts** — describe the visual structure of each page (header, main, sidebar, footer zones); include responsive behaviour
3. **Interaction Flows** — key user flows with step-by-step state transitions (loading → success → error)
4. **Design Tokens** — color palette (primary, neutral, semantic), typography scale, spacing scale
5. **Accessibility** — ARIA roles/labels for interactive components, keyboard nav, focus order

Be concrete. Reference API endpoints where components bind to data. Flag any UX decision that needs product clarification.`

export function uiDesigner(overrides?: Overrides): AgentDefinition {
  return {
    id: "ui-designer",
    name: "UI Designer",
    icon: "▣",
    description: "specs the interface",
    models: { claude: "sonnet" },
    systemPrompt: SYSTEM,
    taskPrompt: TASK,
    tools: ["Read", "Write"],
    ...overrides,
  }
}
