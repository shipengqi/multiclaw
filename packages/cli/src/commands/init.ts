import * as fs from "node:fs"
import * as path from "node:path"
import { checkbox, input, Separator, select } from "@inquirer/prompts"
import { detectProviders, specForProvider, tierModel } from "@multiclawcli/core"

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

// ─── Config Generator ─────────────────────────────────────────────────────────

function generateConfig(opts: {
  preset: string
  workDir: string
  projectName: string
  provider: string
  model?: string
  overrides?: Array<{ id: string; model: string }>
}): string {
  const name = JSON.stringify(opts.projectName)
  const workDir = JSON.stringify(opts.workDir)
  const defaultsParts: string[] = [`provider: ${JSON.stringify(opts.provider)}`]
  if (opts.model) defaultsParts.push(`model: ${JSON.stringify(opts.model)}`)

  let agentBlock = AGENT_BLOCKS[opts.preset]
  if (opts.overrides && opts.overrides.length > 0) {
    // Inject per-agent model overrides into the block string.
    for (const ov of opts.overrides) {
      const id = ov.id
      const model = JSON.stringify(ov.model)
      // Match the agent call line and append the model param.
      const re = new RegExp(`(agents\\.${id}\\([^)]*\\))`, "g")
      agentBlock = agentBlock.replace(re, (match) => {
        const inner = match.slice(id.length + 8, -1) // strip `agents.X(` and `)`
        const sep = inner.trim() ? ", " : ""
        return `agents.${id}({ ${inner}${sep}model: ${model} })`
      })
    }
  }

  return `import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: ${name},
  workDir: ${workDir},
  context: {
    projectName: ${name},
  },
  defaults: {
    ${defaultsParts.join(",\n    ")},
  },
  agents: [
${agentBlock}
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

  const modelAnswer = await select({
    message: "Team model preference:",
    choices: [
      { value: "", name: "Role-based tier defaults (recommended)" },
      new Separator("---"),
      ...[
        { label: "Strong (architect, devops)", tier: "strong" as const },
        { label: "Balanced (backend, frontend)", tier: "balanced" as const },
        { label: "Fast (reviewer, tester)", tier: "fast" as const },
      ]
        .map((t) => {
          const m = tierModel(spec, t.tier)
          return m ? { value: m, name: `${t.label}  →  ${m}` } : undefined
        })
        .filter((x): x is { value: string; name: string } => x !== undefined),
      new Separator("---"),
      ...spec.models.map((m) => ({ value: m.id, name: m.label })),
    ],
  })
  const modelDefault = modelAnswer || undefined

  // Per-agent overrides
  const overrideIds = await checkbox({
    message: "Override model for specific agents? (space to select, enter to confirm)",
    choices: [
      { value: "leader", name: "★ Leader" },
      { value: "productManager", name: "Product Manager" },
      { value: "architect", name: "Architect" },
      { value: "archDesignReviewer", name: "Arch Design Reviewer" },
      { value: "backendDeveloper", name: "Backend Developer" },
      { value: "frontendDeveloper", name: "Frontend Developer" },
      { value: "uiDesigner", name: "UI Designer" },
      { value: "uiDesignReviewer", name: "UI Design Reviewer" },
      { value: "tester", name: "Tester" },
      { value: "codeReviewer", name: "Code Reviewer" },
      { value: "devops", name: "DevOps" },
    ],
  })

  const overrides: Array<{ id: string; model: string }> = []
  for (const id of overrideIds) {
    const ov = await select({
      message: `Model for ${id}:`.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
      choices: spec.models.map((m) => ({ value: m.id, name: m.label })),
    })
    overrides.push({ id, model: ov })
  }

  const workDir = await input({
    message: "Work directory (where agents read and write files):",
    default: ".",
  })

  try {
    fs.writeFileSync(
      configPath,
      generateConfig({ preset, workDir, projectName, provider, model: modelDefault, overrides })
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
  console.log(`  model:    ${modelDefault || "role-based tier defaults"}`)
  console.log(`  workDir:  ${workDir}`)
  if (overrides.length > 0) {
    console.log(`  overrides: ${overrides.map((o) => `${o.id}=${o.model}`).join(", ")}`)
  }
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
