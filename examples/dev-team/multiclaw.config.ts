import { agents, defineConfig } from "multiclaw"

export default defineConfig({
  name: "Dev Team Demo",
  workDir: "./workspace",
  context: {
    projectName: "Todo App",
    requirement: "Build a Todo API with CRUD operations",
  },
  // Project-wide defaults: every agent uses the claude provider with the
  // sonnet model unless it overrides them below. One block instead of twelve.
  defaults: {
    provider: "claude",
    model: "sonnet",
  },
  agents: [
    agents.architect({ model: "haiku" }),
    agents.backendDeveloper({ model: "haiku", dependsOn: ["architect"] }),
    agents.tester({ model: "haiku", dependsOn: ["backend-developer"] }),
    agents.codeReviewer({ model: "haiku", dependsOn: ["tester"] }),
  ],
  reviewGates: [
    { reviewer: "tester", repairAgents: ["backend-developer"], maxRepairRounds: 3 },
    {
      reviewer: "code-reviewer",
      repairAgents: ["backend-developer", "tester"],
      maxRepairRounds: 3,
    },
  ],
})
