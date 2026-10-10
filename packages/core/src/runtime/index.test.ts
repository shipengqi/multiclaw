import { describe, expect, it } from "vitest"
import { ClaudeRuntime, runtimeRegistry } from "./index"

describe("runtimeRegistry", () => {
  it("registers the built-in claude runtime", () => {
    expect(runtimeRegistry.has("claude")).toBe(true)
    expect(runtimeRegistry.list()).toContain("claude")
    expect(runtimeRegistry.get("claude")).toBeInstanceOf(ClaudeRuntime)
  })

  it("throws with the available names for an unknown runtime", () => {
    expect(() => runtimeRegistry.get("does-not-exist")).toThrow(
      /Runtime not found: "does-not-exist"/
    )
  })

  it("registers and retrieves a custom runtime", () => {
    const fake = {
      name: "custom-runtime",
      checkAvailable: async () => true,
      execute: async () => ({ output: "", exitCode: 0 }),
    }
    runtimeRegistry.register(fake)
    expect(runtimeRegistry.get("custom-runtime")).toBe(fake)
    expect(runtimeRegistry.has("custom-runtime")).toBe(true)
  })
})
