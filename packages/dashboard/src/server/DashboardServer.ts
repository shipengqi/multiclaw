import * as http from "http"
import * as path from "path"
import * as fs from "fs"
import { WebSocketServer } from "ws"
import type { EventBus } from "@multiclaw/core"
import { WebSocketHub } from "./WebSocketHub"

export interface DashboardServerOptions {
  port: number
  acceptClientEvents?: boolean
}

export class DashboardServer {
  private server: http.Server
  private hub: WebSocketHub
  private port: number

  constructor(options: DashboardServerOptions) {
    this.port = options.port

    const clientDist = path.resolve(new URL(import.meta.url).pathname, "../../client")

    this.server = http.createServer((req, res) => {
      let filePath = path.join(
        clientDist,
        req.url === "/" ? "index.html" : req.url!
      )
      if (!fs.existsSync(filePath)) filePath = path.join(clientDist, "index.html")

      const ext = path.extname(filePath)
      const mime: Record<string, string> = {
        ".html": "text/html", ".js": "text/javascript",
        ".css": "text/css", ".svg": "image/svg+xml",
      }
      const stream = fs.createReadStream(filePath)
      stream.on("error", () => { res.writeHead(404); res.end() })
      res.writeHead(200, { "Content-Type": mime[ext] ?? "text/plain" })
      stream.pipe(res)
    })

    const wss = new WebSocketServer({ server: this.server })
    this.hub = new WebSocketHub(wss, options.acceptClientEvents)
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, () => resolve()))
  }

  bindEventBus(eventBus: EventBus): void {
    eventBus.subscribe((e) => this.hub.broadcast(e))
  }

  stop(): void {
    this.server.close()
  }
}
