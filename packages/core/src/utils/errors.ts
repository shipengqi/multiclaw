/**
 * An error that will not be fixed by trying again.
 *
 * `withRetry` retries any error that is not an abort, which is the right default
 * — a flaky connection, a transient non-zero exit, a slow turn are all worth a
 * second attempt. But some failures are permanent properties of the setup: a
 * binary that is not installed (ENOENT), one that is not executable (EACCES), or
 * a capability the agent does not advertise (no `session/load`). Retrying those
 * only stretches a doomed run by the whole backoff budget, so the sites that can
 * detect them throw a `PermanentError` and the retry loop fails fast.
 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message)
    // Named so a log line or an `AgentResult.error` still reads as a deliberate
    // classification rather than an anonymous crash.
    this.name = "PermanentError"
  }
}

/** True when `err` was classified as non-retryable. */
export function isPermanent(err: unknown): boolean {
  return err instanceof PermanentError
}
