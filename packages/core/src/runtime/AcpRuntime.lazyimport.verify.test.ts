/**
 * Independent verification (acp-verifier) — item 1: the SDK import is lazy.
 *
 * This file deliberately mocks `@agentclientprotocol/sdk` so that *any* load of
 * it flips a flag. If AcpRuntime had a top-level static import, merely importing
 * the module would set the flag; if `describe()` imported it, calling describe()
 * would. Neither may happen: the SDK (and the ~5s of zod it drags in) must stay
 * off the CLI-startup path.
 */
import { describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({ loads: 0 }))

vi.mock("@agentclientprotocol/sdk", () => {
  sdk.loads += 1
  return {}
})

// Imported AFTER the mock is registered, so a static import would bump `loads`.
const { AcpRuntime } = await import("./AcpRuntime")

describe("AcpRuntime · lazy SDK import (verification)", () => {
  it("does not load the SDK merely by importing the module", () => {
    expect(sdk.loads).toBe(0)
  })

  it("describe() resolves availability without loading the SDK", async () => {
    const info = await new AcpRuntime().describe()
    expect(info.name).toBe("acp")
    expect(info.available).toBeTypeOf("boolean")
    expect(sdk.loads).toBe(0)
  })

  it("still does not load the SDK after describe() on a missing binary", async () => {
    const original = process.env.PATH
    process.env.PATH = "/definitely-not-a-real-dir-acp-verify"
    try {
      const info = await new AcpRuntime().describe()
      expect(info.available).toBe(false)
    } finally {
      process.env.PATH = original
    }
    expect(sdk.loads).toBe(0)
  })
})
