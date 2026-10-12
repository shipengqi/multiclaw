import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { BRIDGE_PACKAGES, resolveBridgeBinary, resolveExecutable } from "./bridge"

describe("bridge resolution", () => {
  it("maps each bundled bridge command to its npm package", () => {
    expect(BRIDGE_PACKAGES["claude-agent-acp"]).toBe("@agentclientprotocol/claude-agent-acp")
    expect(BRIDGE_PACKAGES["codex-acp"]).toBe("@agentclientprotocol/codex-acp")
    // opencode speaks ACP natively and is the user's agent, not a bundled bridge.
    expect(BRIDGE_PACKAGES.opencode).toBeUndefined()
  })

  it("resolves a bundled bridge to an absolute path in node_modules", () => {
    const bin = resolveBridgeBinary("claude-agent-acp")
    expect(bin).not.toBeNull()
    expect(path.isAbsolute(bin!)).toBe(true)
    // The package's bin field points at its entry script.
    expect(bin!.endsWith("index.js")).toBe(true)
  })

  it("returns null for a user-supplied agent that is not a bundled bridge", () => {
    expect(resolveBridgeBinary("opencode")).toBeNull()
    expect(resolveBridgeBinary("totally-unknown-binary")).toBeNull()
  })

  it("resolveExecutable resolves to something for a bundled bridge even off PATH", () => {
    // `resolveExecutable` prefers PATH, then falls back to the bundled binary,
    // so it is non-null as long as multiclaw's dependency installed correctly.
    expect(resolveExecutable("claude-agent-acp")).not.toBeNull()
    expect(resolveExecutable("codex-acp")).not.toBeNull()
  })
})
