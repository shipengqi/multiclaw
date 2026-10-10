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
      thresholds: {
        statements: 35,
        branches: 80,
        functions: 55,
        lines: 35,
      },
    },
  },
})
