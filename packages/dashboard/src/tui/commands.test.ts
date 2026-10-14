import { describe, expect, it } from "vitest"
import {
  argQuery,
  availableCommands,
  COMMANDS,
  completeAgents,
  isCommandLine,
  matchCommands,
  menuQuery,
  paletteRows,
  parseCommand,
  resolveAgentId,
} from "./commands"

describe("availableCommands", () => {
  it("offers cancel only while a turn is running", () => {
    expect(availableCommands(true).map((c) => c.name)).toContain("cancel")
    expect(availableCommands(false).map((c) => c.name)).not.toContain("cancel")
  })

  it("always offers the rest", () => {
    const idle = availableCommands(false).map((c) => c.name)
    for (const name of ["agents", "focus", "clear", "help", "quit", "verbose"]) {
      expect(idle).toContain(name)
    }
  })

  it("offers /retry while idle but not while a turn is running", () => {
    // Retrying re-runs agents from the last finished turn, so there is nothing
    // to retry mid-run — and offering it there would race the live turn.
    expect(availableCommands(false).map((c) => c.name)).toContain("retry")
    expect(availableCommands(true).map((c) => c.name)).not.toContain("retry")
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

  it("finds /verbose by name", () => {
    expect(matchCommands("verb", false)[0].name).toBe("verbose")
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

  it("offers /replay while idle but not while running", () => {
    // Replaying re-runs a finished turn, so mid-run it would race the live turn
    // (and `startTurn` would drop the running controller).
    expect(availableCommands(false).map((c) => c.name)).toContain("replay")
    expect(availableCommands(true).map((c) => c.name)).not.toContain("replay")
  })

  it("offers /fork in both phases, since it only edits the prompt", () => {
    expect(availableCommands(false).map((c) => c.name)).toContain("fork")
    expect(availableCommands(true).map((c) => c.name)).toContain("fork")
  })
})

describe("paletteRows", () => {
  it("labels every row with a leading slash", () => {
    for (const row of paletteRows(COMMANDS)) {
      expect(row.label.startsWith("/")).toBe(true)
    }
  })

  it("includes the argument hint when a command takes one", () => {
    expect(paletteRows(COMMANDS).find((row) => row.key === "focus")?.label).toBe("/focus <id>")
  })

  it("keeps each command's description", () => {
    expect(paletteRows(COMMANDS).find((row) => row.key === "agents")?.description).toBe(
      "List the configured team"
    )
  })
})

describe("argQuery", () => {
  it("opens on the first argument of a completer command", () => {
    expect(argQuery("/focus ")).toEqual({
      command: COMMANDS.find((c) => c.name === "focus"),
      partial: "",
    })
  })

  it("carries the partial argument typed so far", () => {
    expect(argQuery("/focus ar")?.partial).toBe("ar")
  })

  it("stays closed before the space that begins the argument", () => {
    expect(argQuery("/focus")).toBeUndefined()
  })

  it("stays closed for a command that takes no completer", () => {
    expect(argQuery("/agents x")).toBeUndefined()
  })

  it("stays closed outside command mode", () => {
    expect(argQuery("plain")).toBeUndefined()
  })
})

describe("completeAgents", () => {
  const ids = ["architect", "dev", "archivist", "qa"]

  it("matches a prefix", () => {
    expect(completeAgents("ar", ids)).toEqual(["architect", "archivist"])
  })

  it("matches case-insensitively", () => {
    expect(completeAgents("AR", ids)).toEqual(["architect", "archivist"])
  })

  it("lists the roster when nothing has been typed", () => {
    expect(completeAgents("", ids)).toEqual(ids)
  })

  it("caps the list at the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => `agent-${i}`)
    expect(completeAgents("", many)).toHaveLength(8)
  })
})

describe("resolveAgentId", () => {
  it("prefers an exact id over a prefix", () => {
    // `dev` is itself an id, so it must resolve to `dev` even though it is also
    // a prefix of `developer`.
    expect(resolveAgentId("dev", ["dev", "developer"])).toEqual({ id: "dev" })
  })

  it("resolves a unique prefix", () => {
    expect(resolveAgentId("arch", ["architect", "dev"])).toEqual({ id: "architect" })
  })

  it("reports every candidate for an ambiguous prefix", () => {
    expect(resolveAgentId("d", ["dev", "designer"])).toEqual({
      error: "ambiguous: dev, designer",
    })
  })

  it("reports an unknown id", () => {
    expect(resolveAgentId("nope", ["dev"])).toEqual({ error: "unknown agent: nope" })
  })
})
