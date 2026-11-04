import * as os from "node:os"
import * as path from "node:path"
import { parseCommand } from "./commands"

/** Recognise terminal-pasted file paths without interpreting them as shell code. */
export function splitInputImages(input: string): { text: string; images: string[] } {
  if (parseCommand(input)) return { text: input, images: [] }
  const images: string[] = []
  const text = input.replace(
    /(?:^|(?<=\s))(?:"[^"\r\n]+"|'[^'\r\n]+'|(?:\/|~\/|[A-Za-z]:[\\/])(?:\\[^\r\n]|[^\s"'<>])+)(?=$|\s)/g,
    (token) => {
      const quoted = token.startsWith('"') || token.startsWith("'")
      let file = quoted ? token.slice(1, -1) : token
      if (!quoted && !/^[A-Za-z]:/.test(file)) file = file.replace(/\\(.)/g, "$1")
      if (file.startsWith("~/")) file = path.join(os.homedir(), file.slice(2))
      if (!(path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file))) return token
      if (!/\.(?:png|jpe?g|gif|webp)$/i.test(file)) return token
      images.push(file)
      return ""
    }
  )
  return { text, images }
}
