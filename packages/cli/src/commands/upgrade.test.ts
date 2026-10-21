import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  detectInstaller,
  findPackageRoot,
  type Installer,
  readInstalledVersion,
  runUpgrade,
  type UpgradeContext,
} from "./upgrade"

const CURRENT = "0.4.0"
const LATEST = "0.5.0"

// Wrap each spy in a function so the variable type is the exact spy signature
// rather than the overly generic `ReturnType<typeof vi.spyOn>`.
function spyOnConsoleLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {})
}
function spyOnConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {})
}
function spyOnProcessExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
}

let logSpy: ReturnType<typeof spyOnConsoleLog>
let errorSpy: ReturnType<typeof spyOnConsoleError>
let exitSpy: ReturnType<typeof spyOnProcessExit>
let tmpRoot: string

beforeEach(() => {
  logSpy = spyOnConsoleLog()
  errorSpy = spyOnConsoleError()
  exitSpy = spyOnProcessExit()
  tmpRoot = mkdtempSync(join(tmpdir(), "multiclaw-upgrade-"))
})

afterEach(() => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
  exitSpy.mockRestore()
  rmSync(tmpRoot, { recursive: true, force: true })
})

const logged = () => logSpy.mock.calls.flat().join("\n")

interface Harness {
  ctx: UpgradeContext
  exec: ReturnType<typeof vi.fn>
  /** Mutable stand-in for the on-disk copy the upgrade is supposed to replace. */
  installed: { version: string }
}

/**
 * `pkgRoot` is realistic on purpose: the install location is the only signal
 * that tells npm and pnpm installs apart, so the fixtures mirror the real
 * layouts (`.../lib/node_modules` vs `.../pnpm/global/<v>/node_modules/.pnpm`).
 */
function harness(installer: Installer, current = CURRENT): Harness {
  const installed = { version: current }
  const exec = vi.fn((_command: string, mode: "capture" | "inherit") => {
    if (mode === "capture") return `${LATEST}\n`
    // A real install replaces the files on disk; mirror that so the
    // post-install verification has something truthful to compare against.
    installed.version = LATEST
    return ""
  })
  return {
    ctx: {
      pkgRoot: `/home/u/${installer}/global/node_modules/multiclaw`,
      currentVersion: current,
      installer,
      readVersion: () => installed.version,
      exec,
    },
    exec,
    installed,
  }
}

describe("runUpgrade", () => {
  it("upgrades the pnpm install it is running from, not npm's prefix", async () => {
    const { ctx, exec } = harness("pnpm")
    await runUpgrade(ctx)

    expect(exec.mock.calls).toEqual([
      ["pnpm view multiclaw version", "capture"],
      ["pnpm add -g multiclaw@latest", "inherit"],
    ])
    expect(logged()).toContain("Successfully upgraded to v0.5.0")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("upgrades an npm install through npm", async () => {
    const { ctx, exec } = harness("npm")
    await runUpgrade(ctx)

    expect(exec.mock.calls).toEqual([
      ["npm show multiclaw version", "capture"],
      ["npm install -g multiclaw@latest", "inherit"],
    ])
    expect(logged()).toContain("Successfully upgraded to v0.5.0")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("reports already-latest without installing", async () => {
    const { ctx, exec } = harness("npm", LATEST)
    await runUpgrade(ctx)

    expect(logged()).toContain("Already on the latest version")
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("exits with code 1 when the registry lookup fails", async () => {
    const { ctx, exec } = harness("npm")
    exec.mockImplementationOnce(() => {
      throw new Error("network down")
    })
    await runUpgrade(ctx)

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch latest version"))
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it("exits with code 1 when the install command fails", async () => {
    const { ctx, exec } = harness("npm")
    exec
      .mockImplementationOnce(() => `${LATEST}\n`)
      .mockImplementationOnce(() => {
        throw new Error("install failed")
      })
    await runUpgrade(ctx)

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Upgrade failed"))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it("fails when the install succeeds but the running copy keeps its old version", async () => {
    // The regression this guards: `npm install -g` exits 0 while writing to a
    // different prefix, so the copy behind `multiclaw` never moves.
    const { ctx, exec, installed } = harness("npm")
    exec.mockImplementation((_command: string, mode: "capture" | "inherit") =>
      mode === "capture" ? `${LATEST}\n` : ""
    )
    await runUpgrade(ctx)

    expect(installed.version).toBe(CURRENT)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("still reports v0.4.0"))
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(logged()).not.toContain("Successfully upgraded")
  })

  it.each(["bun", "yarn", "unknown"] as const)(
    "refuses to guess an upgrade path for a %s install",
    async (installer) => {
      const { ctx, exec } = harness(installer)
      await runUpgrade(ctx)

      expect(exec).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Run it manually"))
      expect(exitSpy).toHaveBeenCalledWith(1)
    }
  )
})

describe("detectInstaller", () => {
  it.each([
    ["/Users/u/.nvm/versions/node/v24.18.1/lib/node_modules/multiclaw", "npm"],
    ["/usr/local/lib/node_modules/multiclaw", "npm"],
    ["/home/u/.local/share/pnpm/global/5/node_modules/multiclaw", "pnpm"],
    [
      "/Users/u/Library/pnpm/global/v11/node_modules/.pnpm/multiclaw@0.4.0/node_modules/multiclaw",
      "pnpm",
    ],
    ["/Users/u/.bun/install/global/node_modules/multiclaw", "bun"],
    ["/Users/u/.config/yarn/global/node_modules/multiclaw", "yarn"],
    ["/Users/u/code/multiclaw/packages/cli", "unknown"],
    // Windows paths: pnpm and npm both land under `node_modules`, so the
    // backslash normalisation has to keep them distinguishable.
    ["C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\multiclaw", "npm"],
    ["C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules\\multiclaw", "pnpm"],
  ] as const)("maps %s to %s", (pkgRoot, expected) => {
    expect(detectInstaller(pkgRoot)).toBe(expected)
  })
})

describe("findPackageRoot", () => {
  function writeManifest(dir: string, manifest: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
  }

  it("walks up from dist/ to the package root", () => {
    const root = join(tmpRoot, "lib", "node_modules", "multiclaw")
    writeManifest(root, { name: "multiclaw", version: "1.2.3" })

    expect(findPackageRoot(join(root, "dist"))).toBe(root)
    expect(readInstalledVersion(root)).toBe("1.2.3")
  })

  it("returns the nearest package root, not an ancestor's", () => {
    writeManifest(tmpRoot, { name: "some-other-package", version: "9.9.9" })
    const root = join(tmpRoot, "node_modules", "multiclaw")
    writeManifest(root, { name: "multiclaw", version: "2.0.0" })

    expect(findPackageRoot(join(root, "dist", "commands"))).toBe(root)
  })

  it("skips a malformed package.json instead of throwing", () => {
    const root = join(tmpRoot, "multiclaw")
    writeManifest(root, { name: "multiclaw", version: "3.0.0" })
    mkdirSync(join(root, "dist"), { recursive: true })
    writeFileSync(join(root, "dist", "package.json"), "{ not json")

    expect(findPackageRoot(join(root, "dist"))).toBe(root)
  })

  it("returns undefined when nothing on the way up declares multiclaw", () => {
    expect(findPackageRoot(tmpRoot)).toBeUndefined()
  })
})
