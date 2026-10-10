import { afterEach, describe, expect, it, vi } from "vitest"
import type { MultiClawEvent } from "../types/event"
import { EventBus } from "./EventBus"

const event: MultiClawEvent = {
  type: "stage:complete",
  timestamp: "2026-01-01T00:00:00.000Z",
  payload: { stageIndex: 0 },
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("EventBus", () => {
  it("delivers emitted events to every subscriber", () => {
    const bus = new EventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe(a)
    bus.subscribe(b)

    bus.emit(event)

    expect(a).toHaveBeenCalledWith(event)
    expect(b).toHaveBeenCalledWith(event)
  })

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)

    bus.emit(event)
    unsubscribe()
    bus.emit(event)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("does not deliver to the same listener twice when subscribed twice", () => {
    const bus = new EventBus()
    const listener = vi.fn()
    bus.subscribe(listener)
    bus.subscribe(listener)

    bus.emit(event)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("isolates a throwing listener so others still receive the event", () => {
    const bus = new EventBus()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const boom = vi.fn(() => {
      throw new Error("listener boom")
    })
    const healthy = vi.fn()
    bus.subscribe(boom)
    bus.subscribe(healthy)

    expect(() => bus.emit(event)).not.toThrow()
    expect(healthy).toHaveBeenCalledWith(event)
    expect(errorSpy).toHaveBeenCalled()
  })

  it("removes all listeners on clear", () => {
    const bus = new EventBus()
    const listener = vi.fn()
    bus.subscribe(listener)

    bus.clear()
    bus.emit(event)

    expect(listener).not.toHaveBeenCalled()
  })
})
