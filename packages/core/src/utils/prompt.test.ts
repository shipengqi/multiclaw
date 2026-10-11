import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { renderPrompt } from "./prompt"

let workDir: string

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-test-"))
})

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

describe("renderPrompt", () => {
  it("substitutes context values into the template", async () => {
    const out = await renderPrompt("Hello {{name}}!", { name: "World" }, workDir)
    expect(out).toBe("Hello World!")
  })

  it("replaces every occurrence of a placeholder", async () => {
    const out = await renderPrompt("{{x}} and {{x}}", { x: "y" }, workDir)
    expect(out).toBe("y and y")
  })

  it("leaves unknown placeholders untouched", async () => {
    const out = await renderPrompt("Hi {{missing}}", { name: "a" }, workDir)
    expect(out).toBe("Hi {{missing}}")
  })

  it("injects file contents referenced with {{file:...}}", async () => {
    await fs.writeFile(path.join(workDir, "spec.md"), "# Spec\nbody")
    const out = await renderPrompt("Read:\n{{file:spec.md}}", {}, workDir)
    expect(out).toBe("Read:\n# Spec\nbody")
  })

  it("resolves injected files relative to the work directory", async () => {
    await fs.mkdir(path.join(workDir, "nested"), { recursive: true })
    await fs.writeFile(path.join(workDir, "nested", "a.txt"), "deep")
    const out = await renderPrompt("{{file: nested/a.txt }}", {}, workDir)
    expect(out).toBe("deep")
  })

  it("substitutes a marker when the referenced file is missing", async () => {
    const out = await renderPrompt("{{file:ghost.txt}}", {}, workDir)
    expect(out).toBe("[file not found: ghost.txt]")
  })

  it("handles files and context placeholders in the same template", async () => {
    await fs.writeFile(path.join(workDir, "ctx.txt"), "FILE")
    const out = await renderPrompt("{{file:ctx.txt}} + {{extra}}", { extra: "CTX" }, workDir)
    expect(out).toBe("FILE + CTX")
  })

  // Regression: `String.replace` with a *string* replacement interprets `$&`,
  // `$'`, `` $` `` and `$$` in the substituted text. `$$` is the shell PID, so
  // inlining a shell script silently collapsed it to a single `$`.
  it("does not interpret $ replacement patterns in injected file contents", async () => {
    const script = "echo $$ > /tmp/pid\ncp $1 $2\nawk '{print $&}'\n"
    await fs.writeFile(path.join(workDir, "deploy.sh"), script)
    const out = await renderPrompt("{{file:deploy.sh}}", {}, workDir)
    expect(out).toBe(script)
  })

  it("does not interpret $ replacement patterns in context values", async () => {
    const out = await renderPrompt("{{cmd}}", { cmd: "echo $$ and $& and $1" }, workDir)
    expect(out).toBe("echo $$ and $& and $1")
  })

  it("refuses to inline a file outside the work directory", async () => {
    const out = await renderPrompt("{{file:../escape.txt}}", {}, workDir)
    expect(out).toBe("[file outside workspace: ../escape.txt]")
  })
})
