import { EventEmitter } from "node:events"
import type { MultiClawEvent } from "@multiclawcli/core"
import { describe, expect, it, vi } from "vitest"
import type { WebSocketServer } from "ws"
import { WebSocketHub } from "./WebSocketHub"

class FakeWss extends EventEmitter {}

interface FakeSocket {
  readyState: number
  OPEN: number
  send: ReturnType<typeof vi.fn>
  handlers: Record<string, (arg?: unknown) => void>
  on: (event: string, fn: (arg?: unknown) => void) => void
}

function fakeSocket(readyState = 1): FakeSocket {
  const socket: FakeSocket = {
    readyState,
    OPEN: 1,
    send: vi.fn(),
    handlers: {},
    on(event, fn) {
      socket.handlers[event] = fn
    },
  }
  return socket
}

function makeHub(acceptClientEvents = false) {
  const wss = new FakeWss()
  const hub = new WebSocketHub(wss as unknown as WebSocketServer, acceptClientEvents)
  return { wss, hub }
}

const event = (type: string, payload: Record<string, unknown> = {}) =>
  ({ type, timestamp: "t", payload }) as unknown as MultiClawEvent

describe("WebSocketHub", () => {
  it("sends buffered history to a newly connected client", () => {
    const { wss, hub } = makeHub()
    hub.broadcast(event("agent:start", { agentId: "a" }))

    const socket = fakeSocket()
    wss.emit("connection", socket)

    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ type: "agent:start" })
  })

  it("broadcasts to all connected clients and records history", () => {
    const { wss, hub } = makeHub()
    const a = fakeSocket()
    const b = fakeSocket()
    wss.emit("connection", a)
    wss.emit("connection", b)

    hub.broadcast(event("agent:complete"))

    expect(a.send).toHaveBeenCalledTimes(1)
    expect(b.send).toHaveBeenCalledTimes(1)
  })

  it("skips clients that are not in the OPEN state", () => {
    const { wss, hub } = makeHub()
    const closed = fakeSocket(3)
    wss.emit("connection", closed)

    hub.broadcast(event("agent:complete"))

    expect(closed.send).not.toHaveBeenCalled()
  })

  it("stops sending to a client after it closes", () => {
    const { wss, hub } = makeHub()
    const socket = fakeSocket()
    wss.emit("connection", socket)
    socket.handlers.close?.()

    hub.broadcast(event("agent:complete"))

    expect(socket.send).not.toHaveBeenCalled()
  })

  it("ignores client messages when acceptClientEvents is false", () => {
    const { wss } = makeHub(false)
    const socket = fakeSocket()
    wss.emit("connection", socket)
    expect(socket.handlers.message).toBeUndefined()
  })

  it("re-broadcasts valid client events when acceptClientEvents is true", () => {
    const { wss } = makeHub(true)
    const sender = fakeSocket()
    const other = fakeSocket()
    wss.emit("connection", sender)
    wss.emit("connection", other)
    sender.send.mockClear()
    other.send.mockClear()

    const incoming = event("agent:output", { agentId: "a", chunk: "x" })
    sender.handlers.message?.({ toString: () => JSON.stringify(incoming) })

    expect(other.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(other.send.mock.calls[0][0])).toMatchObject({ type: "agent:output" })
  })

  it("ignores malformed client messages", () => {
    const { wss } = makeHub(true)
    const sender = fakeSocket()
    const other = fakeSocket()
    wss.emit("connection", sender)
    wss.emit("connection", other)
    other.send.mockClear()

    sender.handlers.message?.({ toString: () => "not json{{" })

    expect(other.send).not.toHaveBeenCalled()
  })
})
