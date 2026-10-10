import type { AgentStatus } from "@multiclawcli/core"

/**
 * Semantic colours, in one place.
 *
 * Only the sixteen named ANSI colours are used. Every terminal theme remaps
 * those to something legible against its own background; a hard-coded hex would
 * look right on the author's machine and wrong on everyone else's.
 */
export const COLOR = {
  accent: "cyan",
  ok: "green",
  warn: "yellow",
  error: "red",
  muted: "gray",
} as const

export interface StatusStyle {
  glyph: string
  color: string
  dim?: boolean
  /** Word used in prose contexts (stream header, help). */
  label: string
}

/**
 * Status is always a glyph *and* a colour.
 *
 * Colour alone would be invisible to a colour-blind user and would vanish the
 * moment the output is copied into a log or an issue.
 */
export const STATUS: Record<AgentStatus, StatusStyle> = {
  pending: { glyph: "○", color: COLOR.muted, dim: true, label: "queued" },
  running: { glyph: "◐", color: COLOR.accent, label: "running" },
  retrying: { glyph: "↻", color: COLOR.warn, label: "retrying" },
  success: { glyph: "✓", color: COLOR.ok, label: "done" },
  failed: { glyph: "✗", color: COLOR.error, label: "failed" },
  skipped: { glyph: "⊘", color: COLOR.muted, dim: true, label: "skipped" },
}

/** Braille spinner frames, cycled in place of the static running glyph. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export const GLYPH = {
  /** Marks the console itself in the header and the welcome screen. */
  brand: "◆",
  /** The leader runs before the pipeline exists, so it gets its own mark. */
  leader: "◆",
  agent: "◇",
  /** Points at the focused row in the team list. */
  caret: "›",
  /** Pipeline flow between stages. */
  connector: "──▸",
  /** The stream is tailing; new output appears as it arrives. */
  live: "▼",
  /** The stream is parked while the user reads back. */
  paused: "⏸",
  /**
   * A follow-up waiting for the team to finish.
   *
   * Latin-1 on purpose: it renders as exactly one cell in every terminal, which
   * a pictograph like ⏳ does not.
   */
  queued: "»",
  /** The leader is asking for a decision rather than reporting one. */
  ask: "?",
} as const
