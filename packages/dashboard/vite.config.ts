import * as path from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  root: ".",
  define: {
    // ws 等 Node.js 包引用了 global，浏览器端需要映射到 globalThis
    global: "globalThis",
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@multiclawcli/core": path.resolve(import.meta.dirname, "../core/src"),
      "@": path.resolve(import.meta.dirname, "./src/client"),
    },
  },
  optimizeDeps: {
    exclude: ["ws", "child_process", "fs", "path"],
  },
})
