import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { WorkContext } from "../types/config"
import { ensureMulticlawDir } from "../utils/multiclawDir"

const PLANNING_FILES = new Set([
  "requirements.md",
  "architecture.md",
  "api-spec.md",
  "ui-design.md",
  "task-plan.json",
])

/** One work's shared designs and agent-owned reports, independent of agent cwd. */
export class ArtifactStore {
  readonly directory: string
  private allowLegacyPlan = true

  constructor(
    private projectDir: string,
    workId: string,
    private configuredTaskPlan?: string,
    private legacyWorkDir?: string
  ) {
    this.directory = path.join(path.resolve(projectDir), ".multiclaw", "works", segment(workId))
  }

  /** Bare design names are shared; other bare names belong to the requesting agent. */
  resolve(reference: string, agentId: string): string {
    if (reference === "task-plan.json" && this.configuredTaskPlan) return this.configuredTaskPlan
    const relative = PLANNING_FILES.has(reference)
      ? path.join("planning", reference)
      : path.join("agents", segment(agentId), reference)
    // Explicit planning/... and agents/... references support custom cross-agent artifacts.
    const target = path.resolve(
      this.directory,
      /^(planning|agents)[/\\]/.test(reference) ? reference : relative
    )
    if (!target.startsWith(this.directory + path.sep))
      throw new Error(`Artifact outside work directory: ${reference}`)
    // Refuse traversal even if normalization would land inside another agent's directory.
    if (path.isAbsolute(reference) || reference.split(/[/\\]/).includes(".."))
      throw new Error(`Invalid artifact reference: ${reference}`)
    return target
  }

  /** Legacy continuation is read-only fallback, never a new work's input. */
  readPath(reference: string, agentId: string): string {
    const target = this.resolve(reference, agentId)
    if (
      this.legacyWorkDir &&
      PLANNING_FILES.has(reference) &&
      (reference !== "task-plan.json" || (this.allowLegacyPlan && !this.configuredTaskPlan)) &&
      !fs.existsSync(target)
    ) {
      const legacy = path.join(this.legacyWorkDir, reference)
      if (fs.existsSync(legacy)) return legacy
    }
    return target
  }

  prepare(agentId: string): void {
    ensureMulticlawDir(this.projectDir)
    fs.mkdirSync(path.join(this.directory, "planning"), { recursive: true })
    fs.mkdirSync(path.join(this.directory, "agents", segment(agentId)), { recursive: true })
    fs.mkdirSync(path.dirname(this.resolve("task-plan.json", agentId)), { recursive: true })
  }

  clearTaskPlan(): void {
    this.allowLegacyPlan = false
    fs.rmSync(this.resolve("task-plan.json", "architect"), { force: true })
  }

  /** Scan current files, rather than trusting an agent's claimed output or a stale index. */
  private files(): string[] {
    const files: string[] = []
    const visit = (directory: string) => {
      if (!fs.existsSync(directory)) return
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) visit(target)
        else if (entry.isFile()) files.push(target)
      }
    }
    visit(path.join(this.directory, "planning"))
    visit(path.join(this.directory, "agents"))
    return files.sort()
  }

  instruction(agentId: string): string {
    const files = this.files()
    const legacyFiles = [...PLANNING_FILES]
      .map((name) => ({
        current: this.resolve(name, agentId),
        readable: this.readPath(name, agentId),
      }))
      .filter((file) => file.current !== file.readable)
      .map((file) => file.readable)
    return [
      "## Collaboration artifacts",
      `Work artifact directory: ${this.directory}`,
      `Shared requirements and designs: ${path.join(this.directory, "planning")}`,
      `Your notes and reports: ${path.join(this.directory, "agents", segment(agentId))}`,
      `Task plan: ${this.resolve("task-plan.json", agentId)}`,
      "Save collaboration documents here, not in the project root. Use the exact artifact paths in this prompt.",
      "Keep source code, tests, README.md and explicitly requested project documentation in their normal project locations. Do not change cwd to the artifact directory.",
      "Read relevant upstream artifacts from the list below, including every producer's implementation-notes.md. Files on disk may be partial or unverified: upstream execution and review results determine whether they can be trusted. Agents in the same parallel stage must not assume each other's work is complete.",
      "Available artifacts (current work only):",
      ...(files.length ? files.map((file) => `- ${file}`) : ["- None yet."]),
      ...(legacyFiles.length
        ? [
            "Legacy read-only context (continued work only):",
            ...legacyFiles.map((file) => `- ${file}`),
          ]
        : []),
    ].join("\n")
  }

  record(work: WorkContext): void {
    ensureMulticlawDir(this.projectDir)
    fs.mkdirSync(this.directory, { recursive: true })
    const manifest = {
      version: 1,
      workId: work.id,
      requirement: work.requirement,
      revision: work.revision,
      artifacts: this.files().map((file) => ({
        path: path.relative(this.directory, file),
        size: fs.statSync(file).size,
      })),
    }
    const target = path.join(this.directory, "manifest.json")
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
      fs.renameSync(temporary, target)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
}

function segment(value: string): string {
  if (!value || value === "." || value === ".." || /[/\\\0]/.test(value))
    throw new Error(`Invalid artifact directory identifier: ${value}`)
  return value
}
