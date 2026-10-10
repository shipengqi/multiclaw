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

  it("does not fire the timeout after a fast success", async () => {
    vi.useFakeTimers()
    const promise = withTimeout(async () => "quick", 10_000, "Quick")
    await expect(promise).resolves.toBe("quick")
    // The timer must be cleared, otherwise it would keep the process alive.
    expect(vi.getTimerCount()).toBe(0)
  })
})
