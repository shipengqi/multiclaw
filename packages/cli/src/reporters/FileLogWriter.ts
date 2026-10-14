import * as fs from "node:fs"
import * as path from "node:path"
import type { EventBus, MultiClawEvent } from "@multiclawcli/core"

/**
 * Streams each agent's output to its own log file, plus a `report.json` per turn.
 *
 * Logging is diagnostics, so nothing in here is allowed to take the run down: a
 * failed log write is reported and then ignored.
 */
export class FileLogWriter {
  private streams = new Map<string, fs.WriteStream>()
  /** Agent ids whose log could not be opened — never retried, so a broken
   *  directory does not produce one failing stream per output chunk. */
  private failed = new Set<string>()
  private closing: Promise<void> | undefined

  constructor(
    private logDir: string,
    private onError: (message: string) => void = (message) =>
      process.stderr.write(`\n[multiclaw] ${message}\n`)
  ) {
    fs.mkdirSync(logDir, { recursive: true })
  }

  attach(eventBus: EventBus): () => void {
    return eventBus.subscribe((e) => this.handle(e))
  }

  /**
   * Flush every open stream.
   *
   * `stream.end()` only *starts* the flush, so a caller that exits the moment
   * `orchestration:complete` arrives can lose the tail of the last agent's log.
   * Awaiting this is what makes that tail durable.
   */
  async drain(): Promise<void> {
    if (!this.closing) this.closing = this.flush()
    await this.closing
  }

  private handle(e: MultiClawEvent): void {
    if (e.type === "agent:output") {
      // Log files carry the agent's prose, exactly as they did before `kind`
      // existed. Tool activity is a live-view affordance, not a transcript, and
      // writing it here would change every existing log file's contents.
      const { agentId, chunk, kind } = e.payload
      if (kind && kind !== "text") return
      this.getStream(agentId)?.write(chunk)
    }
    if (e.type === "orchestration:complete") {
      try {
        fs.writeFileSync(path.join(this.logDir, "report.json"), JSON.stringify(e.payload, null, 2))
      } catch (err) {
        this.onError(`Could not write report.json: ${errorMessage(err)}`)
      }
      this.closing ??= this.flush()
    }
  }

  private getStream(agentId: string): fs.WriteStream | undefined {
    if (this.failed.has(agentId)) return undefined

    let stream = this.streams.get(agentId)
    if (!stream) {
      stream = fs.createWriteStream(path.join(this.logDir, `${agentId}.log`))
      // A write stream reports failures asynchronously, and `EventBus.emit` only
      // wraps the synchronous listener call — so without this handler an ENOSPC,
      // or the log directory being removed mid-run, arrives as an unhandled
      // 'error' event and kills the process.
      stream.on("error", (err) => {
        this.failed.add(agentId)
        this.streams.delete(agentId)
        this.onError(`Could not write ${agentId}.log: ${errorMessage(err)}`)
      })
      this.streams.set(agentId, stream)
    }
    return stream
  }

  private flush(): Promise<void> {
    const streams = [...this.streams.values()]
    this.streams.clear()
    return Promise.all(
      streams.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (s.destroyed || s.writableEnded) {
              resolve()
              return
            }
            s.end(() => resolve())
          })
      )
    ).then(() => undefined)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
