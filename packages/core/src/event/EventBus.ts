import type { MultiClawEvent, EventListener } from "../types/event"

export class EventBus {
  private listeners = new Set<EventListener>()

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: MultiClawEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) }
      catch (err) { console.error("EventBus listener error:", err) }
    }
  }

  clear(): void { this.listeners.clear() }
}
