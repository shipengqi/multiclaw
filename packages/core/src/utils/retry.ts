import { abortError } from "./abort"

/**
 * Default backoff unit for {@link withRetry}.
 *
 * Exported so a caller that must budget for a whole retry sequence — see
 * {@link retryBudgetMs} — sleeps the same amount the loop actually sleeps. A
 * second literal `2000` elsewhere would silently drift from this one.
 */
export const DEFAULT_RETRY_DELAY_MS = 2000

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
  delayMs = DEFAULT_RETRY_DELAY_MS,
  signal?: AbortSignal,
  shouldRetry?: (error: unknown, attempt: number) => boolean
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
      // A permanent failure cannot be improved by another attempt, so rethrow it
      // at once: no `onRetry` notification and no backoff sleep. Omitting the
      // predicate keeps the original "retry everything" behaviour, so the
      // parameter is purely additive.
      if (shouldRetry && !shouldRetry(err, attempt)) throw lastError
      if (attempt <= retries) {
        onRetry?.(attempt, err)
        await sleep(delayMs * attempt, signal)
      }
    }
  }
  throw lastError
}

/**
 * Wall-clock upper bound for one full retry sequence.
 *
 * `withRetry` allows `retries + 1` attempts and sleeps `delayMs * attempt`
 * between them (`attempt` runs 1..retries), so the worst case is every attempt
 * spending its whole per-attempt budget plus the sum of the backoffs.
 *
 * `perAttemptMs` is the *worst-case wall-clock time of one attempt*, not the
 * nominal timeout the runtime is handed: an attempt can overrun its own timeout
 * by whatever cleanup grace the runtime needs after the deadline (for ACP, the
 * SIGTERM→SIGKILL grace — `KILL_ESCALATION_MS`). A caller that passes the bare
 * timeout gets an "upper bound" that is not one, and the outer timer then races
 * — and can beat — the final attempt.
 *
 * Kept beside the loop above on purpose: the loop is the only definition of this
 * arithmetic, and the two would drift apart if they lived in separate files.
 */
export function retryBudgetMs(
  perAttemptMs: number,
  retries: number,
  delayMs = DEFAULT_RETRY_DELAY_MS
): number {
  return perAttemptMs * (retries + 1) + (delayMs * retries * (retries + 1)) / 2
}
