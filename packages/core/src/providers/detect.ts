import { spawn } from "node:child_process"
import { resolveExecutable } from "./bridge"
import { PROVIDERS } from "./catalog"

export type ProviderStatus = "present" | "missing"

/**
 * Where the executable for a present provider came from.
 *
 * `path` is the user's own install on PATH — the expected case. `bundled` means
 * multiclaw's own `node_modules` supplied the bridge, so the provider works
 * without the bridge being installed globally; that is worth telling the user,
 * because "present" then says nothing about what they have installed.
 */
export type ProviderSource = "path" | "bundled"

export interface DetectedProvider {
  id: string
  label: string
  command: string
  status: ProviderStatus
  version?: string
  note?: string
  /** How the executable resolves. Absent for a missing provider. */
  source?: ProviderSource
  /** Absolute path actually spawned, set only for a bundled bridge. */
  resolvedPath?: string
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
    let source: ProviderSource = "path"
    let resolvedPath: string | undefined

    for (const cmd of candidates) {
      // Prefer a binary on PATH; fall back to a bridge multiclaw bundles. A
      // provider is "present" when either resolves.
      const exe = resolveExecutable(cmd)
      if (!exe) continue

      // `resolveExecutable` returns the bare command when it found it on PATH
      // and an absolute path when the bundled bridge answered, so the two
      // cases are told apart by identity rather than a second PATH probe.
      const bundled = exe !== cmd

      // Ambiguous names must pass a version-string confirmation.
      if (spec.confirm) {
        if (opts?.withVersion) {
          const v = await versionFor(exe)
          if (v && spec.confirm(v)) {
            matched = cmd
            version = v
            source = bundled ? "bundled" : "path"
            resolvedPath = bundled ? exe : undefined
            break
          }
        }
        // Without withVersion, ambiguous names are treated as missing.
        continue
      }

      matched = cmd
      source = bundled ? "bundled" : "path"
      resolvedPath = bundled ? exe : undefined
      if (opts?.withVersion) {
        version = await versionFor(exe)
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
        source,
        ...(resolvedPath !== undefined ? { resolvedPath } : {}),
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
