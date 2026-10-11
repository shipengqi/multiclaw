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
  let onCancel: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    if (!signal) return
    onCancel = () => reject(abortError())
    signal.addEventListener("abort", onCancel, { once: true })
  })

  return Promise.race([factory(controller.signal), timeout, cancelled]).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forward)
    // `{ once: true }` only detaches the listener when it fires, and on the
    // normal path it never does. The orchestrator hands the *same* signal to
    // every agent, so without this each run would leak a listener until Node
    // warns at 11+ agents.
    if (onCancel) signal?.removeEventListener("abort", onCancel)
  })
}
