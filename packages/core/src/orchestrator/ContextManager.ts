export class ContextManager {
  private store = new Map<string, string>()
  constructor(initial?: Record<string, string>) {
    if (initial) for (const [k, v] of Object.entries(initial)) this.store.set(k, v)
  }
  set(key: string, value: string) { this.store.set(key, value) }
  get(key: string) { return this.store.get(key) }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.store.entries())
  }
}
