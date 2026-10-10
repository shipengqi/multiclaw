# @multiclawcli/dashboard

[![npm](https://img.shields.io/npm/v/@multiclawcli/dashboard)](https://www.npmjs.com/package/@multiclawcli/dashboard)
[![GitHub](https://img.shields.io/badge/GitHub-shipengqi%2Fmulticlaw-blue?logo=github)](https://github.com/shipengqi/multiclaw)

Interactive terminal console for [multiclaw](https://github.com/shipengqi/multiclaw) — the multi-agent
orchestration CLI.

This package provides the Ink-based TUI used internally by the `multiclaw` CLI when it is run with
no subcommand. It is not intended for direct use; install
[`multiclaw`](https://www.npmjs.com/package/multiclaw) instead.

## What it exports

| Export | Purpose |
|--------|---------|
| `./tui` → `startTui({ config, onTurnStart })` | Render the console and drive the turn loop |
| `./tui` → `tuiReducer`, `reduceEvent`, `initialState`, `appendLog`, `stripAnsi` | Pure state machine |
| `./tui` → `TurnView`, `TuiState`, `MAX_HISTORY` | The turn/console split that history is built on |
| `./tui` → `computeLayout` | Terminal geometry: which regions fit at a given size |

`reduceEvent` is a pure `(state, event) => state` function over core's `MultiClawEvent`, and
`computeLayout` is pure arithmetic over `(columns, rows, …)`. Both the state layer and the responsive
rules are therefore testable without a terminal.

## One turn, and the console around it

`TuiState` is split in two, and the split is what makes history possible:

| Type | Holds |
|------|-------|
| `TurnView` | Everything that describes *a turn*: agents, stages, focus, scroll, phase, reply |
| `TuiState extends TurnView` | The above, for the live turn, plus `name`, `history` and `view` |

A finished turn is just a `TurnView` kept in `history`, and every pane takes a `TurnView` — so a past
turn renders through exactly the same components as the live one. `view` is a *detached* copy of the
turn being read: `mapShown` routes `tab`, scroll and `/clear` to `view` when one is open, so browsing
cannot move the focus out from under a run in progress, and cannot rewrite history either.

## Source layout

| Path | Holds |
|------|-------|
| `src/tui/state.ts` | The reducer, the roster seed, the log window, the live clocks, the turn history |
| `src/tui/layout.ts` | Row budget and breakpoints |
| `src/tui/format.ts` | Duration, truncation and padding helpers |
| `src/tui/commands.ts` | The `/` command palette model |
| `src/tui/theme.ts` | Colour, glyph and spinner tokens |
| `src/tui/components/` | Ink components, grouped by role |
| `src/tui/App.tsx` | Keymap and wiring |

Coverage is scoped to the four decision-carrying modules (`state`, `layout`, `format`, `commands`).
The Ink components are render glue, so they are covered by frame assertions in `components.test.tsx`
and `App.test.tsx` rather than by line counts.

## Notes

- The console requires a TTY. Without one, `startTui` throws and the CLI points at `multiclaw run`.
- Rendering happens on the alternate screen buffer, which is always restored on exit.
- Per-agent log buffers are capped (tail window) so a long-running agent cannot exhaust memory.
- The prompt holds focus at all times, so only `?` and `/` are reserved as bare keys, and only while
  the line is empty *and* the console is idle. Everything else is a named key or an ordinary
  character. Mid-run `?` therefore types a literal `?`, because that is what the user is doing.
- The prompt stays live while a turn runs. Submitting queues the text, and the queue starts as the
  next turn once the console is idle — `App.tsx` holds it in a small array, `QueueStrip` renders it,
  and `computeLayout` charges its rows to the body.
- Every turn runs against the same `workDir`. Only the logs are per-run
  (`.multiclaw/runs/run-<stamp>/logs/`), which is what lets a follow-up build on the last turn.
- The hint bar only lists keys that do something *right now*. A turn that ended in a reply takes the
  body, so there is no roster to switch between and `tab` is left out rather than promised.
- The package name is historical: it previously shipped a React web dashboard. Renaming it would
  invalidate the npm trusted-publisher configuration, so the name stays.

## Documentation

Full documentation is available in the [main repository](https://github.com/shipengqi/multiclaw).

## License

[MIT](https://github.com/shipengqi/multiclaw/blob/main/LICENSE)
