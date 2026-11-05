# @multiclawcli/dashboard

Ink terminal UI for multiclaw. Start it through the multiclaw CLI.

The main chat always belongs to a permanent coordinator. Sessions appear on the left; the team inspector is hidden until Ctrl+T. Ctrl+B focuses sessions and Ctrl+G opens the current structured request. Switching chats keeps execution running.

SessionRuntime owns each chat's bindings, drafts, queue, interactions, history and persistence. App handles input/render wiring. Work supplements and dependency-constrained rework belong to core.

Exports include startTui, SessionRuntime and turn-view/format/layout helpers. Journals use version 2; older histories are retained as unsupported without migration.

See the main README for commands. Run package tests with pnpm test and repository checks with pnpm verify.
