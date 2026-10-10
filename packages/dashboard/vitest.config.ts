import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/server/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Client code (React/JSX) is not unit-tested yet; scope coverage to the
      // server runtime that these tests exercise.
      include: ["src/server/**/*.ts"],
      exclude: ["src/server/**/*.test.ts", "src/server/index.ts"],
      // Baseline lock. DashboardServer (HTTP shell) is not covered yet.
      //
      // Re-measured after the vitest 4 upgrade: its v8 provider also counts
      // branches and functions of files that are never loaded, so the 0%
      // DashboardServer now drags those ratios down (branch 90% -> 38%,
      // function 67% -> 36%). Statements and lines were unaffected. These are
      // the new baseline values, not a relaxation of intent.
      thresholds: {
        statements: 42,
        branches: 35,
        functions: 32,
        lines: 42,
      },
    },
  },
})
