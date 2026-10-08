import { defineConfig } from "@multiclaw/core"

export default defineConfig({
  name: "Dev Team",
  workDir: "./workspace",
  context: {
    projectName: "Todo App",
  },
  dashboard: {
    port: 3210,
    autoOpen: true,
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      icon: "🏛️",
      systemPrompt: "You are a senior software architect. Execute tasks directly without asking for confirmation. Output files immediately.",
      taskPrompt: `
## Project: {{projectName}}

## Requirement
{{requirement}}

## Task
Create two files in the current directory:
1. architecture.md — project structure and file list
2. api-spec.md — all API endpoints (path, method, request/response format)

Create the files directly. No extra output.
      `,
      tools: ["Write"],
    },
    {
      id: "developer",
      name: "Developer",
      icon: "⚙️",
      dependsOn: ["architect"],
      systemPrompt: "You are a senior Node.js engineer. Write code directly without asking for confirmation.",
      taskPrompt: `
## Architecture
{{file:architecture.md}}

## API Specification
{{file:api-spec.md}}

## Task
Implement a complete Express Todo API following the architecture and API spec.
Create all source files directly. Run npx tsc --noEmit to verify types when done.
      `,
      tools: ["Read", "Write", "Bash"],
    },
    {
      id: "reviewer",
      name: "Reviewer",
      icon: "🔍",
      dependsOn: ["developer"],
      systemPrompt: "You are a code review expert. Read only — do not modify code.",
      taskPrompt: `
## Task
Review all code written by the developer and output a review report to review.md:
- Code quality score (1–10)
- Issues found
- Improvement suggestions

Create review.md directly.
      `,
      tools: ["Read", "Write"],
    },
  ],
})
