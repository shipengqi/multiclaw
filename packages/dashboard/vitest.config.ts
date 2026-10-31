import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    fsModuleCachePath: "node_modules/.vitest-cache-dashboard",
    // Ink styles its output through chalk, which disables colour when the
    // stream is not a real TTY. The render tests assert on styled frames
    // (e.g. the inverse-video caret), so colour has to stay on.
    env: { FORCE_COLOR: "1" },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Coverage is scoped to the modules that carry decisions: the reducer, the
      // formatters, the command palette, the layout arithmetic, and the on-disk
      // history (which degrades to empty on five bad inputs and writes
      // atomically). The Ink components are render glue — they are exercised by
      // the frame assertions in components.test.tsx and App.test.tsx, which check
      // output rather than lines, so counting them here would measure the wrong
      // thing.
      include: [
        "src/tui/state.ts",
        "src/tui/format.ts",
        "src/tui/commands.ts",
        "src/tui/interaction.ts",
        "src/tui/layout.ts",
        "src/tui/history.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
})
