import { describe, expect, it } from "vitest"
import { agents } from "../agents"
import { makeAgent } from "../testing/helpers"
import type { ToolName } from "../types/agent"
import { hasExplicitTools } from "./toolsPolicy"

const factories = Object.entries(agents)

describe("tools provenance", () => {
  it.each(factories)(
    "tracks unchanged implicit defaults for %s without changing arrays",
    (_name, factory) => {
      const agent = factory()
      expect(hasExplicitTools(agent)).toBe(false)
      expect(hasExplicitTools({ ...agent })).toBe(false)
      const symbol = Symbol.for("multiclaw.toolsProvenance")
      const descriptor = Object.getOwnPropertyDescriptor(agent, symbol)
      expect(descriptor?.enumerable).toBe(true)
      expect(descriptor?.value.reference).toBe(agent.tools)
      expect(Object.isFrozen(descriptor?.value.snapshot)).toBe(true)
      expect(Object.isFrozen(agent.tools)).toBe(false)
    }
  )

  it.each(factories)(
    "tracks explicit tools for %s and preserves caller arrays",
    (_name, factory) => {
      const tools: ToolName[] = ["Read"]
      const agent = factory({ tools })
      expect(agent.tools).toBe(tools)
      expect(hasExplicitTools(agent)).toBe(true)
      expect(hasExplicitTools({ ...agent })).toBe(true)
      expect(hasExplicitTools(factory({ tools: [] }))).toBe(true)
      expect(hasExplicitTools(factory({ tools: undefined }))).toBe(false)
    }
  )

  it("classifies custom tools including empty arrays as explicit", () => {
    expect(hasExplicitTools(makeAgent({ id: "custom" }))).toBe(false)
    expect(hasExplicitTools(makeAgent({ id: "custom", tools: [] }))).toBe(true)
    expect(hasExplicitTools(makeAgent({ id: "custom", tools: ["Read"] }))).toBe(true)
  })

  it("detects same-length mutations against the immutable snapshot", () => {
    const agent = agents.backendDeveloper()
    if (agent.tools) agent.tools[0] = "Edit"
    expect(hasExplicitTools(agent)).toBe(true)
  })

  it("cannot observe an override that retains the identical default reference", () => {
    const agent = agents.backendDeveloper()
    expect(hasExplicitTools({ ...agent, tools: agent.tools })).toBe(false)
  })
})
