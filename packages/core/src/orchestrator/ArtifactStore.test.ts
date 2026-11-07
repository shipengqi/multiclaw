import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { renderPrompt } from "../utils/prompt"
import { ArtifactStore } from "./ArtifactStore"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("ArtifactStore", () => {
  it("shares planning files while isolating reports by agent and work", () => {
    const store = new ArtifactStore(root, "work-1")
    store.prepare("backend")
    expect(store.resolve("architecture.md", "backend")).toBe(
      path.join(root, ".multiclaw/works/work-1/planning/architecture.md")
    )
    expect(store.resolve("architecture.md", "frontend")).toBe(
      store.resolve("architecture.md", "backend")
    )
    expect(store.resolve("implementation-notes.md", "backend")).not.toBe(
      store.resolve("implementation-notes.md", "frontend")
    )
    expect(new ArtifactStore(root, "work-2").resolve("architecture.md", "backend")).not.toBe(
      store.resolve("architecture.md", "backend")
    )
    expect(fs.readFileSync(path.join(root, ".multiclaw/.gitignore"), "utf8")).toBe("*\n")
  })

  it("renders cross-agent artifacts without changing normal workspace file references or content", async () => {
    const store = new ArtifactStore(root, "work-1")
    store.prepare("backend")
    const source = "API contract $$ $& {{artifact:architecture.md}}"
    fs.writeFileSync(store.resolve("api-spec.md", "backend"), source)
    fs.writeFileSync(store.resolve("implementation-notes.md", "backend"), "backend evidence")
    fs.writeFileSync(path.join(root, "README.md"), "project readme")
    const rendered = await renderPrompt(
      "{{artifact:architecture.md}}\n{{file:artifact:api-spec.md}}\n{{file:artifact:agents/backend/implementation-notes.md}}\n{{file:README.md}}\n{{requirement}}",
      { requirement: "keep {{artifact:architecture.md}} literally in user input" },
      root,
      {
        resolve: (name) => store.resolve(name, "reviewer"),
        readPath: (name) => store.readPath(name, "reviewer"),
      }
    )
    expect(rendered).toBe(
      `${store.resolve("architecture.md", "reviewer")}\n${source}\nbackend evidence\nproject readme\nkeep {{artifact:architecture.md}} literally in user input`
    )
  })

  it("keeps explicit task-plan configuration authoritative", () => {
    const custom = path.join(root, "custom/plan.json")
    const store = new ArtifactStore(root, "work-1", custom)
    store.prepare("planner")
    fs.writeFileSync(custom, "plan")
    expect(store.resolve("task-plan.json", "dev")).toBe(custom)
    store.clearTaskPlan()
    expect(fs.existsSync(custom)).toBe(false)
  })

  it("reads legacy designs only on continuation and never deletes legacy files", () => {
    const legacy = path.join(root, "architecture.md")
    const plan = path.join(root, "task-plan.json")
    fs.writeFileSync(legacy, "old design")
    fs.writeFileSync(plan, "old plan")
    const fresh = new ArtifactStore(root, "new-work")
    expect(fresh.readPath("architecture.md", "dev")).not.toBe(legacy)
    const continued = new ArtifactStore(root, "old-work", undefined, root)
    expect(continued.readPath("architecture.md", "dev")).toBe(legacy)
    expect(continued.readPath("task-plan.json", "dev")).toBe(plan)
    continued.clearTaskPlan()
    expect(continued.readPath("task-plan.json", "dev")).not.toBe(plan)
    expect(fs.readFileSync(plan, "utf8")).toBe("old plan")
  })

  it("lists all producers' real files and atomically records a manifest", () => {
    const store = new ArtifactStore(root, "work-1")
    for (const agent of ["backend", "frontend"]) {
      store.prepare(agent)
      fs.writeFileSync(store.resolve("implementation-notes.md", agent), agent)
    }
    const other = new ArtifactStore(root, "work-2")
    other.prepare("other")
    fs.writeFileSync(other.resolve("secret.md", "other"), "unrelated")
    const instruction = store.instruction("reviewer")
    expect(instruction).toContain(store.resolve("implementation-notes.md", "backend"))
    expect(instruction).toContain(store.resolve("implementation-notes.md", "frontend"))
    expect(instruction).not.toContain("secret.md")
    store.record({ id: "work-1", originalRequirement: "build", requirement: "build", agents: [] })
    const manifest = JSON.parse(
      fs.readFileSync(path.join(store.directory, "manifest.json"), "utf8")
    )
    expect(manifest.artifacts.map((item: { path: string }) => item.path)).toEqual([
      "agents/backend/implementation-notes.md",
      "agents/frontend/implementation-notes.md",
    ])
    expect(fs.readdirSync(store.directory).some((name) => name.endsWith(".tmp"))).toBe(false)
  })

  it.each(["../outside.md", "agents/dev/../../../outside.md", "/etc/passwd", "..\\outside.md"])(
    "rejects artifact traversal: %s",
    (reference) => {
      expect(() => new ArtifactStore(root, "work-1").resolve(reference, "dev")).toThrow()
    }
  )

  it.each(["../outside", "..", "a/b", "a\\b"])("rejects unsafe work and agent ids: %s", (id) => {
    expect(() => new ArtifactStore(root, id)).toThrow()
    expect(() => new ArtifactStore(root, "work-1").resolve("notes.md", id)).toThrow()
  })
})
