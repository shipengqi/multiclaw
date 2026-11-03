import * as fs from "node:fs"
import * as path from "node:path"

/** Create runtime storage with Git protection, preserving existing ignore rules. */
export function ensureMulticlawDir(workDir: string): string {
  const directory = path.join(workDir, ".multiclaw")
  fs.mkdirSync(directory, { recursive: true })
  try {
    fs.writeFileSync(path.join(directory, ".gitignore"), "*\n", { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  return directory
}
