import { describe, it, expect } from "vitest"
import { buildStages } from "./StageBuilder"
import { makeAgent } from "../testing/helpers"

describe("buildStages", () => {
  it("puts a single dependency-free agent in one stage", () => {
    const a = makeAgent({ id: "a" })
    expect(buildStages([a])).toEqual([[a]])
  })

  it("puts independent agents into the same stage", () => {
    const a = makeAgent({ id: "a" })
    const b = makeAgent({ id: "b" })
    const stages = buildStages([a, b])
    expect(stages).toHaveLength(1)
    expect(stages[0]).toEqual([a, b])
  })

  it("orders a linear chain into one stage per hop", () => {
    const a = makeAgent({ id: "a" })
    const b = makeAgent({ id: "b", dependsOn: ["a"] })
    const c = makeAgent({ id: "c", dependsOn: ["b"] })
    const stages = buildStages([a, b, c])
    expect(stages).toEqual([[a], [b], [c]])
  })

  it("groups a diamond dependency correctly", () => {
    const a = makeAgent({ id: "a" })
    const b = makeAgent({ id: "b", dependsOn: ["a"] })
    const c = makeAgent({ id: "c", dependsOn: ["a"] })
    const d = makeAgent({ id: "d", dependsOn: ["b", "c"] })
    const stages = buildStages([a, b, c, d])
    expect(stages).toEqual([[a], [b, c], [d]])
  })

  it("preserves the original order of agents within a stage", () => {
    const a = makeAgent({ id: "a" })
    const b = makeAgent({ id: "b" })
    const c = makeAgent({ id: "c", dependsOn: ["a", "b"] })
    // c must wait, but a/b keep their input order
    const stages = buildStages([b, a, c])
    expect(stages[0]).toEqual([b, a])
    expect(stages[1]).toEqual([c])
  })

  it("does not depend on agents being declared before their dependents", () => {
    const dependent = makeAgent({ id: "child", dependsOn: ["parent"] })
    const parent = makeAgent({ id: "parent" })
    const stages = buildStages([dependent, parent])
    expect(stages).toEqual([[parent], [dependent]])
  })

  it("throws when an agent depends on an unknown agent", () => {
    const a = makeAgent({ id: "a", dependsOn: ["ghost"] })
    expect(() => buildStages([a])).toThrowError(
      'Agent "a" depends on "ghost" which does not exist'
    )
  })

  it("throws on a two-node circular dependency", () => {
    const a = makeAgent({ id: "a", dependsOn: ["b"] })
    const b = makeAgent({ id: "b", dependsOn: ["a"] })
    expect(() => buildStages([a, b])).toThrowError(/Circular or unsatisfiable/)
  })

  it("throws on a self-referencing dependency", () => {
    const a = makeAgent({ id: "a", dependsOn: ["a"] })
    expect(() => buildStages([a])).toThrowError(/Circular or unsatisfiable/)
  })

  it("returns no stages for an empty agent list", () => {
    expect(buildStages([])).toEqual([])
  })
})
