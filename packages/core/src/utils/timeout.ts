export function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`[${label}] timed out (${ms / 1000}s)`))
    }, ms)
  })
  return Promise.race([factory(controller.signal), timeout]).finally(() => clearTimeout(timer))
}

