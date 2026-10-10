import * as fs from "node:fs"
import * as path from "node:path"
import type { MultiClawConfig } from "@multiclawcli/core"

const DEFAULT_CONFIG_NAMES = ["multiclaw.config.ts", "multiclaw.config.js"]

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

export async function loadConfig(
  configPath?: string,
  requirement?: string
): Promise<MultiClawConfig> {
  const absPath = findConfig(configPath)

  // The compiled CLI cannot natively import .ts files — register tsx ESM hook
  // so dynamic import can handle TypeScript config files.
  const { register } = await import("tsx/esm/api")
  const unregister = register()
  let mod: Record<string, unknown>
  try {
    mod = await import(absPath)
  } finally {
    unregister()
  }
  const config: MultiClawConfig = (mod.default ?? mod.config) as MultiClawConfig

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
