import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { input, select } from "@inquirer/prompts"

// ─── Agent Block Definitions ──────────────────────────────────────────────────

const AGENT_BLOCKS: Record<string, string> = {
  backend: `    agents.productManager(),
    agents.architect({ dependsOn: ["product-manager"] }),
    agents.archDesignReviewer({ dependsOn: ["architect"] }),
    agents.backendDeveloper({ dependsOn: ["arch-design-reviewer"] }),
    agents.tester({ dependsOn: ["backend-developer"] }),
    agents.codeReviewer({ dependsOn: ["tester"] }),
    agents.devops({ dependsOn: ["tester"] }),`,

  frontend: `    agents.architect(),
    agents.uiDesigner({ dependsOn: ["architect"] }),
    agents.uiDesignReviewer({ dependsOn: ["ui-designer"] }),
    agents.frontendDeveloper({ dependsOn: ["ui-design-reviewer"] }),
    agents.tester({ dependsOn: ["frontend-developer"] }),
    agents.codeReviewer({ dependsOn: ["tester"] }),`,

  fullstack: `    agents.productManager(),
    agents.architect({ dependsOn: ["product-manager"] }),
    agents.archDesignReviewer({ dependsOn: ["architect"] }),
    agents.backendDeveloper({ dependsOn: ["arch-design-reviewer"] }),
    agents.uiDesigner({ dependsOn: ["arch-design-reviewer"] }),
    agents.uiDesignReviewer({ dependsOn: ["ui-designer"] }),
    agents.frontendDeveloper({ dependsOn: ["backend-developer", "ui-design-reviewer"] }),
    agents.tester({ dependsOn: ["frontend-developer"] }),
    agents.codeReviewer({ dependsOn: ["tester"] }),
    agents.devops({ dependsOn: ["tester"] }),`,
}

const PRESET_DESCRIPTIONS: Record<string, string> = {
  backend:
    "Product Manager → Architect → Arch Design Reviewer → Backend Developer → Tester → Code Reviewer + DevOps  (7 agents)",
  frontend:
    "Architect → UI Designer → UI Design Reviewer → Frontend Developer → Tester → Code Reviewer  (6 agents)",
  fullstack:
    "Product Manager → Architect → Arch Design Reviewer → Backend Developer + UI Designer → UI Design Reviewer → Frontend Developer → Tester → Code Reviewer + DevOps  (10 agents)",
}

const RUNTIME_INSTALL: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
}

// const RUNTIME_INSTALL: Record<string, string> = {
//   claude:    "npm install -g @anthropic-ai/claude-code",
//   codex:     "npm install -g @openai/codex",
//   opencode:  "npm install -g opencode",
//   cursor:    "curl https://cursor.com/install | bash",
// }

// ─── Config Generator ─────────────────────────────────────────────────────────

function generateConfig(opts: { preset: string; workDir: string; projectName: string }): string {
  return `import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: "${opts.projectName}",
  workDir: "${opts.workDir}",
  context: {
    projectName: "${opts.projectName}",
  },
  dashboard: { port: 3210, autoOpen: true },
  agents: [
${AGENT_BLOCKS[opts.preset]}
  ],
})
`
}

// ─── Command ──────────────────────────────────────────────────────────────────

export async function initCommand(): Promise<void> {
  const configPath = path.resolve(process.cwd(), "multiclaw.config.ts")
  if (fs.existsSync(configPath)) {
    console.error("\x1b[31mError: multiclaw.config.ts already exists\x1b[0m")
    process.exit(1)
  }

  const defaultProjectName = path.basename(process.cwd())

  const projectName = await input({
    message: "Project name:",
    default: defaultProjectName,
  })

  const preset = await select({
    message: "Select a preset:",
    choices: [
      { value: "backend", name: `backend    — ${PRESET_DESCRIPTIONS.backend}` },
      { value: "frontend", name: `frontend   — ${PRESET_DESCRIPTIONS.frontend}` },
      { value: "fullstack", name: `fullstack  — ${PRESET_DESCRIPTIONS.fullstack}` },
    ],
  })

  const workDir = await input({
    message: "Work directory (where agents read and write files):",
    default: ".",
  })

  try {
    fs.writeFileSync(configPath, generateConfig({ preset, workDir, projectName }))
    if (workDir !== ".") {
      fs.mkdirSync(path.resolve(process.cwd(), workDir), { recursive: true })
    }
  } catch (err) {
    console.error(`\x1b[31mError: Failed to create files: ${(err as Error).message}\x1b[0m`)
    process.exit(1)
  }

  console.log("")
  console.log(`\x1b[32m✓\x1b[0m Created multiclaw.config.ts`)
  console.log(`  preset:   ${preset}  (${PRESET_DESCRIPTIONS[preset]})`)
  console.log(`  workDir:  ${workDir}`)
  console.log("")
  console.log(`> Run: multiclaw run "describe your requirement" --ui`)

  checkRuntime()
}

function checkRuntime(): void {
  // const runtimes = ["claude", "codex", "opencode", "cursor"]
  const runtimes = ["claude"]
  const available = runtimes.filter((r) => {
    try {
      execSync(`${r} --version`, { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  })
  if (available.length === 0) {
    console.log("")
    console.log("\x1b[33mWarning: No AI runtime detected. Install at least one:\x1b[0m")
    for (const [name, cmd] of Object.entries(RUNTIME_INSTALL)) {
      console.log(`  \x1b[2m${name.padEnd(12)} ${cmd}\x1b[0m`)
    }
  }
}
