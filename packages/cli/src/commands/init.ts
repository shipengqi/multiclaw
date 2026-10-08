import * as fs from "fs"
import * as path from "path"
import { execSync } from "child_process"

// ─── Config Templates ─────────────────────────────────────────────────────────

const TEMPLATE_SIMPLE = `import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: "My Project",
  workDir: "./workspace",
  context: {
    projectName: "My Project",
  },
  dashboard: { port: 3210, autoOpen: true },
  agents: [
    agents.architect(),
    agents.backendDeveloper({ dependsOn: ["architect"] }),
    agents.reviewer({ dependsOn: ["backend-developer"] }),
  ],
})
`

const TEMPLATE_BACKEND = `import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: "Backend API",
  workDir: "./workspace",
  context: {
    projectName: "My Backend Service",
  },
  dashboard: { port: 3210, autoOpen: true },
  agents: [
    agents.productManager(),
    agents.architect({ dependsOn: ["product-manager"] }),
    agents.backendDeveloper({ dependsOn: ["architect"] }),
    agents.tester({ dependsOn: ["backend-developer"] }),
    agents.reviewer({ dependsOn: ["tester"] }),
  ],
})
`

const TEMPLATE_FULLSTACK = `import { defineConfig, agents } from "multiclaw"

export default defineConfig({
  name: "Full-stack App",
  workDir: "./workspace",
  context: {
    projectName: "My Full-stack App",
  },
  dashboard: { port: 3210, autoOpen: true },
  agents: [
    agents.productManager(),
    agents.architect({ dependsOn: ["product-manager"] }),
    agents.backendDeveloper({ dependsOn: ["architect"] }),
    agents.frontendDeveloper({ dependsOn: ["architect"] }),
    agents.reviewer({ dependsOn: ["backend-developer", "frontend-developer"] }),
  ],
})
`

const TEMPLATES: Record<string, string> = {
  simple: TEMPLATE_SIMPLE,
  backend: TEMPLATE_BACKEND,
  fullstack: TEMPLATE_FULLSTACK,
}

const PRESET_DESCRIPTIONS: Record<string, string> = {
  simple:    "Architect → Backend Developer → Reviewer  (3 agents)",
  backend:   "Product Manager → Architect → Backend Developer → Tester → Reviewer  (5 agents)",
  fullstack: "Product Manager → Architect → Backend + Frontend Developer → Reviewer  (5 agents)",
}

const RUNTIME_INSTALL: Record<string, string> = {
  claude:    "npm install -g @anthropic-ai/claude-code",
  codex:     "npm install -g @openai/codex",
  opencode:  "npm install -g opencode",
  cursor:    "curl https://cursor.com/install | bash",
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function initCommand(options: { preset?: string }): void {
  const preset = options.preset ?? "simple"

  if (!TEMPLATES[preset]) {
    const available = Object.keys(TEMPLATES).join(", ")
    console.error(`\x1b[31m❌ Unknown preset "${preset}". Available: ${available}\x1b[0m`)
    process.exit(1)
  }

  const configPath = path.resolve(process.cwd(), "multiclaw.config.ts")
  if (fs.existsSync(configPath)) {
    console.error("\x1b[31m❌ multiclaw.config.ts already exists\x1b[0m")
    process.exit(1)
  }

  try {
    fs.writeFileSync(configPath, TEMPLATES[preset])
    fs.mkdirSync(path.resolve(process.cwd(), "workspace"), { recursive: true })
  } catch (err) {
    console.error(`\x1b[31m❌ Failed to create files: ${(err as Error).message}\x1b[0m`)
    process.exit(1)
  }

  console.log(`✅ Created multiclaw.config.ts (preset: ${preset})`)
  console.log(`   ${PRESET_DESCRIPTIONS[preset]}`)
  console.log("")
  console.log(`👉 Edit multiclaw.config.ts — set projectName`)
  console.log(`👉 Run: multiclaw run "describe your requirement" --ui`)

  // Check if the default runtime (claude) is installed
  checkRuntime()
}

function checkRuntime(): void {
  const runtimes = ["claude", "codex", "opencode"]
  const available = runtimes.filter((r) => {
    try { execSync(`${r === "opencode" ? r : r} --version`, { stdio: "ignore" }); return true }
    catch { return false }
  })
  if (available.length === 0) {
    console.log("")
    console.log("\x1b[33m⚠️  No AI runtime detected. Install at least one:\x1b[0m")
    for (const [name, cmd] of Object.entries(RUNTIME_INSTALL)) {
      console.log(`   \x1b[2m${name.padEnd(12)} ${cmd}\x1b[0m`)
    }
  }
}
