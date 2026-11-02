/** A terminal host control message, never inferred from ordinary prose. */
export const HANDOFF_INSTRUCTION = [
  "## Routing handoff",
  "If this assignment belongs to another role or needs rerouting beyond your scope, explain what remains and end with exactly:",
  '<multiclaw-handoff>{"reason":"specific reason and remaining work"}</multiclaw-handoff>',
  "Do not use this for routine implementation choices, progress, or provider errors. Do not rewrite the original requirement. Otherwise finish normally.",
].join("\n")

export function parseHandoff(output: string): { reason: string } | { error: string } | undefined {
  const text = output.trim()
  // Quoted/fenced examples are content. Control messages occupy their own final line.
  const unfenced = text.replace(/```[\s\S]*?```/g, "[quoted example]")
  const lastLine = unfenced.trim().split("\n").slice(-1)[0] ?? ""
  const terminal = unfenced.match(/(?:^|\n)<multiclaw-handoff>([\s\S]*?)<\/multiclaw-handoff>$/)
  const unclosed = /(?:^|\n)<multiclaw-handoff>(?:(?!<\/multiclaw-handoff>)[\s\S])*$/.test(unfenced)
  if (!terminal && !unclosed && !/^<\/?multiclaw-handoff(?:>|\s)/.test(lastLine.trim()))
    return undefined
  const lines = unfenced
    .split("\n")
    .filter((line) => /^<multiclaw-handoff(?:>|\s)/.test(line.trim()))
  if (text.split(String.fromCharCode(96).repeat(3)).length % 2 === 0) return undefined
  const match = text.match(/(?:^|\n)<multiclaw-handoff>([\s\S]*?)<\/multiclaw-handoff>$/)
  if (lines.length !== 1 || !match) return { error: "Invalid terminal handoff marker." }
  try {
    const item: unknown = JSON.parse(match[1])
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error()
    const fields = item as Record<string, unknown>
    if (
      Object.keys(fields).length !== 1 ||
      typeof fields.reason !== "string" ||
      !fields.reason.trim()
    )
      throw new Error()
    return { reason: fields.reason.trim() }
  } catch {
    return { error: "Handoff requires a JSON object with a non-empty reason." }
  }
}
