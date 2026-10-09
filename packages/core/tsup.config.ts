import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  outDir: "dist",
  dts: { compilerOptions: { composite: false, incremental: false } },
  clean: true,
  shims: true,
})
