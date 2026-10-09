import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: "Dev Team Demo",
  workDir: "./workspace",
  context: {
    projectName: "Todo App",
  },
  dashboard: { port: 3210, autoOpen: true },
  leader: agents.leader({model: 'haiku'}),  // uncomment to enable dynamic routing
  agents: [
    {
      id: "architect",
      name: "Architect",
      icon: "◆",
      model: 'haiku',
      taskPrompt: `Write a file named architecture.md with this exact content:

# Architecture

## Stack
- Runtime: Node.js
- Framework: Express
- Database: SQLite

## Endpoints
- GET  /todos        list all todos
- POST /todos        create a todo
- PUT  /todos/:id    update a todo
- DELETE /todos/:id  delete a todo

Do nothing else.`,
      tools: ["Write"],
    },
    {
      id: "developer",
      name: "Developer",
      icon: "⊕",
      model: 'haiku',
      dependsOn: ["architect"],
      taskPrompt: `Read architecture.md, then write implementation-notes.md with this exact content:

# Implementation Notes

## Commands
- Install: npm install
- Start: node index.js
- Test: npm test

## Notes
- All endpoints implemented per architecture.md
- SQLite database created on first run

Do nothing else.`,
      tools: ["Read", "Write"],
    },
    {
      id: "reviewer",
      name: "Reviewer",
      icon: "◉",
      model: 'haiku',
      dependsOn: ["developer"],
      taskPrompt: `Read architecture.md and implementation-notes.md, then write review.md with this exact content:

# Code Review

Score: 9/10
Verdict: Approved

## Summary
Architecture is clean and implementation follows the spec.
No blocking issues found.

Do nothing else.`,
      tools: ["Read", "Write"],
    },
  ],
})
