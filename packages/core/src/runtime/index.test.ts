import { describe, expect, it } from "vitest"
import { AcpRuntime, runtimeRegistry } from "./index"

describe("runtimeRegistry", () => {
  it("registers the built-in acp runtime", () => {
    expect(runtimeRegistry.has("acp")).toBe(true)
    expect(runtimeRegistry.list()).toContain("acp")
    expect(runtimeRegistry.get("acp")).toBeInstanceOf(AcpRuntime)
  })

  it("throws with the available names for an unknown runtime", () => {
    expect(() => runtimeRegistry.get("does-not-exist")).toThrow(
      /Runtime not found: "does-not-exist"/
    )
  })

  it("registers and retrieves a custom runtime", () => {
    const fake = {
      name: "custom-runtime",
      describe: async () => ({
        name: "custom-runtime",
        available: true,
        capabilities: {
          streaming: false,
          sessions: false,
          resume: false,
          permissions: false,
          tools: false,
          models: false,
          images: false,
          usage: false,
          cost: false,
          sandbox: false,
        },
      }),
      execute: async () => ({ output: "", exitCode: 0 }),
    }
    runtimeRegistry.register(fake)
    expect(runtimeRegistry.get("custom-runtime")).toBe(fake)
    expect(runtimeRegistry.has("custom-runtime")).toBe(true)
  })
})
