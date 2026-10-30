import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Writes in flight, one promise chain per target path.
 *
 * Two writers racing the same file would otherwise rename the same temporary
 * file out from under each other: the second `rename` finds nothing, or the
 * slower write lands last and overwrites newer content with older.
 */
const writes = new Map<string, Promise<void>>()

/**
 * Write JSON to `target` atomically, serialized per path.
 *
 * Written to a temp file and renamed into place: `rename` is atomic within a
 * filesystem, so a crash mid-write leaves the *previous* file intact. Writing
 * the target directly would instead leave half a JSON document, and since every
 * reader here can only drop a file it cannot parse, that would cost the user
 * *all* of their state rather than the last write.
 *
 * The returned promise rejects on failure; the serialization chain swallows it
 * so one failed write cannot poison the next.
 */
export function writeJsonFile(target: string, json: string): Promise<void> {
  const write = (writes.get(target) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      const tmp = `${target}.tmp`
      await fs.promises.writeFile(tmp, json, "utf-8")
      await fs.promises.rename(tmp, target)
    })
  writes.set(target, write)
  void write
    .finally(() => {
      if (writes.get(target) === write) writes.delete(target)
    })
    .catch(() => {})
  return write
}

/**
 * The last write queued for `target`, or a resolved promise when there is none.
 *
 * Lets a shutdown wait for state that is already on its way to disk. Without it
 * the process can exit between the `writeFile` and the `rename`, which leaves
 * the temporary file behind and the previous — older — file in place.
 */
export function pendingWrite(target: string): Promise<void> {
  return (writes.get(target) ?? Promise.resolve()).catch(() => {})
}
