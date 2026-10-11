import * as fs from "node:fs/promises"
import * as path from "node:path"

/**
 * Resolve a `{{file:...}}` reference inside the workspace, or undefined if it
 * points outside it.
 *
 * Templates are built-in constants today, so `..` is not reachable from user
 * input — but the moment a template becomes config-sourced, an unbounded
 * `path.resolve` turns `{{file:../../etc/passwd}}` into a read primitive.
 */
function resolveInWorkspace(workDir: string, reference: string): string | undefined {
  const root = path.resolve(workDir)
  const resolved = path.resolve(root, reference)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined
  return resolved
}

export async function renderPrompt(
  template: string,
  context: Record<string, string>,
  workDir: string
): Promise<string> {
  let result = template
  const fileMatches = [...template.matchAll(/\{\{file:([^}]+)\}\}/g)]
  for (const match of fileMatches) {
    const filePath = resolveInWorkspace(workDir, match[1].trim())
    if (!filePath) {
      result = result.replace(match[0], () => `[file outside workspace: ${match[1].trim()}]`)
      continue
    }
    try {
      const content = await fs.readFile(filePath, "utf-8")
      // The function form matters: with a string replacement, `String.replace`
      // interprets `$&`, `` $` ``, `$'` and `$$` in the substituted text. `$$`
      // is the shell PID and appears in most shell scripts, so inlining a
      // deploy.sh would silently collapse it to a single `$`.
      result = result.replace(match[0], () => content)
    } catch {
      result = result.replace(match[0], () => `[file not found: ${match[1]}]`)
    }
  }
  for (const [key, value] of Object.entries(context)) {
    result = result.replaceAll(`{{${key}}}`, () => value)
  }
  return result
}
