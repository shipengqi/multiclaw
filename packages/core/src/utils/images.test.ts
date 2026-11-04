import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { imageReference, loadPromptImages, MAX_IMAGE_BYTES } from "./images"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64"
)
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-images-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("prompt images", () => {
  it("loads bytes once when a durable reference appears more than once", async () => {
    const file = path.join(dir, "screen shot (1).png")
    fs.writeFileSync(file, PNG)
    const reference = imageReference(file)
    expect(await loadPromptImages(`${reference}\n${reference}`)).toEqual([
      { data: PNG.toString("base64"), mimeType: "image/png" },
    ])
    expect(await loadPromptImages(`![ordinary image](<${file}>)`)).toEqual([])
  })
  it("reports missing, unsupported and oversized attachments", async () => {
    const file = path.join(dir, "bad.png")
    await expect(loadPromptImages(imageReference(file))).rejects.toThrow(/Cannot attach image/)
    fs.writeFileSync(file, "plain text")
    await expect(loadPromptImages(imageReference(file))).rejects.toThrow(/Unsupported image format/)
    fs.truncateSync(file, MAX_IMAGE_BYTES + 1)
    await expect(loadPromptImages(imageReference(file))).rejects.toThrow(/10 MiB/)
  })
  it("rejects a message with more than five images before reading any file", async () => {
    const text = Array.from({ length: 6 }, (_, i) =>
      imageReference(path.join(dir, `${i}.png`))
    ).join("\n")
    await expect(loadPromptImages(text)).rejects.toThrow(/up to 5 images/)
  })
})
