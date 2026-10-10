/** Error name used for cooperative cancellation across the orchestrator. */
export const ABORT_ERROR_NAME = "AbortError"

export function abortError(message = "Operation aborted"): Error {
  const err = new Error(message)
  err.name = ABORT_ERROR_NAME
  return err
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === ABORT_ERROR_NAME
}
