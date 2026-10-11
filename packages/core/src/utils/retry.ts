import { abortError } from "./abort"

/**
 * Sleep, interrupted by cancellation.
 *
 * Without the signal, cancelling during backoff leaves the timer running for the
 * rest of the delay. The retry loop already refuses to invoke `fn` again, so the
 * work is safe — but the continuation lingers for up to `ms`, keeping a turn
 * alive after the user asked it to stop.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  retries: number,
  onRetry?: (failedAttempt: number, error: unknown) => void,
  delayMs = 2000,
  signal?: AbortSignal
): Promise<T> {
  let lastError: Error = new Error("Unknown error")
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    // Cancellation is not a failure: never retry (and never respawn the agent)
    // once the caller has aborted.
    if (signal?.aborted) throw abortError()
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err as Error
      if (signal?.aborted) throw lastError
      if (attempt <= retries) {
        onRetry?.(attempt, err)
        await sleep(delayMs * attempt, signal)
      }
    }
  }
  throw lastError
}
