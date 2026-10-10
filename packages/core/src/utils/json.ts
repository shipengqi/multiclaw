/**
 * Extract every top-level JSON object found in `text`.
 *
 * Leader / architect agents are instructed to emit a bare JSON object, but real
 * output frequently wraps it in prose or markdown fences. A regular expression
 * cannot cope with nested braces or strings that contain `}` — this scans with
 * brace and string awareness instead and simply skips spans that are not valid
 * JSON, so a stray `{` in prose does not poison the whole parse.
 */
export function extractJsonObjects(text: string): unknown[] {
  const objects: unknown[] = []
  let searchFrom = 0

  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom)
    if (start === -1) break

    const end = findMatchingBrace(text, start)
    if (end !== -1) {
      try {
        objects.push(JSON.parse(text.slice(start, end + 1)))
        searchFrom = end + 1
        continue
      } catch {
        // Not valid JSON — fall through and keep scanning from the next brace.
      }
    }
    searchFrom = start + 1
  }

  return objects
}

/** Index of the `}` that closes the `{` at `start`, ignoring braces inside strings. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
