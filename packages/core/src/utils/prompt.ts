import * as fs from "node:fs/promises"
import * as path from "node:path"

export async function renderPrompt(
  template: string,
  context: Record<string, string>,
  workDir: string
): Promise<string> {
  let result = template
  const fileMatches = [...template.matchAll(/\{\{file:([^}]+)\}\}/g)]
  for (const match of fileMatches) {
    const filePath = path.resolve(workDir, match[1].trim())
    try {
      const content = await fs.readFile(filePath, "utf-8")
      result = result.replace(match[0], content)
    } catch {
      result = result.replace(match[0], `[file not found: ${match[1]}]`)
    }
  }
  for (const [key, value] of Object.entries(context)) {
    result = result.replaceAll(`{{${key}}}`, value)
  }
  return result
}
