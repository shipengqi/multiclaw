import { describe, expect, it } from "vitest"
import { agents } from "."

const ALL = Object.entries(agents)

describe("built-in agents", () => {
  it("exposes every preset through the `agents` namespace", () => {
    expect(ALL).toHaveLength(12)
  })

  // The console's first screen shows each agent's role. It falls back to
  // `description`, so a preset without one renders a blank column — which is
  // exactly how the roster shipped empty.
  it.each(ALL)("%s declares a description", (_name, factory) => {
    expect(factory().description).toBeTruthy()
  })

  // The description sits in a fixed-width column next to the agent's name, so a
  // long one would be truncated to nothing useful.
  it.each(ALL)("%s keeps its description short", (_name, factory) => {
    expect(factory().description?.length).toBeLessThanOrEqual(24)
  })

  // The roster reads `◆ Architect  designs the architecture`, so the blurb has
  // to continue the name rather than start a sentence. Acronyms inside it
  // (`API`, `UI`) are still allowed to be upper case.
  it.each(ALL)("%s phrases its description as a continuation of the name", (_name, factory) => {
    const description = factory().description ?? ""
    expect(description[0]).toBe(description[0]?.toLowerCase())
    expect(description).not.toMatch(/\.$/)
  })

  it.each(ALL)("%s still lets a caller override the description", (_name, factory) => {
    expect(factory({ description: "custom" }).description).toBe("custom")
  })
})
