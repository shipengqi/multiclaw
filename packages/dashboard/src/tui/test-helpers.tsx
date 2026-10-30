import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { agents, type MultiClawConfig } from "@multiclawcli/core"
import { render } from "ink"
import type { ReactNode } from "react"

/**
 * A workspace of this test process's own.
 *
 * The console persists turns, and now the turn in flight, under `workDir`. A
 * fixed path like `/tmp/dev-team` is shared state across parallel test files,
 * so a test that leaves a run half-finished hands the next one an interrupted
 * turn — and an idle-screen test sees a history it never created.
 */
function testWorkDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `multiclaw-${name}-`))
}

/** A three-agent team, shaped like `examples/dev-team`. */
export const DEMO: MultiClawConfig = {
  name: "dev-team",
  workDir: testWorkDir("demo"),
  leader: {
    id: "leader",
    name: "Leader",
    icon: "◆",
    taskTitle: "plans the pipeline",
    systemPrompt: "",
    taskPrompt: "",
  },
  agents: [
    {
      id: "architect",
      name: "Architect",
      icon: "◇",
      model: "sonnet-4",
      taskTitle: "designs the solution",
      systemPrompt: "",
      taskPrompt: "",
    },
    {
      id: "dev",
      name: "Developer",
      icon: "◇",
      model: "sonnet-4",
      taskTitle: "writes the code",
      systemPrompt: "",
      taskPrompt: "",
    },
  ],
}

/**
 * A team built from the built-in presets, exactly as `examples/dev-team` does.
 *
 * {@link DEMO} hand-sets `taskTitle` on every agent, which is what hid the bug
 * this exists to catch: the presets declare no task title, so a roster that
 * read only `taskTitle` rendered a blank column for every row.
 */
export const PRESET: MultiClawConfig = {
  name: "Dev Team Demo",
  workDir: testWorkDir("preset"),
  leader: agents.leader({ model: "haiku" }),
  agents: [
    agents.architect({ model: "haiku" }),
    agents.backendDeveloper({ model: "haiku", dependsOn: ["architect"] }),
    agents.tester({ model: "haiku", dependsOn: ["backend-developer"] }),
    agents.codeReviewer({ model: "haiku", dependsOn: ["tester"] }),
  ],
}

interface FakeStdout {
  columns: number
  rows: number
  isTTY: boolean
  output: string
  write(chunk: unknown, callback?: () => void): boolean
  on(): FakeStdout
  off(): FakeStdout
  removeListener(): FakeStdout
}

/**
 * A stdin that Ink accepts as interactive.
 *
 * `useInput` refuses to mount without raw-mode support, so a bare PassThrough is
 * not enough — it has to claim to be a TTY and expose `setRawMode`.
 */
function fakeStdin(): PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void } {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
  }
  stream.isTTY = true
  stream.setRawMode = () => {}
  return stream
}

/**
 * Render one frame of an Ink tree and return everything it wrote.
 *
 * Two details matter here. The stream must invoke the write callback — Ink waits
 * on a flush that never lands otherwise, and the test hangs rather than fails.
 * And in non-interactive mode Ink emits only the final frame, so the tree has to
 * be unmounted before there is anything to read.
 */
export async function renderFrame(node: ReactNode, columns = 100, rows = 30): Promise<string> {
  const stdout: FakeStdout = {
    columns,
    rows,
    isTTY: true,
    output: "",
    write(chunk, callback) {
      stdout.output += String(chunk)
      callback?.()
      return true
    },
    on() {
      return stdout
    },
    off() {
      return stdout
    },
    removeListener() {
      return stdout
    },
  }

  const app = render(node, {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stdin: fakeStdin(),
    interactive: false,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await app.waitUntilRenderFlush()
  app.unmount()
  await app.waitUntilExit()
  return stdout.output
}

/**
 * Render a tree, feed it keystrokes, then unmount and return the last frame.
 *
 * Keystrokes have to arrive as separate chunks. Ink treats one multi-character
 * chunk as a paste and collapses its newlines to spaces, so `"text\r"` types a
 * literal space instead of submitting — the carriage return must be its own
 * write.
 *
 * Waiting is done through `ready`, not by polling the output: in
 * non-interactive mode Ink buffers and writes the frame only on unmount, so
 * there is nothing to poll. Callers pass a promise resolved from the app's own
 * event bus, which makes the wait deterministic rather than timed.
 */
export async function driveFrame(
  node: ReactNode,
  options: {
    keys?: string[]
    columns?: number
    rows?: number
    /** Resolved by the app under test when it has reached the state of interest. */
    ready?: Promise<unknown>
    /** Keys typed *after* `ready` resolves, for flows that need a finished state. */
    thenKeys?: string[]
    /**
     * Resolved by the app under test after `thenKeys` have been typed.
     *
     * Without this, a flow whose second step is only legal once a turn has
     * finished has to guess how long that turn takes — and a guess that fits an
     * idle machine fails on a busy one.
     */
    thenReady?: Promise<unknown>
    /** Extra time for React to paint after `ready` resolves. */
    settleMs?: number
    timeoutMs?: number
  } = {}
): Promise<string> {
  const {
    keys = [],
    columns = 100,
    rows = 30,
    ready,
    thenKeys = [],
    thenReady,
    settleMs = 120,
    timeoutMs = 5000,
  } = options
  const stdout: FakeStdout = {
    columns,
    rows,
    isTTY: true,
    output: "",
    write(chunk, callback) {
      stdout.output += String(chunk)
      callback?.()
      return true
    },
    on() {
      return stdout
    },
    off() {
      return stdout
    },
    removeListener() {
      return stdout
    },
  }
  const stdin = fakeStdin()

  const app = render(node, {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stdin: stdin as unknown as NodeJS.ReadableStream,
    interactive: false,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  await app.waitUntilRenderFlush()

  for (const chunk of keys) {
    stdin.write(chunk)
    // Let the reducer settle between chunks, otherwise a fast `"text"` + `"\r"`
    // pair can be coalesced into one paste again.
    await new Promise((resolve) => setTimeout(resolve, 30))
  }

  if (ready) {
    // Never let a missing event hang the suite — fall through and let the
    // assertions describe what actually rendered.
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  }

  for (const chunk of thenKeys) {
    stdin.write(chunk)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }

  if (thenReady) {
    await Promise.race([thenReady, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  }

  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs))

  app.unmount()
  await app.waitUntilExit()
  return stdout.output
}
