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
      //
      // Re-measured after the vitest 4 upgrade: its v8 provider also counts
      // branches and functions of files that are never loaded, so the 0% entry
      // points now drag those ratios down (branch 84% -> 50%, function 85% ->
      // 46%). Statements and lines were unaffected. These are the new baseline
      // values, not a relaxation of intent.
      thresholds: {
        statements: 50,
        branches: 45,
        functions: 40,
        lines: 50,
      },
    },
  },
})
