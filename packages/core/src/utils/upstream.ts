/**
 * One agent's finished output, as a downstream agent should see it.
 *
 * `agentId` and `name` are carried alongside the text so the block can address
 * the producer by name — a bare paragraph with no attribution reads as the
 * reader's own thought.
 */
export interface UpstreamOutput {
  agentId: string
  name: string
  output: string
}

/**
 * Ceiling on a single rendered entry, in characters.
 *
 * The entry is the whole bullet — its attribution line, its body, and the
 * 2-space indent on every continuation line — not just the body. A budget that
 * excluded its own framing would let the rendered entry exceed the constant,
 * exactly as the block budget counts the heading and trailing newline.
 *
 * The ceiling is enforced by compacting the body, so it holds while the
 * attribution line is small relative to the constant — the practical case. As
 * the label grows, compaction has less body to work with, and past the point
 * where it can keep nothing the entry is bounded by `label.length + markerLen`
 * instead: there the label, not this constant, is what sets the size.
 *
 * An output past this is compacted rather than dropped: it is the one piece of
 * upstream work that exists, and throwing it away would leave the downstream
 * agent with nothing to build on.
 */
export const MAX_UPSTREAM_ENTRY_CHARS = 600

/**
 * Ceiling on the whole rendered block, in characters.
 *
 * The block is what is injected into the prompt, so the heading and the
 * trailing newline count against this — not just the entries. A budget that
 * excluded its own framing would let the returned string exceed the constant.
 *
 * A budget rather than a count of agents because one agent's output can be a
 * full document; a dozen of those would bury the requirement underneath them.
 * Oldest entries are dropped to stay under it.
 */
export const MAX_UPSTREAM_CHARS = 4000

const ELLIPSIS = "…"

/** The block's fixed framing, charged against {@link MAX_UPSTREAM_CHARS}. */
const HEADER = "\n## What upstream produced\n\n"
const TRAILER = "\n"

/** Assemble the block exactly as it will be injected into the prompt. */
function block(entries: readonly string[]): string {
  return `${HEADER}${entries.join("\n")}${TRAILER}`
}

/**
 * Compact one output to `max` characters, keeping its head and its tail.
 *
 * This is a deterministic, synchronous transform — deliberately *not* an LLM
 * summary. A model-written summary would need a second runtime call that can
 * fail or hang, would make the same inputs render different prompts, and would
 * hide which words were actually kept. Head *and* tail rather than a hard cut:
 * a requirement's framing tends to sit at the front and its conclusion at the
 * back, so clipping either end alone would throw away exactly the parts the
 * downstream agent needs. (A model-based summary is a possible later
 * refinement; it is out of scope here.)
 *
 * The marker names the real number of characters elided, so a reader can tell
 * how much is missing rather than mistaking the elision for the whole thing.
 */
function compact(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed

  const marker = (count: number) => `${ELLIPSIS} (${count} characters elided) ${ELLIPSIS}`
  // Reserve room for the marker itself before splitting the budget. It is sized
  // against the full length, which is an upper bound on the elided count, so the
  // finished string can only come out at or under `max`.
  const reserved = marker(trimmed.length).length
  const keep = Math.max(0, max - reserved)
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  const elided = trimmed.length - keep

  return `${trimmed.slice(0, head)}${marker(elided)}${trimmed.slice(trimmed.length - tail)}`
}

/** One entry: a name, an id, and the (possibly compacted) body underneath. */
function entry(output: UpstreamOutput): string {
  // The ceiling covers the rendered bullet, so the attribution line and the
  // per-continuation-line indent are charged against it alongside the body.
  const label = `- ${output.name} (${output.agentId}):\n  `
  const budget = MAX_UPSTREAM_ENTRY_CHARS - label.length

  let body = compact(output.output, budget)
  // Indenting adds two characters per newline, which the first pass did not
  // account for. One recomputation is enough — no loop needed.
  //
  // Non-degenerate path (`budget - 2N ≥ reserved`): `compact` returns at most
  // `max` characters, so the second body is at most `budget - 2N`; and because
  // its keep is smaller, its head is a prefix and its tail a suffix of the first
  // body's, so its newline count N' ≤ N. Hence
  //   label.length + body.length + 2N' ≤ label.length + (budget - 2N) + 2N
  //                                   = MAX_UPSTREAM_ENTRY_CHARS.
  //
  // Degenerate path (`budget - 2N < reserved`): `compact` floors its keep at 0
  // and returns a marker-only body, so the recomputation is a deliberate no-op
  // here — it cannot shrink what is already just the marker (and when the first
  // pass is degenerate too, it is literally the same marker). The entry is then
  // bounded by `label.length + markerLen`, not by this ceiling; keeping it in
  // check there is the label's job, not the constant's.
  const newlines = body.length - body.replace(/\n/g, "").length
  if (label.length + body.length + 2 * newlines > MAX_UPSTREAM_ENTRY_CHARS) {
    body = compact(output.output, budget - 2 * newlines)
  }

  // Continuation lines are indented so a multi-line output reads as one bullet's
  // body rather than as a run of sibling bullets that were never produced.
  return `${label}${body.replace(/\n/g, "\n  ")}`
}

/**
 * Render what earlier agents produced into a block for a downstream prompt, or
 * "" when there is nothing.
 *
 * Empty rather than a placeholder: every built-in task template carries
 * `{{upstreamOutputs}}`, and an unresolved placeholder would be handed to the
 * model as literal text.
 *
 * The newlines belong to the block, not to the template — a section that is not
 * there must not leave its blank lines behind. That is why the leading and
 * trailing `\n` live here, and why the template places the placeholder on its
 * own line with no section heading: an empty value then leaves nothing dangling.
 *
 * Oldest-first is the order worth reading, so the block is built forwards and
 * trimmed from the front. The newest output is the most relevant to the stage
 * about to run, so it is the last thing that may be dropped.
 *
 * Known limitation, recorded rather than fixed: `renderPrompt` substitutes
 * `{{file:…}}` and then every context key, and `AgentRunner` layers
 * `agentScope`/`agentPlan` *after* the snapshot. So if an upstream output's body
 * literally contains `{{agentScope}}`, the downstream agent's own scope will
 * replace it. This is a pre-existing property of the substitution order that
 * `{{conversation}}` shares; cleaning agent output would corrupt legitimate text,
 * so it is out of scope here.
 */
export function renderUpstreamOutputs(outputs: readonly UpstreamOutput[]): string {
  // Empty rather than a placeholder. Deliberate, and consistent with
  // `renderConversation` — which also returns "": the template keeps the
  // placeholder on its own line, so an absent section leaves one harmless blank
  // line rather than a dangling heading. Do not special-case it away.
  if (outputs.length === 0) return ""

  const entries = outputs.map(entry)

  // The budget is the size of the block that is actually injected, heading and
  // trailing newline included — not just the entries. Sizing only the entries
  // would leave the heading's characters unbudgeted and let the returned string
  // exceed `MAX_UPSTREAM_CHARS`.
  while (entries.length > 1 && block(entries).length > MAX_UPSTREAM_CHARS) {
    entries.shift()
  }

  return block(entries)
}
