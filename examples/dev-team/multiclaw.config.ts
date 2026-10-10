import { agents, defineConfig } from "multiclaw"

export default defineConfig({
  name: "Dev Team Demo",
  workDir: "./workspace",
  context: {
    projectName: "Todo App",
    requirement: "Build a Todo API with CRUD operations",
  },
  leader: agents.leader({ model: "haiku" }),
  agents: [
    agents.architect({ model: "haiku" }),
    agents.backendDeveloper({ model: "haiku", dependsOn: ["architect"] }),
    agents.tester({ model: "haiku", dependsOn: ["backend-developer"] }),
    agents.codeReviewer({ model: "haiku", dependsOn: ["tester"] }),
  ],
})
