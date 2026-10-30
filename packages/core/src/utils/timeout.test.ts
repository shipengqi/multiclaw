import { afterEach, describe, expect, it, vi } from "vitest"
import { withTimeout } from "./timeout"

afterEach(() => {
  vi.useRealTimers()
})

describe("withTimeout", () => {
  it("resolves with the factory result when it finishes in time", async () => {
    const result = await withTimeout(async () => "done", 1000, "Fast")
    expect(result).toBe("done")
  })

  it("passes an AbortSignal to the factory", async () => {
    let received: AbortSignal | undefined
    await withTimeout(
      async (signal) => {
        received = signal
        return "ok"
      },
      1000,
      "Signal"
    )
    expect(received).toBeInstanceOf(AbortSignal)
    expect(received!.aborted).toBe(false)
  })

  it("propagates a factory rejection", async () => {
    const err = new Error("factory failed")
    await expect(
      withTimeout(
        async () => {
          throw err
        },
        1000,
        "Boom"
      )
    ).rejects.toBe(err)
  })

  it("rejects with a labelled timeout error and aborts the signal", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined

    const promise = withTimeout(
      (s) => {
        signal = s
        return new Promise<never>(() => {
          /* never resolves */
        })
      },
      500,
      "SlowAgent"
    )
    const assertion = expect(promise).rejects.toThrow("[SlowAgent] timed out (0.5s)")

    await vi.advanceTimersByTimeAsync(500)
    await assertion
    expect(signal!.aborted).toBe(true)
  })

  it.each(["resolve", "abort", "cleanup failure"])(
    "waits for factory cleanup after a timeout before reporting %s",
    async (outcome) => {
      vi.useFakeTimers()
      let signal: AbortSignal | undefined
      let release!: () => void
      const cleanupError = new Error("process cleanup failed")
      let settled = false
      const promise = withTimeout(
        async (innerSignal) => {
          signal = innerSignal
          await new Promise<void>((resolve) => {
            release = resolve
          })
          if (outcome === "cleanup failure") throw cleanupError
          if (outcome === "abort") {
            throw Object.assign(new Error("aborted after cleanup"), { name: "AbortError" })
          }
          return "late success"
        },
        500,
        "Cleanup",
        undefined,
        { waitForCleanup: true }
      ).then(
        (value) => {
          settled = true
          return value
        },
        (error: Error) => {
          settled = true
          return error
        }
      )

      await vi.advanceTimersByTimeAsync(500)
      expect(signal?.aborted).toBe(true)
      expect(settled).toBe(false)
      release()
      const error = await promise
      if (outcome === "cleanup failure") expect(error).toBe(cleanupError)
      else expect(error).toEqual(new Error("[Cleanup] timed out (0.5s)"))
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it("does not fire the timeout after a fast success", async () => {
    vi.useFakeTimers()
    const promise = withTimeout(async () => "quick", 10_000, "Quick")
    await expect(promise).resolves.toBe("quick")
    // The timer must be cleared, otherwise it would keep the process alive.
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects without starting work when the caller signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const factory = vi.fn(async () => "never")

    const error = await withTimeout(factory, 1000, "Cancelled", controller.signal).then(
      () => undefined,
      (err: Error) => err
    )

    expect(error?.name).toBe("AbortError")
    expect(factory).not.toHaveBeenCalled()
  })

  it("rejects and aborts the factory signal when the caller cancels mid-flight", async () => {
    const controller = new AbortController()
    let inner: AbortSignal | undefined

    const promise = withTimeout(
      (signal) => {
        inner = signal
        return new Promise<never>(() => {
          /* never resolves */
        })
      },
      10_000,
      "Cancelled",
      controller.signal
    )

    controller.abort()
    const error = await promise.then(
      () => undefined,
      (err: Error) => err
    )
    expect(error?.name).toBe("AbortError")
    expect(inner?.aborted).toBe(true)
  })

  // Regression: the `cancelled` listener was registered with `{ once: true }`,
  // which only detaches it when it fires. On the normal path it never does, so
  // every agent leaked one listener onto the shared run signal.
  it("leaves no abort listener behind on the caller's signal", async () => {
    const { getEventListeners } = await import("node:events")
    const controller = new AbortController()

    await withTimeout(async () => "done", 1000, "Leak", controller.signal)

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })

  it("leaves no abort listener behind after the caller cancels", async () => {
    const { getEventListeners } = await import("node:events")
    const controller = new AbortController()

    const promise = withTimeout(
      () =>
        new Promise<never>(() => {
          /* never resolves */
        }),
      10_000,
      "Leak",
      controller.signal
    )
    controller.abort()
    await promise.catch(() => undefined)

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })
})
