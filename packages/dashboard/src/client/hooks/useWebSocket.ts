import { useEffect, useRef } from "react"
import type { MultiClawEvent } from "@multiclawcli/core"

export function useWebSocket(onEvent: (e: MultiClawEvent) => void): void {
  const ref = useRef(onEvent)
  ref.current = onEvent
  // Stop reconnecting after orchestration completes to avoid errors when server has shut down
  const doneRef = useRef(false)

  useEffect(() => {
    const wsUrl = `ws://${location.host}`
    let ws: WebSocket
    let retry: ReturnType<typeof setTimeout>

    const connect = () => {
      if (doneRef.current) return
      ws = new WebSocket(wsUrl)
      ws.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as MultiClawEvent
          if (event.type === "orchestration:complete") doneRef.current = true
          ref.current(event)
        } catch {}
      }
      ws.onclose = () => {
        if (!doneRef.current) retry = setTimeout(connect, 1500)
      }
    }
    connect()

    return () => { clearTimeout(retry); ws?.close() }
  }, [])
}
