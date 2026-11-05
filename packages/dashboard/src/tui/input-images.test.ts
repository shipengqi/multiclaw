import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { splitInputImages } from "./input-images"

describe("terminal image paths", () => {
  it.each([
    ["/Users/test/Application\\ Support/截图.png", "/Users/test/Application Support/截图.png"],
    ['"/Users/test/Application Support/截图.PNG"', "/Users/test/Application Support/截图.PNG"],
    ["'/tmp/my screenshot.jpeg'", "/tmp/my screenshot.jpeg"],
    ["/tmp/screenshot\\(1\\).webp", "/tmp/screenshot(1).webp"],
    ["C:\\Users\\test\\image.png", "C:\\Users\\test\\image.png"],
  ])("extracts %s", (input, file) => {
    expect(splitInputImages(input)).toEqual({ text: "", images: [file] })
  })
  it("keeps surrounding instructions and image order", () => {
    expect(splitInputImages("/tmp/first.png 对比 /tmp/second.gif 的布局")).toEqual({
      text: " 对比  的布局",
      images: ["/tmp/first.png", "/tmp/second.gif"],
    })
  })
  it("expands the home directory", () => {
    expect(splitInputImages("~/截图.png").images).toEqual([path.join(os.homedir(), "截图.png")])
  })
  it.each([
    "/focus dev",
    "/export /tmp/chat.md",
    "/export /tmp/image.png",
    "/tmp/source.ts",
    "https://example.com/image.png",
    "![multiclaw-image](</tmp/image.png>)",
    "/tmp/a.pngsuffix",
  ])("leaves non-attachments unchanged: %s", (text) => {
    expect(splitInputImages(text)).toEqual({ text, images: [] })
  })
})
