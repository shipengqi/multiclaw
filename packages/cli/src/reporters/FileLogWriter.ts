import * as fs from "node:fs"
import * as path from "node:path"
import type { EventBus, MultiClawEvent } from "@multiclawcli/core"

export class FileLogWriter {
  private streams = new Map<string, fs.WriteStream>()

  constructor(private logDir: string) {
    fs.mkdirSync(logDir, { recursive: true })
  }

  attach(eventBus: EventBus): () => void {
    return eventBus.subscribe((e) => this.handle(e))
  }

  private handle(e: MultiClawEvent): void {
    if (e.type === "agent:output") {
      this.getStream(e.payload.agentId).write(e.payload.chunk)
    }
    if (e.type === "orchestration:complete") {
      fs.writeFileSync(path.join(this.logDir, "report.json"), JSON.stringify(e.payload, null, 2))
      this.closeAll()
    }
  }

  private getStream(agentId: string): fs.WriteStream {
    let stream = this.streams.get(agentId)
    if (!stream) {
      stream = fs.createWriteStream(path.join(this.logDir, `${agentId}.log`))
      this.streams.set(agentId, stream)
    }
    return stream
  }

  private closeAll(): void {
    for (const s of this.streams.values()) s.end()
    this.streams.clear()
  }
}
