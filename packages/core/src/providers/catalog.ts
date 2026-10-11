import * as path from "node:path"
import type { AgentTask } from "../types/runtime"

export type ProviderId = "claude" | "opencode" | "codex" | "cursor" | (string & {})

export type ModelTier = "strong" | "balanced" | "fast"

export interface ProviderModel {
  id: string
  label: string
  tier?: ModelTier
  /** True when this model is the default for its tier within this provider. */
  defaultForTier?: boolean
}

export type ModelSelectionMode = "config-option" | "arg" | "none"

export interface ProviderSpec {
  id: ProviderId
  label: string

  /** Binary to spawn. */
  command: string
  /** Arguments after the binary. */
  args: string[]
  /** Additional binary names that resolve to this provider (for detection). */
  aliases?: string[]

  /**
   * Build the `_meta` payload for a session-defining request.
   * Returns `undefined` when there is nothing to say — the role prompt
   * then falls back to a prompt prefix.
   */
  meta?: (task: AgentTask) => Record<string, unknown> | undefined
  /** Whether this provider honours a tool allowlist at all. */
  tools: boolean
  /** How model selection is communicated to the agent. */
  modelSelection: ModelSelectionMode

  /** Models offered by this provider. */
  models: ProviderModel[]
  /** Fallback when no tier or explicit model is configured. */
  defaultModel: string

  install: { hint: string; url?: string }
  /** Auth prerequisite — shown as a hint, not a hard gate (v1). */
  auth: { kind: "ambient" | "login" | "api-key" | "none"; hint: string }
  /**
   * When the binary name is ambiguous (e.g. cursor's `agent`),
   * use `--version` output to confirm identity. Mandatory for generic names.
   */
  confirm?: (versionOutput: string) => boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeCommandKey(command: string): string {
  return path
    .basename(command)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/i, "")
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    args: ["acp"],
    tools: false,
    modelSelection: "config-option",
    models: [
      { id: "opencode/big-pickle", label: "Big Pickle", tier: "balanced", defaultForTier: true },
      { id: "opencode/exo-free", label: "Exo", tier: "strong", defaultForTier: true },
      { id: "opencode/ling-3.0-flash-fin-free", label: "Ling 3.0 Flash", tier: "fast" },
      {
        id: "opencode/ling-3.1-flash-free",
        label: "Ling 3.1 Flash",
        tier: "fast",
        defaultForTier: true,
      },
      { id: "opencode/longcat-2.5-preview-free", label: "Longcat 2.5 Preview", tier: "balanced" },
      { id: "opencode/mimo-v2.6-flash-free", label: "Mimo 2.6 Flash", tier: "fast" },
      { id: "opencode/muse-spark-1.3-contributor-free", label: "Muse Spark 1.3", tier: "fast" },
      { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra", tier: "strong" },
      { id: "opencode/nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning", tier: "fast" },
      { id: "opencode/space-bunny-free", label: "Space Bunny", tier: "fast" },
      { id: "opencode/step-5-preview-free", label: "Step 5 Preview", tier: "strong" },
    ],
    defaultModel: "opencode/big-pickle",
    install: { hint: "npm install -g opencode" },
    auth: { kind: "none", hint: "" },
  },
  {
    id: "claude",
    label: "Claude",
    command: "claude-agent-acp",
    args: [],
    tools: true,
    modelSelection: "config-option",
    meta: (task) => {
      const meta: Record<string, unknown> = {}
      if (task.systemPrompt) meta.systemPrompt = task.systemPrompt
      meta.claudeCode = { options: { tools: task.tools } }
      return meta
    },
    models: [
      { id: "default", label: "Default", tier: "balanced" },
      { id: "opus", label: "Opus", tier: "strong", defaultForTier: true },
      { id: "fable", label: "Fable", tier: "balanced" },
      { id: "sonnet", label: "Sonnet", tier: "balanced", defaultForTier: true },
      { id: "haiku", label: "Haiku", tier: "fast", defaultForTier: true },
    ],
    defaultModel: "sonnet",
    install: {
      hint: "multiclaw bundles the ACP bridge — install the Claude Code CLI (`claude`) and run `claude` to log in",
    },
    auth: { kind: "ambient", hint: "run `claude` to log in" },
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex-acp",
    args: [],
    tools: false,
    modelSelection: "config-option",
    meta: (task) =>
      task.systemPrompt
        ? { jetbrains: { air: { customInstructions: task.systemPrompt } } }
        : undefined,
    // Placeholders — real ids require auth to enumerate.
    models: [
      { id: "gpt-5-codex", label: "GPT-5 Codex", tier: "strong", defaultForTier: true },
      { id: "gpt-5", label: "GPT-5", tier: "balanced", defaultForTier: true },
      { id: "gpt-5-mini", label: "GPT-5 Mini", tier: "fast", defaultForTier: true },
    ],
    defaultModel: "gpt-5",
    install: {
      hint: "multiclaw bundles the ACP bridge — install the Codex CLI (`codex`) and run `codex login`",
    },
    auth: { kind: "api-key", hint: "set OPENAI_API_KEY or run `codex login`" },
  },
  {
    id: "cursor",
    label: "Cursor",
    command: "cursor-agent",
    aliases: ["agent"],
    args: ["acp"],
    tools: false,
    modelSelection: "config-option",
    // _meta support unverified — falls back to prompt prefix until confirmed.
    meta: undefined,
    // Placeholders — real ids require Cursor CLI + auth to enumerate.
    models: [
      { id: "cursor-pro", label: "Cursor Pro", tier: "strong", defaultForTier: true },
      { id: "cursor-fast", label: "Cursor Fast", tier: "fast", defaultForTier: true },
    ],
    defaultModel: "cursor-pro",
    install: {
      hint: "curl https://cursor.com/install | bash",
      url: "https://cursor.com/docs/cli/acp",
    },
    auth: { kind: "login", hint: "run `agent login` first (or set CURSOR_API_KEY)" },
    confirm: (v) => /cursor/i.test(v),
  },
]

// ─── Lookup tables ───────────────────────────────────────────────────────────

const byProviderId = new Map<string, ProviderSpec>()
const byCommand = new Map<string, ProviderSpec>()

for (const spec of PROVIDERS) {
  byProviderId.set(spec.id, spec)
  byCommand.set(normalizeCommandKey(spec.command), spec)
  if (spec.aliases) {
    for (const alias of spec.aliases) {
      byCommand.set(normalizeCommandKey(alias), spec)
    }
  }
}

/** Lookup a provider by its id. */
export function specForProvider(id: string): ProviderSpec | undefined {
  return byProviderId.get(id)
}

/**
 * Lookup a provider by the binary name it is launched with.
 * Keys on basename (strips paths and Windows suffixes) so
 * `/opt/bin/claude-agent-acp` and `claude-agent-acp.exe` both hit.
 */
export function specForCommand(command: string): ProviderSpec | undefined {
  return byCommand.get(normalizeCommandKey(command))
}

/** All provider ids known to the catalog. */
export function providerIds(): string[] {
  return [...byProviderId.keys()]
}

/** All commands (primary + aliases) that map to a provider. */
export function providerCommands(): string[] {
  return [...byCommand.keys()]
}

/** Resolve a tier to a concrete model id for a given provider. */
export function tierModel(spec: ProviderSpec, tier: ModelTier): string | undefined {
  const m = spec.models.find((m) => m.tier === tier && m.defaultForTier)
  return m?.id ?? spec.models.find((m) => m.tier === tier)?.id
}
