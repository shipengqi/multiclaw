import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Orchestrator, runtimeRegistry } from "@multiclawcli/core"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../loader/loadConfig"
import { generateConfig } from "./init"
import { resumeOptionsFromReport } from "./resume"

describe("generated fullstack rework chain", () => {
  it("loads the generated config, repairs real workspace artifacts, executes retests and resumes gates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multiclaw-rework-"))
    const name = "generated-rework-runtime"
    const calls: string[] = []
    const counts = new Map<string, number>()
    let selected: string[] = []
    runtimeRegistry.register({
      name,
      describe: async () => ({
        name,
        available: true,
        capabilities: {
          streaming: false,
          sessions: false,
          resume: false,
          permissions: false,
          models: false,
          images: false,
          usage: false,
          cost: false,
          sandbox: false,
        },
      }),
      execute: async (task) => {
        calls.push(task.agentId)
        const count = (counts.get(task.agentId) ?? 0) + 1
        counts.set(task.agentId, count)
        if (task.agentId === "leader")
          return { exitCode: 0, output: JSON.stringify({ mode: "run", run: selected }) }
        if (task.agentId === "backend-developer") {
          writeFileSync(join(dir, "backend.json"), JSON.stringify({ revision: count }))
          return { exitCode: 0, output: `Updated backend revision ${count}`, costUsd: 0.1 }
        }
        if (task.agentId === "frontend-developer") {
          writeFileSync(join(dir, "frontend.json"), JSON.stringify({ revision: count }))
          return { exitCode: 0, output: `Updated frontend revision ${count}`, costUsd: 0.1 }
        }
        let approved = true
        let issue = ""
        if (task.agentId === "tester") {
          // Actual subprocess verification of both developers' current artifacts.
          const check = spawnSync(
            process.execPath,
            [
              "-e",
              "const fs=require('node:fs'); const b=JSON.parse(fs.readFileSync('backend.json')); const f=JSON.parse(fs.readFileSync('frontend.json')); if(b.revision<3 || f.revision<3) process.exit(1)",
            ],
            { cwd: dir }
          )
          expect(check.error).toBeUndefined()
          approved = check.status === 0
          issue =
            "backend-developer and frontend-developer: revisions below 3; reproduce using the workspace verification command"
          writeFileSync(
            join(dir, "test-report.md"),
            approved ? "PASS: executed current workspace tests" : "FAIL: current revisions below 3"
          )
        } else if (
          ["arch-design-reviewer", "ui-design-reviewer", "code-reviewer"].includes(task.agentId)
        ) {
          approved = count > 1
          issue = `${task.agentId}: unresolved design or implementation issue`
        } else return { exitCode: 0, output: "done", costUsd: 0.1 }
        expect(task.prompt).toContain("Delivery acceptance review")
        expect(task.systemPrompt).toContain("requested JSON verdict")
        return {
          exitCode: 0,
          costUsd: 0.1,
          output: JSON.stringify({
            verdict: approved ? "approved" : "changes_required",
            summary: approved ? "Verified" : "Fix required",
            issues: approved ? [] : [issue],
          }),
        }
      },
    })
    try {
      const configPath = join(dir, "multiclaw.config.ts")
      writeFileSync(
        configPath,
        generateConfig({
          preset: "fullstack",
          workDir: ".",
          projectName: "rework",
          provider: "claude",
          permissionMode: "auto",
        })
      )
      const config = await loadConfig(configPath, "Deliver verified backend and frontend artifacts")
      config.defaults = undefined
      const leader = config.leader
      if (!leader) throw new Error("Generated config must include a leader")
      for (const agent of [...config.agents, leader]) {
        agent.runtime = name
        agent.models = undefined
        agent.modelTier = undefined
      }
      selected = config.agents.map((agent) => agent.id)
      const result = await new Orchestrator(config).run()
      expect(result.success).toBe(true)
      expect(result.gateResults?.map((gate) => [gate.reviewer, gate.repairRounds])).toEqual([
        ["arch-design-reviewer", 1],
        ["ui-design-reviewer", 1],
        ["tester", 2],
        ["code-reviewer", 1],
      ])
      expect(counts.get("backend-developer")).toBe(4)
      expect(counts.get("frontend-developer")).toBe(4)
      expect(counts.get("tester")).toBe(4)
      expect(calls[calls.length - 1]).toBe("devops")
      expect(readFileSync(join(dir, "test-report.md"), "utf8")).toContain("PASS: executed")
      expect(
        result.effectiveAgentResults?.filter((item) => item.agentId === "tester")
      ).toHaveLength(1)
      const restored = resumeOptionsFromReport(JSON.parse(JSON.stringify(result)))
      for (const gate of config.reviewGates ?? [])
        expect(restored.resume.agents).toContain(gate.reviewer)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
