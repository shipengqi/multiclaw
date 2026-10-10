import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/lib.ts"],
      // Baseline lock: the CLI command entry points (init/run/serve) are
      // integration surface and not yet unit-tested. Raise these as they gain
      // coverage — the goal is to prevent regression, not to celebrate a number.
      thresholds: {
        statements: 45,
        branches: 70,
        functions: 75,
        lines: 45,
      },
    },
  },
})
