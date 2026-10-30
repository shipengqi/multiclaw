import { abortError, isAbortError } from "./abort"

export function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
  options?: { waitForCleanup?: boolean }
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
  let timeoutError: Error | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutError = new Error(`[${label}] timed out (${ms / 1000}s)`)
      controller.abort()
      // Session work settles only after cleanup. Its deadline requests abort,
      // but must not let the caller observe completion before that barrier.
      if (!options?.waitForCleanup) reject(timeoutError)
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

  const work = factory(controller.signal)
  const completion = options?.waitForCleanup
    ? work.then(
        (result) => {
          if (timeoutError) throw timeoutError
          return result
        },
        (error: unknown) => {
          // Cooperative abort acknowledges cleanup; explicit cleanup failures
          // must remain visible rather than being replaced by the timeout error.
          if (timeoutError && isAbortError(error)) throw timeoutError
          throw error
        }
      )
    : work

  return Promise.race([completion, timeout, cancelled]).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forward)
    // `{ once: true }` only detaches the listener when it fires, and on the
    // normal path it never does. The orchestrator hands the *same* signal to
    // every agent, so without this each run would leak a listener until Node
    // warns at 11+ agents.
    if (onCancel) signal?.removeEventListener("abort", onCancel)
  })
}
