export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  retries: number,
  onRetry?: (failedAttempt: number, error: unknown) => void,
  delayMs = 2000
): Promise<T> {
  let lastError: Error = new Error("Unknown error")
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try { return await fn(attempt) }
    catch (err) {
      lastError = err as Error
      if (attempt <= retries) {
        onRetry?.(attempt, err)
        await sleep(delayMs * attempt)
      }
    }
  }
  throw lastError
}

