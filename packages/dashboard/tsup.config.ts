import { defineConfig } from "tsup"

export default defineConfig({
  entry: { tui: "src/tui/index.ts" },
  format: ["esm"],
  outDir: "dist",
  clean: false,
  shims: true,
})
