import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { ensureMulticlawDir, imageMimeType, MAX_IMAGE_BYTES } from "@multiclawcli/core"

export type ClipboardContent = { image: Buffer } | { text: string }

const MAC_SCRIPT = `
ObjC.import('AppKit');
const board = $.NSPasteboard.generalPasteboard;
let data = board.dataForType('public.png');
if (data.isNil()) {
  const tiff = board.dataForType('public.tiff');
  if (!tiff.isNil()) {
    const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (!bitmap.isNil()) data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  }
}
if (!data.isNil()) JSON.stringify({image: ObjC.unwrap(data.base64EncodedStringWithOptions(0))});
else {
  const value = board.stringForType('public.utf8-plain-text');
  JSON.stringify({text: value.isNil() ? '' : ObjC.unwrap(value)});
}
`

const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $picture = [System.Windows.Forms.Clipboard]::GetImage()
  $stream = New-Object System.IO.MemoryStream
  try {
    $picture.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    @{image = [Convert]::ToBase64String($stream.ToArray())} | ConvertTo-Json -Compress
  } finally { $stream.Dispose(); $picture.Dispose() }
} else { @{text = [System.Windows.Forms.Clipboard]::GetText()} | ConvertTo-Json -Compress }
`

function run(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "buffer", timeout: 5000, maxBuffer: MAX_IMAGE_BYTES * 2 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

export async function readClipboard(): Promise<ClipboardContent> {
  if (process.platform === "darwin" || process.platform === "win32") {
    const raw =
      process.platform === "darwin"
        ? await run("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT])
        : await run("powershell.exe", ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT])
    const value = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""))
    if (typeof value.image === "string") return { image: Buffer.from(value.image, "base64") }
    return { text: typeof value.text === "string" ? value.text : "" }
  }
  if (process.platform === "linux") {
    for (const command of ["wl-paste", "xclip"]) {
      try {
        const types = (
          await run(
            command,
            command === "wl-paste"
              ? ["--list-types"]
              : ["-selection", "clipboard", "-t", "TARGETS", "-o"]
          )
        )
          .toString()
          .split(/\r?\n/)
        const mime = types.find((type) =>
          ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type)
        )
        const data = await run(
          command,
          command === "wl-paste"
            ? ["--no-newline", "--type", mime ?? "text"]
            : ["-selection", "clipboard", "-t", mime ?? "UTF8_STRING", "-o"]
        )
        return mime ? { image: data } : { text: data.toString("utf8") }
      } catch {
        // Try the other display server before reporting that neither reader works.
      }
    }
    throw new Error(
      "Cannot read clipboard; install wl-clipboard (Wayland) or xclip (X11) and check the display connection"
    )
  }
  throw new Error(`Clipboard paste is unavailable on ${process.platform}`)
}

export async function saveClipboardImage(workDir: string, image: Buffer): Promise<string> {
  if (image.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 10 MiB")
  const mime = imageMimeType(image)
  if (!mime) throw new Error("Clipboard image must be PNG, JPEG, GIF or WebP")
  const dir = path.join(ensureMulticlawDir(workDir), "attachments")
  await fs.mkdir(dir, { recursive: true })
  const file = path.resolve(dir, `${randomUUID()}.${mime.slice(6)}`)
  await fs.writeFile(file, image, { flag: "wx", mode: 0o600 })
  return file
}
