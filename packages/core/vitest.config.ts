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
      exclude: [
        "src/**/*.test.ts",
        "src/testing/**",
        "src/index.ts",
        // Pure type declarations — no runtime code to cover.
        "src/types/**",
        // Built-in agent definitions are prompt/data factories, not logic.
        "src/agents/**",
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
