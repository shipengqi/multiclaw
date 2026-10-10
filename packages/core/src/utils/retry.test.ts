import { afterEach, describe, expect, it, vi } from "vitest"
import { withRetry } from "./retry"

afterEach(() => {
  vi.useRealTimers()
})

describe("withRetry", () => {
  it("resolves on the first attempt without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok")
    const onRetry = vi.fn()

    await expect(withRetry(fn, 3, onRetry)).resolves.toBe("ok")

    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("passes a 1-based attempt number to the callback", async () => {
    const attempts: number[] = []
    const fn = vi.fn(async (attempt: number) => {
      attempts.push(attempt)
      if (attempt < 2) throw new Error("boom")
      return "ok"
    })

    await withRetry(fn, 3, undefined, 0)

    expect(attempts).toEqual([1, 2])
  })

  it("retries on failure and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue("ok")
    const onRetry = vi.fn()

    await expect(withRetry(fn, 2, onRetry, 0)).resolves.toBe("ok")

    expect(fn).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error))
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error))
  })

  it("throws the last error after exhausting all retries", async () => {
    const first = new Error("first")
    const second = new Error("second")
    const fn = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second)
    const onRetry = vi.fn()

    await expect(withRetry(fn, 1, onRetry, 0)).rejects.toBe(second)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("waits with linear backoff between attempts", async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok")

    const promise = withRetry(fn, 3, undefined, 1000)
    let settled = false
    promise.then(() => {
      settled = true
    })

    // Let the first rejection be processed and the backoff timer armed.
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    // Less than the backoff delay: still waiting.
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)

    // Cross the backoff delay: the retry fires and resolves.
    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
