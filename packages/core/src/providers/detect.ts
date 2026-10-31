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

/**
 * The version token inside whatever a CLI prints for `--version`.
 *
 * Providers disagree on the shape: `0.95.0`, `codex-cli 0.162.1`,
 * `@agentclientprotocol/codex-acp 2.5.0`. The package name in front is noise —
 * the row already names the provider — and at 35 characters it is wider than
 * the column it goes in, which pushed `bundled` up against the version and made
 * the table unreadable. So the table gets the number, not the sentence.
 *
 * Falls back to the first line when nothing looks like a version, rather than
 * returning nothing: "it printed something unexpected" is worth seeing.
 */
export function parseVersion(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  // Strip SGR colour, which would otherwise count towards the column width.
  // Built from a char code because a literal ESC is rejected by the linter —
  // the same construction `doctor.ts` uses for the same reason.
  const plain = raw.replace(SGR_RE, "")
  const firstLine = plain.split("\n")[0].trim()
  if (!firstLine) return undefined
  return firstLine.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? firstLine
}

const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

/**
 * Run `command --version` and return its raw output, or undefined on failure.
 *
 * Raw, not parsed: `spec.confirm` decides whether an ambiguous binary name
 * (cursor's `agent`) really is that provider by looking at the *words* it
 * prints, so the caller needs the whole line. Parsing happens where the value
 * is stored for display — see {@link parseVersion}.
 */
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
            version = parseVersion(v)
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
        version = parseVersion(await versionFor(exe))
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
