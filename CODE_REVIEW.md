# multiclaw — Code Review

**Scope:** `packages/core`, `packages/cli`, `packages/dashboard` + build/CI layer
**Revision reviewed:** `61c6a02 refactor: tui` (working tree clean)
**Size:** 88 source files, ~9,200 LOC

---

## Summary

This is a genuinely well-built codebase, and the parts that are hard to get right are
the parts that are done right. The reducer is a pure function with an explicit
no-op identity contract. `StageBuilder` detects cycles and missing dependencies
instead of looping forever. `EventBus` isolates a throwing subscriber. The
`reply`-on-`OrchestratorResult` design cleanly separates "the team worked" from
"the leader answered you", and `ConsoleReporter` distinguishes all four terminal
states. `parseLeaderDecision` is more robust than it needs to be, in a good way.
The comments explain *why*, and — unusually — they are accurate.

The problems are not in the design. They are in **the paths nobody exercises**:
cancellation, small terminals, projects that aren't already ESM, and the
publish/packaging pipeline. Three of those are blockers, and one of them means
the documented quickstart does not work for most users.

**Key concerns, in order:**
1. Cancellation is reported as success (exit code 0, "done" on screen).
2. `multiclaw init` produces a config that cannot load in a normal project.
3. The TUI corrupts the screen on a standard 24-row terminal.

**What I verified vs. assumed:** every finding below was confirmed by reading the
cited code. Findings marked **[reproduced]** were confirmed by executing the
scenario — I did not take them on trust.

---

## ✅ Resolution — every finding addressed (2026-10-11)

Fixed in the working tree on top of `61c6a02`. `pnpm verify` is green: lint clean,
build succeeds, typecheck clean, **439 tests** pass (core 159 · cli 32 ·
dashboard 248) and all coverage thresholds hold.

| Finding | Fix |
|---|---|
| **B1** aborted run reports success | explicit `cancelled` flag; the mid-stage break also clears `allSuccess` |
| **B2** config needs `"type": "module"` | the loader owns the format decision; `init` says so |
| **B3** unbudgeted TUI body | body is `overflow="hidden"` with a measured rail; panels `flexShrink={0}` |
| **M1** scaffolded import may not resolve | `init` prints that the CLI resolves the import itself |
| **M2** `buildStages` throws inside `run()` | `buildStagesOrFallback` warns and degrades to declaration order |
| **M3** `applyTaskPlan` mutates caller config | `configuredAgents()` returns copies |
| **M4** `$` patterns mangled by `renderPrompt` | function-form `replace` |
| **M5** `AgentRunner.run` can reject | the throwing calls moved inside the `try` |
| **M6** AbortSignal listener leak | the handler is hoisted and removed in `.finally` |
| **M7** log write can crash / truncate | `stream.on("error")`; `run` drains instead of `process.exit` |
| **M8** core publishes 59 files | `"files": ["dist", "package.json"]` |
| **M9** no version-sync guard on release | the same three-way assertion `bump-version.yml` already had |
| **M10** unbounded history list | windowed against the body height, cursor scrolled into view |
| **M11** rail budgeted as one row | measured and charged honestly, capped at `MAX_RAIL_ROWS` |

**Minor & nits — all addressed.** Overlay guards now precede `ctrl+d/l/a/e`; `/focus`,
`/clear` and `ctrl+l` validate against the *shown* turn; a mid-turn warning rides
alongside the outcome instead of masking it; the header names the turn on screen;
the caret only blinks when there is something to indicate; `mapShown`'s no-op
identity holds for single-agent cycles and repeat focus; `snapshot()`'s
by-reference sharing is documented as an invariant; the palette highlight is
clamped to the rendered window; the prompt goes over stdin rather than argv;
`{{agentScope}}` / `{{agentPlan}}` have defaults; a regrouped plan is re-published
as `orchestration:stages`; `.pnpmrc` (which pnpm never read) is deleted; the dead
Tailwind CSS config and stale `dist/client|server` dirs are gone; `init`
interpolates via `JSON.stringify`; `cli/src/index.ts` no longer assumes `err` is an
`Error`.

Two behaviour changes worth knowing:
- `focus:cycle` with a single agent is now a true no-op — it no longer resets the
  scroll window, because there is no other agent to switch to. The old test that
  asserted the reset was split; a new one pins the no-op.
- `orchestration:stages` is a **new event**. Any consumer that switches
  exhaustively over `MultiClawEvent` should handle it; the TUI reducer and the CLI
  reporter both do.

---

## 🔴 Blockers

### B1. An aborted run reports `success: true` **[reproduced by trace]**

`packages/core/src/orchestrator/Orchestrator.ts:95-117`

```ts
const stageResults = await this.runStage(stage, options.signal)
results.push(...stageResults)

// Cancelled mid-stage: stop scheduling further stages and fall through to
// the completion result rather than emitting a misleading stage:complete.
if (options.signal?.aborted) break          // ← line 100

...
for (const r of stageResults) {              // ← lines 112-117, never reached
  if (r.status !== "success") {
    allSuccess = false
```

**Why:** `AgentRunner` converts an abort into a normal `{status: "failed"}` result
rather than throwing (`AgentRunner.ts:117-136`). So when a user cancels mid-stage,
`results` is already full of `failed` entries — but the `break` at line 100 fires
*before* the loop that sets `allSuccess = false`. `run()` then resolves with
`success: true` (line 142) and `agentResults` full of failures.

**Consequences, both downstream:**
- `packages/cli/src/commands/run.ts:46` → `process.exit(result.success ? 0 : 1)` → **Ctrl-C exits 0.**
- `packages/dashboard/src/tui/App.tsx:217-220` → the `catch (isAbortError(err))` branch is
  **dead code**, because `run()` never rejects on abort. A cancelled turn renders as `✓ done`.

**Suggestion:** set `allSuccess = false` before the `break` — or better, add an explicit
`cancelled` flag to `OrchestratorResult`, since "aborted" is genuinely a third outcome
alongside success and failure, and the console wants to say "cancelled" rather than
"finished with failures".

---

### B2. A config cannot be loaded unless the nearest `package.json` says `"type": "module"` **[reproduced]**

`packages/cli/src/loader/loadConfig.ts:30-37`

```ts
const { register } = await import("tsx/esm/api")
const unregister = register()
try {
  mod = await import(absPath)
} finally {
  unregister()
}
```

I reproduced this with the exact mechanism, on Node v22.22.2:

| Project shape | Result |
|---|---|
| `package.json` **with** `"type":"module"` | loads fine |
| `package.json` **without** it (the Node default) | `Error: Cannot require() ES Module ... in a cycle.` |

**Why it matters:** `multiclaw init` writes `multiclaw.config.ts` and **nothing else** —
it does not create or patch a `package.json` (`init.ts:104-108`). So the documented
quickstart fails in a fresh directory, and fails in every ordinary CommonJS project.
Both `multiclaw` and `multiclaw run` go through `loadConfig`, so both are dead there.

**Why it isn't caught in-repo:** `examples/dev-team/package.json` declares
`"type": "module"`, which masks exactly this case.

**Suggestion:** don't inherit the caller's module system. Either load the config with a
loader that owns the format decision (`jiti`, `bundle-require`), or have `init` write
`.mts` / add `"type":"module"` deliberately. And regardless: catch this and print an
actionable message instead of a raw Node stack — the current failure gives the user
no idea that a missing `package.json` field is the cause.

---

### B3. The TUI body is not budgeted, so content overlaps and rows vanish **[reproduced]**

`packages/dashboard/src/tui/layout.ts:78-90` · `App.tsx:608` · `components/overlays.tsx:49-71`

`reserved` accounts for the **chrome** only. The body gets a fixed height:

```ts
const bodyHeight = Math.max(MIN_BODY_ROWS, rows - reserved)   // layout.ts:90
```

but the components *inside* the body (`HelpOverlay`, `HistoryOverlay`, `WelcomePanel`,
`ReplyPanel`) render a content-determined number of rows that is never compared to it.
The body box is `flexShrink={1}` (`App.tsx:608`) and Ink's `Box` defaults to
`flexShrink: 1`, so Yoga compresses the child and its text rows overlap.

I rendered `App` at 80×24 and pressed `?`. `HelpOverlay` is 23 rows; `bodyHeight` is 19:

```
  pgup pgdn       Scroll the stream a pagene      ← "a page" + tail of "one line"
  ?               This helpnished turns           ← "This help" + tail of "finished turns"
```

Three help rows (`enter (busy)`, `↑ ↓`, `/history`) are **silently dropped**. At 40×10 the
welcome screen renders `› describe what the team should do…r.`

**Why it isn't caught:** the existing `App.test.tsx` matrix asserts the header, prompt and
hint bar are *present* — and those are rendered *after* the body, so they overwrite the
overflow. The corruption is invisible to those assertions. The same test at 100×30 passes
perfectly, which is why it looked safe.

**Suggestion:** make the degradation explicit rather than emergent. `flexShrink={0}` on the
overlay/panel root plus `overflow="hidden"` on the body turns silent overlap into a clean
clip; then window the lists (see M13) so nothing important is the thing that gets clipped.

---

## 🟡 Major

### M1. The scaffolded config imports a package the user may not have locally **[verified]**

`packages/cli/src/commands/init.ts:59`

```ts
return `import { defineConfig, agents } from "multiclaw"
```

`README.md` tells users to `npm install -g multiclaw`. A global install's `node_modules` is
**not** in the ESM resolution chain of the user's project, so the generated config cannot
resolve its own import. This is the complement of B2: an ESM project hits this, a CJS or
manifest-less project hits B2. Either way the quickstart fails.

**Suggestion:** have `init` add `multiclaw` to the project's `devDependencies` and say so, or
ship `defineConfig`/`agents` as a shim the CLI resolves itself.

---

### M2. `buildStages` throws inside `run()`, so a bad plan crashes the turn **[verified]**

`Orchestrator.ts:54` and `:109` · `StageBuilder.ts:12,21`

```ts
let stages = buildStages(agents)      // line 54  — unguarded
...
stages = buildStages(agents)          // line 109 — unguarded
```

`buildStages` throws on a missing dependency and on a cycle. Neither call site is wrapped.

Two concrete triggers:
- `applyTaskPlan` does `agent.dependsOn = task.dependsOn` (line 294), **overwriting** the
  pruned `dependsOn` from `selectAgents` (line 250). If the architect writes a plan naming a
  dependency the leader did not select, line 109 throws.
- A user config with a typo'd `dependsOn` throws at line 54.

`run()` then rejects, `orchestration:complete` is never emitted, and `run.ts:45` has no
`try/catch` → unhandled rejection stack trace instead of a structured failure.

**Suggestion:** wrap both calls, emit `orchestration:warning`, and degrade to declaration
order. Also validate the plan's `dependsOn` against the selected set inside `applyTaskPlan`.

---

### M3. `applyTaskPlan` mutates the caller's `config.agents` in place **[verified]**

`Orchestrator.ts:180-181, 194, 211` + `:290-299`

```ts
return { kind: "run", agents: this.config.agents }   // ← the SAME objects
...
agent.taskTitle = task.title        // line 293 — mutates the shared object
agent.dependsOn = task.dependsOn    // line 294
agent.agentScope = task.scope       // line 295
```

`selectAgents` returns copies (`{...a, dependsOn: ...}`, line 246-251), so the leader path is
safe. The no-leader / leader-failed / empty-output paths return the **original references**.

**Why it matters:** the console deliberately reuses one `config` across turns
(`App.tsx:198`). Turn 1's architect writes a plan → `dependsOn` / `agentScope` / `agentPlan`
are written onto the shared objects. Turn 2 calls `clearStaleTaskPlan()`, which deletes the
*file* — but the in-memory fields survive, so turn 2 runs with turn 1's dependency graph.

This is precisely the invariant the comment at `Orchestrator.ts:157-164` claims to protect.
The comment's promise is not implemented for the no-leader path.

**Suggestion:** have the no-leader branches return `this.config.agents.map(a => ({...a}))`,
so `applyTaskPlan` never touches shared state. That also makes the `clearStaleTaskPlan`
guarantee actually hold.

---

### M4. `renderPrompt` mangles any `$` replacement pattern in the substituted text **[reproduced]**

`packages/core/src/utils/prompt.ts:15,21`

```ts
result = result.replace(match[0], content)                  // line 15
result = result.replaceAll(`{{${key}}}`, value)             // line 21
```

`String.replace` with a *string* replacement interprets `$&`, `` $` ``, `$'`, `$$`.
Confirmed on this machine:

```
template : "Requirement: {{requirement}} done."
value    : "cost is $& and $1 and $` and $'"
raw      : "Requirement: cost is {{requirement}} and $1 and Requirement:  and  done. done."
function : "Requirement: cost is $& and $1 and $` and $' done."     ← correct
```

**Why it matters in practice:** `{{file:...}}` inlines file contents (architecture docs,
`deploy.sh`, Makefiles). `$$` is the shell PID and appears in most shell scripts — it
silently collapses to a single `$`. `$'...'` (bash ANSI-C quoting) is likewise common.

**Suggestion:** use the function form — `replace(match[0], () => content)` and
`replaceAll(\`{{${key}}}\`, () => value)`. Two-character fix, removes a whole class of
silent prompt corruption.

---

### M5. `AgentRunner.run` can reject, breaking its own contract **[verified]**

`packages/core/src/orchestrator/AgentRunner.ts:23,25` — both **before** the `try` at line 46.

```ts
fs.mkdirSync(workDir, { recursive: true })                  // line 23 — can throw
const runtime = runtimeRegistry.get(agent.runtime ?? "claude")  // line 25 — throws if unknown
```

The rest of the method is written to never throw: it catches everything and returns a
`failed` `AgentResult`. Callers depend on that (`runStage`'s `Promise.all`, `resolveTurn`).
A pre-`try` throw violates it and yields a partially-emitted event stream.

The TUI never pre-validates runtimes (only the CLI does, `run.ts:22-35`), so a config naming
an unknown runtime crashes the console.

**Suggestion:** move lines 23-29 inside the `try` and emit `agent:failed` for these too.

---

### M6. AbortSignal listener leak — one per agent run **[verified]**

`packages/core/src/utils/timeout.ts:30-33` vs `.finally` at `:35-38`

```ts
const cancelled = new Promise<never>((_, reject) => {
  if (!signal) return
  signal.addEventListener("abort", () => reject(abortError()), { once: true })
})
...
.finally(() => {
  clearTimeout(timer)
  signal?.removeEventListener("abort", forward)     // ← only `forward` is removed
})
```

The `cancelled` listener is `{once: true}`, so it is removed *when it fires* — but on the
normal path it never fires, so it stays attached for the life of the signal. `Orchestrator`
passes the **same** `options.signal` to every `runner.run`, so each agent leaks one listener.

With 11+ agents (the repo ships a 10-agent fullstack preset) Node emits
`MaxListenersExceededWarning` and retains a closure per agent.

**Suggestion:** hoist the handler and remove it in `.finally` alongside `forward`.

---

### M7. Log writes can crash the run, and `run` truncates the log tail **[verified]**

`packages/cli/src/reporters/FileLogWriter.ts:29,35-38` + `packages/cli/src/commands/run.ts:46`

```ts
stream = fs.createWriteStream(path.join(this.logDir, `${agentId}.log`))   // no .on("error")
```

`EventBus.emit` only wraps the *synchronous* listener call in try/catch, so an
asynchronous stream error (ENOSPC, EACCES, directory removed mid-run) becomes an
unhandled `'error'` event and kills the process. The test file itself documents the
hazard — `FileLogWriter.test.ts:49-51` delays cleanup "otherwise the stream emits an
unhandled ENOENT".

Separately, `closeAll()` calls `s.end()`, which flushes **asynchronously**, but
`run.ts:46` calls `process.exit()` on the very next statement. The tail of the last
agent's log can be silently lost.

**Suggestion:** attach `stream.on("error", ...)`; and in `run.ts` set `process.exitCode`
and let the loop drain (or await a `closeAll()` promise) rather than `process.exit`.

---

### M8. `@multiclawcli/core` publishes 59 files instead of `dist` **[reproduced]**

`packages/core/package.json` — no `files` field. `cli` and `dashboard` both declare
`"files": ["dist","package.json"]`; core does not.

`npm pack --dry-run` reports **59 files**: all of `src/**` including `*.test.ts` and
`src/testing/helpers.ts`, plus `coverage/coverage-summary.json` and a 68 kB
`tsconfig.tsbuildinfo`. The root `.gitignore` does not protect it — npm only honours a
`.gitignore` inside the package directory.

Every consumer downloads internal test fixtures and a stale build cache, and `src` becomes
an accidental deep-import surface. The install still works, which is why it went unnoticed.

**Suggestion:** add `"files": ["dist", "package.json"]`.

---

### M9. `release.yml` has no version-sync guard, unlike `bump-version.yml` **[verified]**

`.github/workflows/release.yml:62-69`

```yaml
run: pnpm -r --filter "./packages/*" publish --no-git-checks --access public
...
version=$(node -p "require('./packages/core/package.json').version")
git tag "v$version"
```

`bump-version.yml:59-65` **does** guard this invariant:

```js
if (new Set(current).size !== 1) {
  console.log(`::error::Packages are out of sync: ...`)
  process.exit(1)
}
```

Release does not. It publishes whatever the three manifests currently say and derives the
tag from `packages/core` alone. A hand-edited version publishes three packages at different
versions, tagged with only core's — exactly what the process claims to prevent.

**Suggestion:** run the same three-way equality assertion at the top of the Release job,
before the publish step. The guard already exists; it just needs to be on both paths.

---

### M10. `HistoryOverlay` is unbounded — the selection can move off-screen **[verified]**

`packages/dashboard/src/tui/components/overlays.tsx:123-151`

Each turn costs 3 rows (2 content + 1 gap). `MAX_HISTORY = 20` (`state.ts:95`), so the list
wants ~63 rows. There is no windowing, and `historyIndex` (`App.tsx:382-383`) is clamped to
`historyTurns.length - 1` — never to what fits on screen.

After ~8 turns, `↓` moves the highlight below the visible area, so no row is marked — yet
`App.tsx:466-468` still does `dispatch({type:"view:open", turn: historyTurns[historyIndex].turn})`.
**`enter` opens a turn the user cannot see.** The overlay's whole purpose breaks exactly when
it becomes useful.

**Suggestion:** window the list against the body height and scroll the cursor into view —
which also fixes the clipping half of B3.

---

### M11. `PipelineRail` wraps to multiple rows but is budgeted as one **[verified]**

`packages/dashboard/src/tui/components/chrome.tsx:103` — `<Box flexWrap="wrap">`
`layout.ts:81` — `(showRail ? 2 : 0)` — a flat charge of "rail + gap".

With enough stages/agents the rail occupies 2+ rows while `reserved` still charges 2. The
chrome then overflows and Yoga takes the row back from the body (`flexShrink={1}`), silently
shrinking the stream. This is a third, independent way the `reserved` contract is violated.

**Suggestion:** either keep the rail to one row (`flexWrap="nowrap"` + a `+N` overflow chip),
or measure it and charge it honestly.

---

## 💭 Minor & nits

**Input handling**
- `App.tsx:427-443` — `ctrl+d`, `ctrl+l`, `ctrl+a`, `ctrl+e` are handled *before* the
  `helpOpen` (445) and `historyOpen` (452) guards. `ctrl+l` clears the log behind an open
  overlay; `ctrl+d` on an empty line quits from inside help. The history overlay's own
  comment says it "swallows everything it does not use" — it doesn't. Moving these four
  branches below the guards fixes it.
- `App.tsx:258,272` — `/focus` and `/clear` validate and label against the **live** `state`
  but dispatch through `mapShown`, which writes to `view`. While browsing, `/clear` clears
  the viewed turn's buffer but reports `cleared <live focus>`. Validate against `shown`.

**Status & chrome honesty**
- `App.tsx:77-82` — `if (state.warning)` precedes the `phase === "complete"` check at 107,
  and `warning` is only cleared by `turn:start`. So any mid-turn warning (e.g. "The leader
  could not be reached") **permanently masks the outcome** — the user never learns whether
  the run succeeded. Prefer the outcome once complete, and surface the warning separately.
- `App.tsx:595` — the header renders the **live** `turn N` while the body and banner render
  the **viewed** turn. Either use `shown.turn`, or label it `turn N · live`.
- `App.tsx:161-175` — the comment says "an idle console should not repaint at all", but the
  caret interval repaints the whole tree every 530 ms unconditionally. Either correct the
  comment or gate the blink on `running || line.text`.

**State**
- `state.ts:463-478` — `mapShown`'s documented no-op identity contract holds where the tests
  assert it (`ids.length === 0`, unknown id) but is violated elsewhere: `focus:cycle` with a
  single agent, and `focus:set` on the already-focused agent, both return a fresh object.
  Cheap to fix, and it removes needless whole-tree re-renders.
- `snapshot()` (`state.ts:387-405`) shares `agents` / `stages` / `leaderIds` **by reference**
  with the live turn. I checked every reducer path — they are all immutable, so this is
  correct today. It's worth a comment, though: a single future in-place edit would silently
  corrupt history. (The explicit field list, and the reason for it, are good.)
- `App.tsx:373` vs `646` — `selected` can index past `matches.slice(0, layout.menuRows)`.
  Currently impossible because `COMMANDS` has exactly `MAX_MENU_ROWS = 7` entries, but the
  guard is missing.

**Core**
- `prompt.ts:12` — `path.resolve(workDir, match[1])` is unbounded: `{{file:../../etc/passwd}}`
  escapes the workspace. Not reachable today (templates are built-in constants), but it
  becomes a traversal primitive the moment a template is config-sourced. Worth constraining now.
- `runtime/ClaudeRuntime.ts:19` — the prompt is passed as argv (`["-p", task.prompt, ...]`).
  Prompts inline whole design docs via `{{file:...}}`; a large one hits `ARG_MAX`/`E2BIG` and
  fails as "Failed to start claude". stdin would avoid it.
- `runtime/ClaudeRuntime.ts:24-25` — `child.kill()` signals only the direct child. `claude`
  spawns its own subprocesses; without `detached: true` + `process.kill(-pid)` those can
  survive as orphans, and there is no SIGKILL escalation if `claude` ignores SIGTERM.
- `runtime/ClaudeRuntime.ts` — `task.timeout` is declared on `AgentTask` and passed by
  `AgentRunner`, but never read. Timeout is enforced only indirectly via `withTimeout`.
  Either honour it or drop it from the type.
- `retry.ts:26` — `await sleep(delayMs * attempt)` is not abort-aware, so cancellation during
  backoff dangles up to `delayMs * attempt`. It never re-invokes `fn` (the top-of-loop check
  catches it), but the continuation lingers.
- `agents/*.ts` — `{{agentScope}}` / `{{agentPlan}}` are only populated when the architect
  wrote a plan entry for that agent. The leader may select a developer without the architect,
  and the no-leader path has no plan at all — in both cases the prompt sent to the model
  contains the literal text `{{agentScope}}`. Default them to a placeholder string.
- `Orchestrator.ts:60-70` — `orchestration:start` publishes stage info computed *before* the
  plan is applied; `stages` is rebuilt at line 109 with no re-emit, so the console can draw a
  grouping that differs from what ran.

**Packaging & config**
- `.pnpmrc` — `node-linker=hoisted` and `ignore-scripts=false` are **not read**: pnpm loads
  npm-style settings from `.npmrc` and the rest from `pnpm-workspace.yaml`. Confirmed:
  `pnpm config get node-linker` → `undefined`, and the install is isolated. Rename to
  `.npmrc` or move the setting, or delete the file if hoisting isn't needed.
- `biome.json:26-28` + the `**/*.css` override — `css.parser.tailwindDirectives: true` and a
  `noUnknownAtRules` exemption for a stylesheet that no longer exists (there are **zero**
  `.css` files in the repo). Left over from the removed Vite client. Also: empty
  `packages/dashboard/dist/client/` and `dist/server/` directories survive `clean: true`.
- `commands/init.ts:62-65` — `${opts.projectName}` is interpolated raw into a JS string
  literal, so a project named `My "App"` produces a syntactically broken config. Use
  `JSON.stringify`.
- `cli/src/index.ts:44` — `(err as Error).message ?? err` throws a `TypeError` when `err` is
  `null`/`undefined` (the cast is not a runtime check). `err instanceof Error ? err.message : String(err)`.

---

## What's genuinely good — keep doing this

- **`StageBuilder`** (`orchestrator/StageBuilder.ts`) — explicit missing-dependency and cycle
  detection with actionable messages, stable input order, empty input handled. This is how
  graph code should read.
- **`parseLeaderDecision` + `extractJsonObjects`** (`utils/leaderDecision.ts`, `utils/json.ts`) —
  the brace- and string-aware scanner is genuinely more robust than a regex, tolerates prose
  and fences, skips non-decision objects, and accepts `{"run":[...]}` without `mode` for
  backward compatibility. `asDecision` validates element types instead of trusting them.
- **`EventBus.emit`** (`event/EventBus.ts:11-19`) — a throwing subscriber is caught and logged
  rather than breaking the emitter loop. `subscribe` returns a real unsubscribe.
- **The `reply` field on `OrchestratorResult`** (`types/config.ts`) — putting "how did this turn
  end" on the result rather than inventing a new event type kept the CLI and TUI in step for
  free. `finishEmpty` refusing to fake success is the same instinct, well applied.
- **`ConsoleReporter`'s four-case summary** — success / failures / answered / needs-input are
  all distinguished, and the answered case explicitly avoids claiming "All done".
- **`withTimeout`'s already-aborted guard** (`utils/timeout.ts:11`) — refusing to spawn a
  process only to kill it is a detail most codebases miss.
- **`TuiState extends TurnView` with `mapShown`** — the browse-a-past-turn feature lands edits
  on a detached copy and cannot disturb the live run. Elegant, and the `snapshot()` docstring
  explains the one subtle thing (why not to spread).
- **The scroll-offset-from-tail model** (`state.ts:480-486, 557-569`) — new output never pushes
  away what you're reading, and the reducer clamp and render clamp agree.
- **The comment quality throughout.** They explain constraints and past failures, not mechanics.
  That is rare and it is what made this review possible to do quickly.

---

## Open questions (intent unclear — not defects)

1. `{"mode":"run","run":[]}` parses as a decision → `selectAgents([])` → `finishEmpty` →
   **failure**. Is an empty `run` intended as "run nothing", or should it fall back to prose?
2. `continueOnError: true` lets a dependent agent run even when its dependency failed. Test
   `Orchestrator.run.test.ts:110-122` asserts this — deliberate, or an oversight?
3. `run` exits **0** when the leader only *asks* a question (`finishWithMessage` sets
   `success: true` for both `reply` and `ask`). In CI a script can't tell "answered" from
   "waiting for input". Should `ask` exit non-zero?
4. `multiclaw run` relocates `workDir` to `.multiclaw/runs/run-<ts>` (`run.ts:20`) while the
   console runs in place. Same config, different filesystem behaviour — intended?
5. `ClaudeRuntime` forwards the whole `process.env` to the child. Intended, or should it be
   allow-listed?

---

## Suggested order of work

1. **B2** — the quickstart is broken for most users; highest user-visible impact, and it
   blocks anyone evaluating the tool.
2. **B1** — a cancelled run silently succeeding is a correctness bug that also makes
   `App.tsx`'s abort handling dead code.
3. **B3 + M10 + M11** — one coherent piece of work: make the body budget honest and window
   the overlays. Fixing only B3 turns overlap into invisible truncation.
4. **M2, M3, M5** — the `Orchestrator`/`AgentRunner` error paths. Same area, one pass.
5. **M4** — a two-character fix for a silent-corruption class.
6. **M8, M9** — packaging and release safety, before the next publish.
7. Then the minors.

---

*Reviewed as Code Reviewer. Every finding above was verified against the cited code; the
three marked [reproduced] were confirmed by execution. Where I was unsure of intent I asked
rather than assumed.*
