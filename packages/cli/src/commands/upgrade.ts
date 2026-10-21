import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_NAME = "multiclaw"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const RESET = "\x1b[0m"

/** Which package manager owns the copy of multiclaw that is currently running. */
export type Installer = "npm" | "pnpm" | "bun" | "yarn" | "unknown"

interface Manifest {
  name?: string
  version?: string
}

/** Read `<dir>/package.json`, tolerating a missing or malformed file. */
function readManifest(dir: string): Manifest | undefined {
  const manifest = join(dir, "package.json")
  if (!existsSync(manifest)) return undefined
  try {
    return JSON.parse(readFileSync(manifest, "utf8")) as Manifest
  } catch {
    return undefined
  }
}

/** Walk up from `start` to the package.json that declares this package. */
export function findPackageRoot(start: string): string | undefined {
  let dir = resolve(start)
  for (;;) {
    if (readManifest(dir)?.name === PACKAGE_NAME) return dir
    const parent = dirname(dir)
    // At the filesystem root `dirname` returns itself — stop instead of looping.
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Read the installed version straight from disk (no module cache to go stale). */
export function readInstalledVersion(pkgRoot: string): string | undefined {
  return readManifest(pkgRoot)?.version
}

/**
 * Identify the installer from the on-disk location of the running package.
 *
 * This is the whole point of the command: `npm install -g` writes to npm's
 * prefix, which is not necessarily where the binary on PATH came from. A user
 * with a pnpm global install used to get a silent no-op upgrade — npm installed
 * a fresh copy somewhere else while `multiclaw --version` kept reporting the
 * pnpm one. Upgrading must therefore target the manager that owns this copy.
 */
export function detectInstaller(pkgRoot: string): Installer {
  // Windows paths arrive with backslashes; the signatures below are POSIX.
  const path = pkgRoot.replaceAll("\\", "/")
  // pnpm keeps the real copy under `.pnpm/` and still nests it in
  // `node_modules`, so it has to be matched before the generic npm case.
  if (path.includes("/pnpm/global/") || path.includes("/.pnpm/")) return "pnpm"
  if (path.includes("/install/global/") || path.includes("/.bun/")) return "bun"
  if (path.includes("/yarn/global/")) return "yarn"
  if (path.includes("/node_modules/")) return "npm"
  return "unknown"
}

interface UpgradeCommands {
  /**
   * Registry query, routed through the installer so a configured mirror
   * (`.npmrc` / `registry=`) is honoured instead of hardcoding the public one.
   */
  latest: string
  /** Install into the same prefix this process is running from. */
  install: string
}

// Only npm and pnpm have a verified query + global-install pair. bun and yarn
// are recognised so the error can name the right command, but guessing their
// registry syntax risks upgrading the wrong copy — the bug this command fixes.
const COMMANDS: Record<Installer, UpgradeCommands | undefined> = {
  npm: { latest: "npm show multiclaw version", install: "npm install -g multiclaw@latest" },
  pnpm: { latest: "pnpm view multiclaw version", install: "pnpm add -g multiclaw@latest" },
  bun: undefined,
  yarn: undefined,
  unknown: undefined,
}

const MANUAL: Record<Installer, string> = {
  npm: "npm install -g multiclaw@latest",
  pnpm: "pnpm add -g multiclaw@latest",
  bun: "bun add -g multiclaw@latest",
  yarn: "yarn global add multiclaw@latest",
  unknown: "npm install -g multiclaw@latest",
}

type Exec = (command: string, mode: "capture" | "inherit") => string

export interface UpgradeContext {
  pkgRoot: string
  currentVersion: string
  installer: Installer
  /** Re-read after installing: the on-disk copy is what `--version` reports. */
  readVersion: (pkgRoot: string) => string | undefined
  exec: Exec
}

/** Resolve the running install. `undefined` means it is not an installed copy. */
export function createUpgradeContext(): UpgradeContext | undefined {
  const pkgRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)))
  if (!pkgRoot) return undefined
  const currentVersion = readInstalledVersion(pkgRoot)
  if (!currentVersion) return undefined
  return {
    pkgRoot,
    currentVersion,
    installer: detectInstaller(pkgRoot),
    readVersion: readInstalledVersion,
    exec: (command, mode) => {
      if (mode === "inherit") {
        execSync(command, { stdio: "inherit" })
        return ""
      }
      return execSync(command, { encoding: "utf8" })
    },
  }
}

export async function runUpgrade(ctx: UpgradeContext): Promise<void> {
  const { pkgRoot, currentVersion, installer, exec, readVersion } = ctx

  console.log(`Current version: v${currentVersion} (${installer} install)`)

  const commands = COMMANDS[installer]
  if (!commands) {
    const reason =
      installer === "unknown"
        ? `this copy is not a global install (${pkgRoot})`
        : `the ${installer} install at ${pkgRoot} cannot be upgraded automatically`
    console.error(`${RED}Error: ${reason}. Run it manually: ${MANUAL[installer]}${RESET}`)
    process.exit(1)
    return
  }

  console.log("Checking for updates...")

  let latestVersion: string
  try {
    latestVersion = exec(commands.latest, "capture").trim()
  } catch {
    console.error(`${RED}Error: Failed to fetch latest version from npm registry${RESET}`)
    process.exit(1)
    return
  }

  if (latestVersion === currentVersion) {
    console.log(`${GREEN}✓${RESET} Already on the latest version (v${currentVersion})`)
    return
  }

  console.log(`Upgrading multiclaw v${currentVersion} → v${latestVersion}...`)

  try {
    exec(commands.install, "inherit")
  } catch {
    console.error(`${RED}Error: Upgrade failed. Try running manually: ${commands.install}${RESET}`)
    process.exit(1)
    return
  }

  // The install can exit 0 while writing to a different prefix than the copy we
  // are running from. Verifying the file on disk turns that silent no-op into a
  // failure instead of a "Successfully upgraded" message that does not hold.
  const installedVersion = readVersion(pkgRoot)
  if (installedVersion !== latestVersion) {
    console.error(
      `${RED}Error: ${commands.install} finished, but ${pkgRoot} still reports ` +
        `v${installedVersion ?? "unknown"}. Check for a second multiclaw install, then retry.${RESET}`
    )
    process.exit(1)
    return
  }

  console.log(`${GREEN}✓${RESET} Successfully upgraded to v${latestVersion} (${pkgRoot})`)
}

export async function upgradeCommand(): Promise<void> {
  const ctx = createUpgradeContext()
  if (!ctx) {
    console.error(
      `${RED}Error: could not locate the multiclaw package this process is running from.${RESET}`
    )
    process.exit(1)
    return
  }
  await runUpgrade(ctx)
}
