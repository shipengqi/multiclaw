import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { PROVIDERS } from "./catalog"

export type ProviderStatus = "present" | "missing"

export interface DetectedProvider {
  id: string
  label: string
  command: string
  status: ProviderStatus
  version?: string
  note?: string
}

/** True when `command` names an executable file on PATH. */
function resolvesOnPath(command: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
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

/** Run `command --version` and return trimmed stdout, or undefined on failure. */
async function versionFor(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = ""
    const child = spawn(command, ["--version"], { env: process.env })
    child.stdout.on("data", (d) => {
      out += d.toString()
    })
    child.on("close", () => {
      resolve(out.trim() || undefined)
    })
    child.on("error", () => {
      resolve(undefined)
    })
    // Do not wait forever.
    setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      resolve(undefined)
    }, 3000)
  })
}

/**
 * Discover which providers are installed on this machine.
 *
 * Availability comes from PATH lookups (fast, no spawn). When
 * `withVersion` is true, ambiguous binary names (e.g. cursor's `agent`)
 * are confirmed via `--version` output.
 */
export async function detectProviders(opts?: {
  withVersion?: boolean
}): Promise<DetectedProvider[]> {
  const results: DetectedProvider[] = []

  for (const spec of PROVIDERS) {
    const candidates = [spec.command, ...(spec.aliases ?? [])]
    let matched: string | undefined
    let version: string | undefined

    for (const cmd of candidates) {
      if (!resolvesOnPath(cmd)) continue

      // Ambiguous names must pass a version-string confirmation.
      if (spec.confirm) {
        if (opts?.withVersion) {
          const v = await versionFor(cmd)
          if (v && spec.confirm(v)) {
            matched = cmd
            version = v
            break
          }
        }
        // Without withVersion, ambiguous names are treated as missing.
        continue
      }

      matched = cmd
      if (opts?.withVersion) {
        version = await versionFor(cmd)
      }
      break
    }

    if (matched) {
      results.push({
        id: spec.id,
        label: spec.label,
        command: matched,
        status: "present",
        version,
        note: spec.auth.hint || undefined,
      })
    } else {
      results.push({
        id: spec.id,
        label: spec.label,
        command: spec.command,
        status: "missing",
        note: spec.install.hint,
      })
    }
  }

  return results
}

/** Just the ids of providers that are present. */
export function presentProviders(detected: DetectedProvider[]): string[] {
  return detected.filter((d) => d.status === "present").map((d) => d.id)
}
