import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { RuntimeImage } from "../types/runtime"
import { PermanentError } from "./errors"

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_PROMPT_IMAGES = 5

/** Durable references travel with requirements through queues, history and retries. */
export function imageReference(file: string): string {
  return `![multiclaw-image](<${file}>)`
}

export function imagePaths(text: string): string[] {
  return [
    ...new Set([...text.matchAll(/!\[multiclaw-image\]\(<([^<>\r\n]+)>\)/g)].map((m) => m[1])),
  ]
}

export function imageMimeType(data: Uint8Array): string | undefined {
  const bytes = Buffer.from(data)
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png"
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif"
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
    return "image/webp"
  return undefined
}

/** Only explicit Multiclaw attachment references are converted to native image blocks. */
export async function loadPromptImages(text: string): Promise<RuntimeImage[]> {
  const files = imagePaths(text)
  if (files.length > MAX_PROMPT_IMAGES)
    throw new PermanentError(`A message supports up to ${MAX_PROMPT_IMAGES} images`)
  return Promise.all(
    files.map(async (file) => {
      if (!path.isAbsolute(file)) throw new PermanentError(`Image path must be absolute: ${file}`)
      try {
        const handle = await fs.open(file, "r")
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
            throw new PermanentError(`Image must be a file under 10 MiB: ${file}`)
          // Bound the read even if a file grows after stat.
          const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_IMAGE_BYTES + 1))
          let bytesRead = 0
          while (bytesRead < bytes.length) {
            const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
            if (!result.bytesRead) break
            bytesRead += result.bytesRead
          }
          const data = bytes.subarray(0, bytesRead)
          if (bytesRead > MAX_IMAGE_BYTES) throw new PermanentError(`Image exceeds 10 MiB: ${file}`)
          const mimeType = imageMimeType(data)
          if (!mimeType) throw new PermanentError(`Unsupported image format: ${file}`)
          return { data: data.toString("base64"), mimeType }
        } finally {
          await handle.close()
        }
      } catch (error) {
        throw new PermanentError(
          `Cannot attach image ${file}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )
}
