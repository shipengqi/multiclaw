import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createSession,
  deleteSession,
  INDEX_FILE,
  latestSession,
  listSessions,
  MAX_TITLE_CHARS,
  type SessionMeta,
  sessionDir,
  sessionsRoot,
  touchSession,
} from "./sessions"

let workDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiclaw-sessions-"))
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

function writeIndexRaw(value: unknown): void {
  const root = sessionsRoot(workDir)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, INDEX_FILE), JSON.stringify(value), "utf-8")
}

describe("sessions index", () => {
  it("ignores session artifacts through the runtime directory's own Git rules", () => {
    execFileSync("git", ["init", "--quiet"], { cwd: workDir })
    const session = createSession(workDir)
    const dir = sessionDir(workDir, session.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "session.json"), "{}")
    const ignored = execFileSync(
      "git",
      [
        "-c",
        "core.excludesFile=/dev/null",
        "check-ignore",
        "--verbose",
        ".multiclaw/.gitignore",
        `.multiclaw/sessions/${session.id}/session.json`,
      ],
      { cwd: workDir, encoding: "utf-8" }
    )
    expect(ignored.split("\n").filter(Boolean)).toHaveLength(2)
    expect(ignored).toContain(".multiclaw/.gitignore:1:*")
  })

  it("preserves existing runtime ignore rules when writing the session index", () => {
    const meta = createSession(workDir)
    const ignorePath = path.join(workDir, ".multiclaw", ".gitignore")
    const rules = "*\n!keep.txt\n"
    fs.writeFileSync(ignorePath, rules)
    touchSession(workDir, meta.id, { title: "updated" })
    expect(fs.readFileSync(ignorePath, "utf-8")).toBe(rules)
  })

  it("has nothing in an empty workspace", () => {
    expect(listSessions(workDir)).toEqual([])
    expect(latestSession(workDir)).toBeUndefined()
  })

  it("registers a new session and lists it", () => {
    const meta = createSession(workDir)
    expect(meta.title).toBe("")
    expect(meta.turnCount).toBe(0)
    expect(listSessions(workDir).map((s) => s.id)).toEqual([meta.id])
    expect(latestSession(workDir)?.id).toBe(meta.id)
  })

  it("orders by last activity, newest first", () => {
    const a = createSession(workDir)
    const b = createSession(workDir)
    touchSession(workDir, a.id, { lastActiveAt: 1_000 })
    touchSession(workDir, b.id, { lastActiveAt: 2_000 })
    expect(listSessions(workDir).map((s) => s.id)).toEqual([b.id, a.id])

    touchSession(workDir, a.id, { lastActiveAt: 3_000 })
    expect(latestSession(workDir)?.id).toBe(a.id)
  })

  it("touch updates title and turn count in place", () => {
    const meta = createSession(workDir)
    touchSession(workDir, meta.id, { title: "build the thing", turnCount: 3 })
    const loaded = listSessions(workDir)[0]
    expect(loaded.title).toBe("build the thing")
    expect(loaded.turnCount).toBe(3)
  })

  it("truncates a long title", () => {
    const meta = createSession(workDir)
    touchSession(workDir, meta.id, { title: "x".repeat(MAX_TITLE_CHARS + 50) })
    expect(listSessions(workDir)[0].title.length).toBe(MAX_TITLE_CHARS)
  })

  it("deletes the directory and the index entry", () => {
    const meta = createSession(workDir)
    const dir = sessionDir(workDir, meta.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "turns.jsonl"), "{}\n", "utf-8")

    deleteSession(workDir, meta.id)

    expect(fs.existsSync(dir)).toBe(false)
    expect(listSessions(workDir)).toEqual([])
  })

  it("delete is idempotent and never throws on an unknown id", () => {
    expect(() => deleteSession(workDir, "does-not-exist")).not.toThrow()
  })

  it("reads a corrupt index as empty, and the next create replaces it", () => {
    writeIndexRaw("{ not json")
    expect(listSessions(workDir)).toEqual([])

    const meta = createSession(workDir)
    expect(listSessions(workDir).map((s) => s.id)).toEqual([meta.id])
  })

  it("drops malformed entries from the index", () => {
    const good: SessionMeta = { id: "a", title: "", createdAt: 1, lastActiveAt: 1, turnCount: 0 }
    writeIndexRaw([good, null, { id: "b" }, 7, "nope"])
    expect(listSessions(workDir).map((s) => s.id)).toEqual(["a"])
  })
})
