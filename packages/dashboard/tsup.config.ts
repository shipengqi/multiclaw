import { defineConfig } from "tsup"

export default defineConfig({
  entry: { tui: "src/tui/index.ts" },
  format: ["esm"],
  outDir: "dist",
  dts: { compilerOptions: { composite: false, incremental: false } },
  clean: true,
  shims: true,
})
