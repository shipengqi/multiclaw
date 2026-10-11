import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

/**
 * ACP bridges that multiclaw bundles and resolves from its own `node_modules`
 * rather than requiring the user to install them globally.
 *
 * Key = the binary name used in an agent's `command`; value = the npm package
 * that provides it. `opencode` is deliberately absent: it speaks ACP natively,
 * so it *is* the user's agent and is installed by the user.
 */
export const BRIDGE_PACKAGES: Record<string, string> = {
  "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
  "codex-acp": "@agentclientprotocol/codex-acp",
}

/** True when `command` names an executable file on PATH. */
export function resolvesOnPath(command: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  // PATHEXT is Windows-only; the bare name covers POSIX and extensionless
  // binaries. Trying both is harmless and avoids a platform branch.
  const exts = (process.env.PATHEXT ?? "").split(";").filter(Boolean)
  const suffixes = exts.length > 0 ? exts : [""]
  for (const dir of dirs) {
    for (const ext of suffixes) {
      try {
        fs.accessSync(path.join(dir, command + ext), fs.constants.X_OK)
        return true
      } catch {
        // not executable or not found
      }
    }
  }
  return false
}

/**
 * Resolve a bundled bridge binary to an absolute path inside multiclaw's
 * installed `node_modules`. Returns null when `command` is not a bridge we
 * bundle (e.g. a user-supplied binary such as `opencode`).
 *
 * This lets multiclaw drive the ACP bridge without it being on the user's PATH:
 * the user only installs their own agent (`claude` / `codex` / `opencode`), and
 * multiclaw supplies the thin bridge in front of it.
 */
export function resolveBridgeBinary(command: string): string | null {
  const pkg = BRIDGE_PACKAGES[command]
  if (!pkg) return null
  try {
    const req = createRequire(import.meta.url)
    const pkgJsonPath = req.resolve(`${pkg}/package.json`)
    const bin = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).bin
    const binRel = typeof bin === "string" ? bin : (bin?.[command] ?? Object.values(bin)[0])
    if (!binRel) return null
    return path.join(path.dirname(pkgJsonPath), binRel)
  } catch {
    return null
  }
}

/**
 * Resolve the executable multiclaw should spawn for `command`.
 *
 * Prefers the user's own install on PATH (this is also what the test suite
 * relies on — fake binaries are placed on PATH), and falls back to a bridge
 * multiclaw bundles. Returns null when neither is available.
 */
export function resolveExecutable(command: string): string | null {
  if (resolvesOnPath(command)) return command
  return resolveBridgeBinary(command)
}
