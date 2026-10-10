import { describe, expect, it } from "vitest"
import {
  availableCommands,
  COMMANDS,
  isCommandLine,
  matchCommands,
  menuQuery,
  parseCommand,
} from "./commands"

describe("availableCommands", () => {
  it("offers cancel only while a turn is running", () => {
    expect(availableCommands(true).map((c) => c.name)).toContain("cancel")
    expect(availableCommands(false).map((c) => c.name)).not.toContain("cancel")
  })

  it("always offers the rest", () => {
    const idle = availableCommands(false).map((c) => c.name)
    for (const name of ["agents", "focus", "clear", "help", "quit"]) {
      expect(idle).toContain(name)
    }
  })
})

describe("matchCommands", () => {
  it("returns everything for an empty query", () => {
    expect(matchCommands("", false)).toHaveLength(availableCommands(false).length)
  })

  it("ranks a name prefix above a description hit", () => {
    // `ag` is a prefix of /agents and also appears inside "an agent" in the
    // description of /focus. The prefix has to win.
    const names = matchCommands("ag", false).map((c) => c.name)
    expect(names[0]).toBe("agents")
    expect(names).toContain("focus")
  })

  it("still finds a command by its description", () => {
    expect(matchCommands("key map", false).map((c) => c.name)).toEqual(["help"])
  })

  it("is case-insensitive", () => {
    expect(matchCommands("AG", false)[0].name).toBe("agents")
  })

  it("returns nothing for a query that matches nothing", () => {
    expect(matchCommands("zzz", false)).toEqual([])
  })

  it("does not surface a running-only command when idle", () => {
    expect(matchCommands("cancel", false)).toEqual([])
  })
})

describe("isCommandLine", () => {
  it("is true only for a leading slash", () => {
    expect(isCommandLine("/agents")).toBe(true)
    expect(isCommandLine(" /agents")).toBe(false)
    expect(isCommandLine("run the tests")).toBe(false)
  })
})

describe("menuQuery", () => {
  it("is the partial name while the name is still being typed", () => {
    expect(menuQuery("/ag")).toBe("ag")
    expect(menuQuery("/")).toBe("")
  })

  it("closes once arguments begin, so the list stops re-filtering", () => {
    expect(menuQuery("/focus arch")).toBeUndefined()
  })

  it("stays closed outside command mode", () => {
    expect(menuQuery("hello")).toBeUndefined()
  })
})

describe("parseCommand", () => {
  it("splits the name from its arguments", () => {
    expect(parseCommand("/focus architect")).toEqual({ name: "focus", args: ["architect"] })
  })

  it("accepts a bare command", () => {
    expect(parseCommand("/agents")).toEqual({ name: "agents", args: [] })
  })

  it("collapses extra whitespace", () => {
    expect(parseCommand("/focus   architect  ")).toEqual({ name: "focus", args: ["architect"] })
  })

  it("has nothing to run for a lone slash", () => {
    expect(parseCommand("/")).toBeUndefined()
    expect(parseCommand("   ")).toBeUndefined()
  })

  it("ignores a plain requirement", () => {
    expect(parseCommand("fix the bug")).toBeUndefined()
  })
})

describe("COMMANDS", () => {
  it("keeps names unique, since they are lookup keys", () => {
    const names = COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("describes every command", () => {
    for (const command of COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0)
    }
  })
})
