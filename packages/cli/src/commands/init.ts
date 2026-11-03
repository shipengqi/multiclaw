import * as fs from "node:fs"
import * as path from "node:path"
import { input, select } from "@inquirer/prompts"
import { detectProviders, specForProvider } from "@multiclawcli/core"

// ─── Agent Block Definitions ──────────────────────────────────────────────────

const AGENT_BLOCKS: Record<string, string> = {
  backend: `    agents.productManager(),
    agents.architect({ dependsOn: ["product-manager"] }),
    agents.archDesignReviewer({ dependsOn: ["architect"] }),
    agents.backendDeveloper({ dependsOn: ["arch-design-reviewer"] }),
    agents.tester({ dependsOn: ["backend-developer"] }),
    agents.codeReviewer({ dependsOn: ["tester"] }),
    agents.devops({ dependsOn: ["code-reviewer"] }),`,

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
    agents.devops({ dependsOn: ["code-reviewer"] }),`,
}

const PRESET_DESCRIPTIONS: Record<string, string> = {
  backend:
    "Product Manager → Architect → Arch Design Reviewer → Backend Developer → Tester → Code Reviewer → DevOps  (7 agents)",
  frontend:
    "Architect → UI Designer → UI Design Reviewer → Frontend Developer → Tester → Code Reviewer  (6 agents)",
  fullstack:
    "Product Manager → Architect → Arch Design Reviewer → Backend Developer + UI Designer → UI Design Reviewer → Frontend Developer → Tester → Code Reviewer → DevOps  (10 agents)",
}

/**
 * The agents each preset actually contains, by their `agents.<id>()` name.
 *
 * Kept adjacent to {@link AGENT_BLOCKS} because the two must stay in step: the
 * override checkbox offers exactly these ids, and the regex that injects an
 * override only matches an id that really appears in the block. A mismatch is a
 * silently dropped override, which is what this list exists to prevent. The
 * `init.test.ts` consistency check asserts every id here has a matching
 * `agents.<id>(` in the block string.
 */
export const PRESET_AGENT_IDS: Record<string, string[]> = {
  backend: [
    "productManager",
    "architect",
    "archDesignReviewer",
    "backendDeveloper",
    "tester",
    "codeReviewer",
    "devops",
  ],
  frontend: [
    "architect",
    "uiDesigner",
    "uiDesignReviewer",
    "frontendDeveloper",
    "tester",
    "codeReviewer",
  ],
  fullstack: [
    "productManager",
    "architect",
    "archDesignReviewer",
    "backendDeveloper",
    "uiDesigner",
    "uiDesignReviewer",
    "frontendDeveloper",
    "tester",
    "codeReviewer",
    "devops",
  ],
}

// Each gate repairs its owners; code review includes testing to revalidate code edits.
const REVIEW_GATE_BLOCKS: Record<string, string> = {
  backend: `    { reviewer: "arch-design-reviewer", repairAgents: ["architect"], maxRepairRounds: 3 },
    { reviewer: "tester", repairAgents: ["backend-developer"], maxRepairRounds: 3 },
    { reviewer: "code-reviewer", repairAgents: ["backend-developer", "tester"], maxRepairRounds: 3 },`,
  frontend: `    { reviewer: "ui-design-reviewer", repairAgents: ["ui-designer"], maxRepairRounds: 3 },
    { reviewer: "tester", repairAgents: ["frontend-developer"], maxRepairRounds: 3 },
    { reviewer: "code-reviewer", repairAgents: ["frontend-developer", "tester"], maxRepairRounds: 3 },`,
  fullstack: `    { reviewer: "arch-design-reviewer", repairAgents: ["architect"], maxRepairRounds: 3 },
    { reviewer: "ui-design-reviewer", repairAgents: ["ui-designer"], maxRepairRounds: 3 },
    { reviewer: "tester", repairAgents: ["backend-developer", "frontend-developer"], maxRepairRounds: 3 },
    { reviewer: "code-reviewer", repairAgents: ["backend-developer", "frontend-developer", "tester"], maxRepairRounds: 3 },`,
}

// ─── Config Generator ─────────────────────────────────────────────────────────

export function generateConfig(opts: {
  preset: string
  workDir: string
  projectName: string
  provider: string
  permissionMode: "auto" | "ask"
}): string {
  const name = JSON.stringify(opts.projectName)
  const workDir = JSON.stringify(opts.workDir)
  const permissions = `\n    permissions: { mode: "${opts.permissionMode}" },`

  return `import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: ${name},
  workDir: ${workDir},
  leader: agents.leader(),
  context: {
    projectName: ${name},
  },
  defaults: {
    provider: ${JSON.stringify(opts.provider)},${permissions}
  },
  agents: [
${AGENT_BLOCKS[opts.preset]}
  ],
  reviewGates: [
${REVIEW_GATE_BLOCKS[opts.preset]}
  ],
})
`
}

// ─── Command ──────────────────────────────────────────────────────────────────

export async function initCommand(options: { force?: boolean } = {}): Promise<void> {
  const configPath = path.resolve(process.cwd(), "multiclaw.config.ts")
  if (fs.existsSync(configPath)) {
    if (!options.force) {
      console.error(
        "\x1b[31mError: multiclaw.config.ts already exists (use --force to overwrite)\x1b[0m"
      )
      process.exit(1)
    }
    console.log("\x1b[33mWarning: overwriting existing multiclaw.config.ts\x1b[0m")
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

  const detected = await detectProviders({ withVersion: true })

  const provider = await select({
    message: "Which agent?",
    choices: detected.map((d) => ({
      value: d.id,
      name:
        d.status === "present"
          ? `${d.label}  (${d.command}${d.version ? ` ${d.version}` : ""})`
          : `${d.label}  (not installed)`,
      disabled: false,
    })),
  })

  const spec = specForProvider(provider)
  if (!spec) {
    throw new Error(`Unknown provider: ${provider}`)
  }

  const workDir = await input({
    message: "Work directory (where agents read and write files):",
    default: ".",
  })

  const permissionMode = (await select({
    message: "How should multiclaw handle tool permissions?",
    choices: [
      { value: "auto", name: "Auto — agents run without permission prompts (recommended)" },
      { value: "ask", name: "Manual — confirm each action before it runs" },
    ],
  })) as "auto" | "ask"

  try {
    fs.writeFileSync(
      configPath,
      generateConfig({ preset, workDir, projectName, provider, permissionMode })
    )
    if (workDir !== ".") {
      fs.mkdirSync(path.resolve(process.cwd(), workDir), { recursive: true })
    }
  } catch (err) {
    console.error(`\x1b[31mError: Failed to create files: ${(err as Error).message}\x1b[0m`)
    process.exit(1)
  }

  const detectedProvider = detected.find((d) => d.id === provider)

  console.log("")
  console.log(`\x1b[32m✓\x1b[0m Created multiclaw.config.ts`)
  console.log(`  preset:   ${preset}  (${PRESET_DESCRIPTIONS[preset]})`)
  console.log(`  agent:    ${spec.label}`)
  if (detectedProvider?.status === "present") {
    console.log(
      `            ${detectedProvider.command}${detectedProvider.version ? ` ${detectedProvider.version}` : ""}`
    )
  }
  console.log(`  workDir:  ${workDir}`)
  console.log(`  mode:     ${permissionMode}`)
  console.log("")
  if (detectedProvider?.status === "missing") {
    console.log(`\x1b[33m⚠ ${spec.label} is not installed.\x1b[0m`)
    console.log(`  ${spec.install.hint}`)
    console.log("")
  }
  if (detectedProvider?.note) {
    console.log(`\x1b[2m  Before your first run: ${detectedProvider.note}\x1b[0m`)
    console.log("")
  }
  console.log(`> Run: multiclaw            (interactive console)`)
  console.log(`       multiclaw run "..."  (headless)`)
  console.log("")
  console.log(
    `\x1b[2mTip: the CLI resolves the "multiclaw" import itself, so the config runs either way.\x1b[0m`
  )
  console.log(
    `\x1b[2m     \`npm i -D multiclaw\` adds editor autocomplete for defineConfig/agents.\x1b[0m`
  )
}
