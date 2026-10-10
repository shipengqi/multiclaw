import { execSync } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export async function upgradeCommand(): Promise<void> {
  const { version: currentVersion } = require("../package.json") as { version: string }

  console.log(`Current version: v${currentVersion}`)
  console.log("Checking for updates...")

  let latestVersion: string
  try {
    latestVersion = execSync("npm show multiclaw version", { encoding: "utf8" }).trim()
  } catch {
    console.error("\x1b[31mError: Failed to fetch latest version from npm registry\x1b[0m")
    process.exit(1)
    return
  }

  if (latestVersion === currentVersion) {
    console.log(`\x1b[32m✓\x1b[0m Already on the latest version (v${currentVersion})`)
    return
  }

  console.log(`Upgrading multiclaw v${currentVersion} → v${latestVersion}...`)

  try {
    execSync("npm install -g multiclaw@latest", { stdio: "inherit" })
    console.log(`\x1b[32m✓\x1b[0m Successfully upgraded to v${latestVersion}`)
  } catch {
    console.error(
      "\x1b[31mError: Upgrade failed. Try running manually: npm install -g multiclaw@latest\x1b[0m"
    )
    process.exit(1)
  }
}
