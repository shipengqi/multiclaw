import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import type { MultiClawConfig } from "@multiclawcli/core"

const DEFAULT_CONFIG_NAMES = ["multiclaw.config.ts", "multiclaw.config.js"]

/**
 * The specifiers a scaffolded config imports its helpers from. `multiclaw` only
 * resolves if the user installed the package locally — a global install's
 * node_modules is not in the project's resolution chain — so the loader aliases
 * both names to the core module this CLI already depends on. That keeps
 * `import { defineConfig, agents } from "multiclaw"` working for everyone.
 */
const CONFIG_HELPER_SPECIFIERS = ["multiclaw", "@multiclawcli/core"]

function findConfig(configPath?: string): string {
  if (configPath) {
    const abs = path.resolve(process.cwd(), configPath)
    if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`)
    return abs
  }
  for (const name of DEFAULT_CONFIG_NAMES) {
    const abs = path.resolve(process.cwd(), name)
    if (fs.existsSync(abs)) return abs
  }
  throw new Error(
    `No config file found. Create multiclaw.config.ts in the current directory or use --config to specify a path.`
  )
}

/** Resolve the helpers entry point, or undefined if it cannot be found. */
function resolveHelpersEntry(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("@multiclawcli/core")
  } catch {
    return undefined
  }
}

/**
 * Import a config file. jiti compiles the file itself, so — unlike a raw
 * `import()` behind tsx's ESM hook — the result does not depend on whether the
 * nearest package.json declares `"type": "module"`. That setting used to decide
 * the outcome: a plain CommonJS project failed with a require(esm) cycle before
 * a single line of the config ran.
 */
async function importConfig(absPath: string): Promise<unknown> {
  const { createJiti } = await import("jiti")
  const helpers = resolveHelpersEntry()
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    ...(helpers
      ? { alias: Object.fromEntries(CONFIG_HELPER_SPECIFIERS.map((name) => [name, helpers])) }
      : {}),
  })
  try {
    return await jiti.import(absPath)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      [
        `Failed to load config: ${absPath}`,
        `  ${detail.split("\n")[0]}`,
        `  Check the file for syntax errors, and that every package it imports is installed.`,
      ].join("\n")
    )
  }
}

/**
 * jiti hands back a module namespace, which is a non-extensible exotic object —
 * `loadConfig` needs to resolve `workDir` against the config directory, so it
 * must be the underlying mutable object, not the namespace wrapper. Descend
 * through `default` (or `config`) until we reach it; a config exported as a bare
 * object already is the object.
 */
function unwrapConfig(mod: unknown): unknown {
  let value = mod
  for (let depth = 0; depth < 3; depth += 1) {
    if (!value || typeof value !== "object" || Array.isArray(value)) break
    const record = value as Record<string, unknown>
    const next = "default" in record ? record.default : record.config
    if (!next || typeof next !== "object" || Array.isArray(next)) break
    value = next
  }
  return value
}

export async function loadConfig(
  configPath?: string,
  requirement?: string
): Promise<MultiClawConfig> {
  const absPath = findConfig(configPath)
  const config = unwrapConfig(await importConfig(absPath)) as MultiClawConfig

  if (!config || !Array.isArray(config.agents)) {
    throw new Error(`Invalid config format — expected: export default defineConfig({...})`)
  }

  const configDir = path.dirname(absPath)
  config.workDir = path.resolve(configDir, config.workDir)

  if (requirement !== undefined) {
    config.context = { ...config.context, requirement }
  }

  return config
}
