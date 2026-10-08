import { WebSocketServer, WebSocket } from "ws"
import type { MultiClawEvent } from "@multiclaw/core"

export class WebSocketHub {
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private history: MultiClawEvent[] = []

  constructor(wss: WebSocketServer, acceptClientEvents = false) {
    this.wss = wss
    this.wss.on("connection", (ws) => {
      this.clients.add(ws)
      for (const e of this.history) ws.send(JSON.stringify(e))

      if (acceptClientEvents) {
        ws.on("message", (data) => {
          try {
            const event = JSON.parse(data.toString()) as MultiClawEvent
            this.broadcast(event)
          } catch { /* ignore */ }
        })
      }

      ws.on("close", () => this.clients.delete(ws))
    })
  }

  broadcast(event: MultiClawEvent): void {
    this.history.push(event)
    const msg = JSON.stringify(event)
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }
}
