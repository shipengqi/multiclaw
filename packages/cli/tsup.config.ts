import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    outDir: "dist",
    clean: true,
    shims: true,
  },
  {
    entry: { lib: "src/lib.ts" },
    format: ["esm"],
    outDir: "dist",
    dts: true,
    shims: true,
  },
])
