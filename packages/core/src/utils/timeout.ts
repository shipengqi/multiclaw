import { abortError } from "./abort"

export function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  // Never start work that has already been cancelled — otherwise the runtime
  // spawns a process only to kill it immediately.
  if (signal?.aborted) return Promise.reject(abortError())

  const controller = new AbortController()

  // The caller's signal (e.g. the user cancelling a run from the TUI) must also
  // abort the work, not just the internal timeout.
  const forward = () => controller.abort()
  signal?.addEventListener("abort", forward, { once: true })

  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`[${label}] timed out (${ms / 1000}s)`))
    }, ms)
  })

  // Rejects as soon as the caller aborts, so an in-flight runtime cannot keep
  // the orchestrator hanging after cancellation.
  const cancelled = new Promise<never>((_, reject) => {
    if (!signal) return
    signal.addEventListener("abort", () => reject(abortError()), { once: true })
  })

  return Promise.race([factory(controller.signal), timeout, cancelled]).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forward)
  })
}
