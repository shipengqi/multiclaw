import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { agents } from "../agents"
import { runtimeRegistry } from "../runtime"
import { fakeRuntime, makeAgent } from "../testing/helpers"
import { TestOrchestrator as Orchestrator, type TestConfig } from "../testing/orchestration"
import type { WorkContext } from "../types/config"
import type { AgentOutput, AgentTask } from "../types/runtime"

const runtime = "test-collaboration-artifacts"
let root: string
let seen: AgentTask[]
let handler: (task: AgentTask) => Promise<AgentOutput>
beforeAll(() =>
  runtimeRegistry.register(
    fakeRuntime(runtime, (task) => {
      seen.push(task)
      return handler(task)
    })
  )
)
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-"))
  seen = []
  handler = async () => ({ output: "done", exitCode: 0 })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const directory = (task: AgentTask) => path.join(root, ".multiclaw", "works", task.workId!)
const write = (task: AgentTask, file: string, content: string) => {
  const target = path.join(directory(task), file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}
const config = (overrides: Partial<TestConfig> = {}): TestConfig => ({
  name: "artifacts",
  workDir: root,
  context: { requirement: "Build an API and UI" },
  agents: [
    agents.architect({ runtime }),
    agents.backendDeveloper({ runtime, dependsOn: ["architect"] }),
    agents.frontendDeveloper({ runtime, dependsOn: ["architect"] }),
    agents.codeReviewer({ runtime, dependsOn: ["backend-developer", "frontend-developer"] }),
  ],
  ...overrides,
})

describe("cross-agent collaboration artifacts", () => {
  it("preserves explicit plan overrides for legacy custom planner templates", async () => {
    handler = async (task) => {
      if (task.agentId === "custom-planner") {
        expect(task.prompt).toContain("Write custom/plan.json")
        expect(task.systemPrompt).toContain("Output custom/plan.json")
        fs.writeFileSync(
          path.join(root, "custom/plan.json"),
          JSON.stringify({ tasks: [{ id: "dev", scope: "custom scope" }] })
        )
      }
      return { output: "done", exitCode: 0 }
    }
    const result = await new Orchestrator(
      config({
        context: { taskPlanPath: "custom/plan.json" },
        agents: [
          makeAgent({
            id: "custom-planner",
            runtime,
            role: "planner",
            systemPrompt: "Output task-plan.json",
            taskPrompt: "Write task-plan.json",
          }),
          makeAgent({ id: "dev", runtime, dependsOn: ["custom-planner"] }),
        ],
      })
    ).run()
    expect(result.success).toBe(true)
    expect(seen[1].prompt).toContain("custom scope")
  })

  it("retains read-only legacy context across successive retries without moving root files", async () => {
    fs.writeFileSync(path.join(root, "architecture.md"), "LEGACY DESIGN")
    const first = await new Orchestrator(
      config({ resume: { agents: ["backend-developer"] } })
    ).run()
    expect(first.success).toBe(true)
    expect(first.work?.artifactVersion).toBeUndefined()
    expect(seen[0].prompt).toContain("LEGACY DESIGN")
    seen = []
    const second = await new Orchestrator(
      config({ latestWork: first.work, resume: { agents: ["backend-developer"] } })
    ).run()
    expect(second.success).toBe(true)
    expect(seen[0].prompt).toContain("LEGACY DESIGN")
    expect(fs.readFileSync(path.join(root, "architecture.md"), "utf8")).toBe("LEGACY DESIGN")
  })

  it("preview does not create collaboration storage", async () => {
    await new Orchestrator(config()).preview()
    expect(fs.existsSync(path.join(root, ".multiclaw"))).toBe(false)
    expect(seen).toEqual([])
  })

  it("passes designs and task-plan scopes to parallel workers, then exposes both workers' reports to review", async () => {
    handler = async (task) => {
      expect(task.workDir).toBe(root)
      expect(task.prompt).not.toMatch(/\{\{(?:artifact:|file:)/)
      expect(task.systemPrompt).not.toContain("{{artifact:")
      if (task.agentId === "architect") {
        write(task, "planning/architecture.md", "SHARED ARCHITECTURE")
        write(task, "planning/api-spec.md", "SHARED API SPEC")
        write(
          task,
          "planning/task-plan.json",
          JSON.stringify({
            tasks: [
              { id: "backend-developer", scope: "Backend only", plan: ["Implement API"] },
              { id: "frontend-developer", scope: "Frontend only", plan: ["Implement UI"] },
            ],
          })
        )
      } else if (task.agentId.endsWith("developer")) {
        expect(task.prompt).toContain("SHARED ARCHITECTURE")
        expect(task.prompt).toContain("SHARED API SPEC")
        expect(task.prompt).toContain(
          task.agentId.startsWith("backend") ? "Backend only" : "Frontend only"
        )
        const report = `agents/${task.agentId}/implementation-notes.md`
        expect(task.prompt).toContain(path.join(directory(task), report))
        write(task, report, `evidence from ${task.agentId}`)
        fs.writeFileSync(path.join(root, "README.md"), "formal project documentation")
      } else {
        for (const producer of ["backend-developer", "frontend-developer"]) {
          const report = path.join(directory(task), "agents", producer, "implementation-notes.md")
          expect(task.prompt).toContain(report)
          expect(fs.readFileSync(report, "utf8")).toBe(`evidence from ${producer}`)
        }
        write(task, "agents/code-reviewer/code-review.md", "approved")
      }
      return { output: "done", exitCode: 0 }
    }
    const result = await new Orchestrator(config()).run()
    expect(result.success).toBe(true)
    expect(result.work?.artifactVersion).toBe(1)
    expect(result.work?.artifactDirectory).toBe(directory(seen[0]))
    expect(fs.readdirSync(root).sort()).toEqual([".multiclaw", "README.md"])
    expect(new Set(seen.map((task) => task.workId)).size).toBe(1)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory(seen[0]), "manifest.json"), "utf8")
    )
    expect(manifest.artifacts).toHaveLength(6)
  })

  it("isolates new tasks and preserves unrelated root documents", async () => {
    fs.writeFileSync(path.join(root, "architecture.md"), "ROOT DOCUMENT")
    handler = async (task) => {
      if (task.agentId === "architect") write(task, "planning/architecture.md", "FIRST TASK DESIGN")
      return { output: "done", exitCode: 0 }
    }
    const first = await new Orchestrator(config()).run()
    seen = []
    const second = await new Orchestrator(
      config({ agents: [agents.backendDeveloper({ runtime })] })
    ).run()
    expect(second.work?.id).not.toBe(first.work?.id)
    expect(seen[0].prompt).not.toContain("FIRST TASK DESIGN")
    expect(seen[0].prompt).not.toContain("ROOT DOCUMENT")
    expect(fs.readFileSync(path.join(root, "architecture.md"), "utf8")).toBe("ROOT DOCUMENT")
  })

  it("reuses the same work artifacts for a single-agent retry", async () => {
    handler = async (task) => {
      if (task.agentId === "architect") write(task, "planning/architecture.md", "CONTINUED DESIGN")
      return { output: "done", exitCode: 0 }
    }
    const first = await new Orchestrator(config()).run()
    const work = first.work as WorkContext
    seen = []
    const retry = await new Orchestrator(
      config({ latestWork: work, resume: { agents: ["backend-developer"] } })
    ).run()
    expect(retry.success).toBe(true)
    expect(retry.work?.id).toBe(work.id)
    expect(seen).toHaveLength(1)
    expect(seen[0].prompt).toContain("CONTINUED DESIGN")
    expect(seen[0].workId).toBe(work.id)
  })

  it("uses the project storage root even when an agent has a subdirectory cwd", async () => {
    const workDir = path.join(root, "workspace")
    const result = await new Orchestrator(
      config({
        projectDir: root,
        workDir,
        agents: [
          makeAgent({
            id: "custom",
            runtime,
            workDir: "nested",
            taskPrompt: "Write {{artifact:notes.md}}",
          }),
        ],
      })
    ).run()
    expect(result.success).toBe(true)
    expect(seen[0].workDir).toBe(path.join(workDir, "nested"))
    expect(seen[0].prompt).toContain(
      path.join(root, ".multiclaw", "works", result.work!.id, "agents/custom/notes.md")
    )
    expect(fs.existsSync(path.join(workDir, ".multiclaw"))).toBe(false)
  })

  it("uses a configured plan path for both the producer prompt and downstream planning", async () => {
    const custom = path.join(root, "custom/plan.json")
    handler = async (task) => {
      if (task.agentId === "architect") {
        expect(task.prompt).toContain(`3. ${custom}`)
        expect(task.systemPrompt).toContain(custom)
        fs.writeFileSync(
          custom,
          JSON.stringify({ tasks: [{ id: "backend-developer", scope: "CUSTOM PLAN SCOPE" }] })
        )
      }
      return { output: "done", exitCode: 0 }
    }
    const result = await new Orchestrator(
      config({ context: { requirement: "build", taskPlanPath: "custom/plan.json" } })
    ).run()
    expect(result.success).toBe(true)
    expect(seen.find((task) => task.agentId === "backend-developer")?.prompt).toContain(
      "CUSTOM PLAN SCOPE"
    )
  })
})
