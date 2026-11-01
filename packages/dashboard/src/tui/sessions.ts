import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Sessions: the unit of history and resumption.
 *
 * A session is one continuous line of work — a sequence of turns, each fanning
 * out to the same team of agents. It is what Claude Code / Codex call a session:
 * an independent, listable, resumable, deletable record. Everything a session
 * owns lives under its own directory (`turns.jsonl`, `session.json`, exports),
 * and a small `index.json` holds just the summaries the picker needs so it never
 * has to open a session to list one.
 */
export const SESSIONS_DIR = "sessions"

/** The summary index, read by the picker; one entry per session. */
export const INDEX_FILE = "index.json"

/** How long a session title may grow before it is truncated for the index. */
export const MAX_TITLE_CHARS = 80

export interface SessionMeta {
  id: string
  /** First turn's requirement, truncated. Empty until the session runs a turn. */
  title: string
  createdAt: number
  lastActiveAt: number
  /** Highest turn number the session has recorded. */
  turnCount: number
}

export function sessionsRoot(workDir: string): string {
  return path.join(workDir, ".multiclaw", SESSIONS_DIR)
}

export function sessionDir(workDir: string, id: string): string {
  return path.join(sessionsRoot(workDir), id)
}

function indexPath(workDir: string): string {
  return path.join(sessionsRoot(workDir), INDEX_FILE)
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (typeof value !== "object" || value === null) return false
  const meta = value as Partial<SessionMeta>
  return (
    typeof meta.id === "string" &&
    typeof meta.title === "string" &&
    typeof meta.createdAt === "number" &&
    typeof meta.lastActiveAt === "number" &&
    typeof meta.turnCount === "number"
  )
}

/**
 * Read the session index, newest-first by last activity.
 *
 * Never throws, like `loadTurns`: a missing or corrupt index means "no sessions
 * the picker can show", which is always a safe place to start from. A single bad
 * entry is dropped rather than losing the whole list.
 */
export function listSessions(workDir: string): SessionMeta[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(indexPath(workDir), "utf-8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSessionMeta).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  } catch {
    return []
  }
}

/** The most recently active session, or undefined when there is none. */
export function latestSession(workDir: string): SessionMeta | undefined {
  return listSessions(workDir)[0]
}

/**
 * Read-modify-write the index synchronously.
 *
 * Synchronous on purpose: index mutations are infrequent (a session is created,
 * deleted, or touched once per turn), the file is tiny, and a sync read-modify-
 * write cannot interleave with another mutation the way two async chains could —
 * which is exactly the lost-update a shared journal must not have. Written via a
 * temp file and `renameSync` so a crash leaves the previous index intact.
 */
function mutateIndex(workDir: string, fn: (metas: SessionMeta[]) => SessionMeta[]): void {
  const next = fn(readIndex(workDir))
  const target = indexPath(workDir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next), "utf-8")
  fs.renameSync(tmp, target)
}

function readIndex(workDir: string): SessionMeta[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(indexPath(workDir), "utf-8"))
    return Array.isArray(parsed) ? parsed.filter(isSessionMeta) : []
  } catch {
    return []
  }
}

/**
 * Register a new, empty session and return its metadata.
 *
 * The directory is not created here — `appendTurns` and `saveJournal` both
 * `mkdir` lazily, so a session that is created and never run leaves nothing but
 * an index entry behind.
 */
export function createSession(workDir: string): SessionMeta {
  const now = Date.now()
  const meta: SessionMeta = {
    id: randomUUID(),
    title: "",
    createdAt: now,
    lastActiveAt: now,
    turnCount: 0,
  }
  mutateIndex(workDir, (metas) => [meta, ...metas])
  return meta
}

/** Remove a session's directory and its index entry. Idempotent. */
export function deleteSession(workDir: string, id: string): void {
  fs.rmSync(sessionDir(workDir, id), { recursive: true, force: true })
  mutateIndex(workDir, (metas) => metas.filter((meta) => meta.id !== id))
}

/** Update a session's summary in the index. `lastActiveAt` defaults to now. */
export function touchSession(
  workDir: string,
  id: string,
  patch: Partial<Pick<SessionMeta, "title" | "turnCount" | "lastActiveAt">>
): void {
  mutateIndex(workDir, (metas) =>
    metas.map((meta) =>
      meta.id === id
        ? {
            ...meta,
            ...(patch.title !== undefined ? { title: patch.title.slice(0, MAX_TITLE_CHARS) } : {}),
            ...(patch.turnCount !== undefined ? { turnCount: patch.turnCount } : {}),
            lastActiveAt: patch.lastActiveAt ?? Date.now(),
          }
        : meta
    )
  )
}
