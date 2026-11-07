# multiclaw Batch 5c Plan — 2026-10-15

> Scope: E4 deliverable summary, E5 `run --dry-run`, E7 `/export`, T7 stream search / jump-to-latest, and C9 true stage concurrency pool.

## Goals

Batch 5c closes the remaining review items that improve headless run observability, pre-run confidence, TUI log retrieval, and stage throughput. Changes should be small, testable, and keep existing public runtime interfaces stable.

## Items

### C9 — true concurrency pool

Current `Orchestrator.runStage()` caps concurrency by slicing a stage into fixed chunks and awaiting each chunk. This respects the cap but leaves freed slots idle when one agent in a chunk is slow.

Implementation:
- Replace fixed chunks with a small worker pool in `packages/core/src/orchestrator/Orchestrator.ts`.
- Preserve current semantics:
  - no cap or cap >= stage size still uses a single `Promise.all`;
  - result order remains declaration order, not completion order;
  - failures stay values because `AgentRunner.run()` resolves to `AgentResult`.
- Add a regression test in `packages/core/src/orchestrator/Orchestrator.run.test.ts` proving agent `c` starts before slow agent `a` finishes while peak concurrency remains <= 2.

### E5 — `multiclaw run --dry-run`

The review asks for “run leader but do not execute pipeline”. In this codebase the leader is part of execution and availability checks. A safe MVP is a static dry-run that never launches runtimes: it shows the config-derived plan and exits before runtime availability, log creation, or orchestrator construction. This keeps `--dry-run` side-effect-light and useful for config inspection.

Implementation:
- Add CLI option in `packages/cli/src/index.ts`.
- Add `dryRun?: boolean` to `RunOptions`.
- In `packages/cli/src/commands/run.ts`, after config loading, `--no-leader`, and resume path resolution, print the resolved run directory, requirement, leader mode, agents, and static stages, then return.
- Add tests proving dry-run does not construct/run the orchestrator or create the normal logs.

### E4 — deliverable summary

The CLI already writes `logs/report.json` from the orchestration completion payload. Add a post-run workspace scan owned by the CLI so core runtime types remain minimally widened only if needed.

Implementation:
- Snapshot the run workDir before execution, excluding `.multiclaw/` internals.
- After `logs.drain()`, scan again for files created or modified since the snapshot.
- Attach a bounded `deliverables` list to the run result before the final report is emitted, so `report.json` contains it and `ConsoleReporter` can print it.
- Prefer relative paths, file size, and created/modified marker; cap output to avoid noisy reports.
- Add FileLogWriter/ConsoleReporter/runCommand tests.

### E7 — TUI `/export [n] [path]`

Export a finished turn as Markdown for sharing or archiving.

Implementation:
- Add `/export [turn] [path]` to `COMMANDS` and help-derived command list.
- Implement pure formatting in a TUI helper, likely near `history.ts`, using `recordedTurns()` / `pickTurn()` semantics.
- Default path: `config.workDir/.multiclaw/console/turn-<n>.md`.
- Export requirement, result/reply, agents/statuses, and focused or per-agent logs.
- Add integration tests that export the last turn by default and a named turn.

### T7 — stream search and jump-to-latest

Respect the project keymap rule: no new naked keys. Use slash commands.

Implementation:
- Add `/search <text>` and `/latest` commands.
- Search acts on the currently shown/focused stream and scrolls to the newest matching wrapped row, using the same wrapping basis as `visibleLog()`.
- `/latest` sets scroll back to 0 and re-arms follow.
- Add state tests for search-to-match and latest reset; add App integration tests for visible notices/markers.

## Verification

For each item:
1. Run the targeted test file first.
2. For regression locks, temporarily revert the implementation line or inject the old bug and prove the new test fails.
3. Run package-level tests for touched packages.
4. End with `pnpm verify`; run package coverage when a new file is added to a coverage-sensitive package.
