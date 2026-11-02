import { describe, expect, it } from "vitest"
import { resolvePermissionMode } from "./permissionMode"

const config = (
  project?: "auto" | "ask" | "deny",
  fallback?: "auto" | "ask" | "deny"
): Parameters<typeof resolvePermissionMode>[0] => ({
  ...(project ? { permissions: { mode: project } } : {}),
  ...(fallback ? { defaults: { permissions: { mode: fallback } } } : {}),
})

describe("resolvePermissionMode", () => {
  it("prefers the agent's own mode over every project level", () => {
    const agent = { permissions: { mode: "deny" as const } }
    expect(resolvePermissionMode(config("auto", "auto"), agent)).toBe("deny")
  })

  it("prefers the project level over defaults", () => {
    // The pair the console used to get wrong: folding `defaults` into the same
    // test as `permissions` made the header announce `auto` while the runner
    // enforced `deny`.
    expect(resolvePermissionMode(config("deny", "auto"))).toBe("deny")
  })

  it("falls back to defaults when the project level is silent", () => {
    expect(resolvePermissionMode(config(undefined, "ask"))).toBe("ask")
  })

  it("is undefined when nobody configured a mode", () => {
    // Not a default in disguise: the runtime owns the default (auto), and the
    // console substitutes its own (ask) because a human is there to answer.
    expect(resolvePermissionMode(config())).toBeUndefined()
  })

  it("ignores an agent with no permissions block", () => {
    expect(resolvePermissionMode(config(undefined, "deny"), {})).toBe("deny")
  })
})
