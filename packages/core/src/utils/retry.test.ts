import { afterEach, describe, expect, it, vi } from "vitest"
import { PermanentError } from "./errors"
import { DEFAULT_RETRY_DELAY_MS, retryBudgetMs, withRetry } from "./retry"

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

  it("fails fast without calling fn when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = vi.fn()

    const error = await withRetry(fn, 3, undefined, 0, controller.signal).then(
      () => undefined,
      (err: Error) => err
    )

    expect(error?.name).toBe("AbortError")
    expect(fn).not.toHaveBeenCalled()
  })

  it("stops retrying once the signal aborts", async () => {
    const controller = new AbortController()
    const onRetry = vi.fn()
    const fn = vi.fn(async () => {
      controller.abort()
      throw new Error("boom")
    })

    const error = await withRetry(fn, 3, onRetry, 0, controller.signal).then(
      () => undefined,
      (err: Error) => err
    )

    expect(error?.message).toBe("boom")
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("does not retry a failure the predicate rejects", async () => {
    const err = new PermanentError("permanent")
    const fn = vi.fn().mockRejectedValue(err)
    const onRetry = vi.fn()

    const rejected = await withRetry(fn, 3, onRetry, 0, undefined, () => false).then(
      () => undefined,
      (e: Error) => e
    )

    expect(rejected).toBe(err)
    // One call, no backoff, no notification: a permanent failure fails fast.
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("keeps retrying when the predicate accepts the error", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("a")).mockResolvedValue("ok")
    const onRetry = vi.fn()

    await expect(withRetry(fn, 2, onRetry, 0, undefined, () => true)).resolves.toBe("ok")

    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("passes the error and the 1-based attempt to the predicate", async () => {
    const err = new Error("boom")
    const seen: Array<[unknown, number]> = []
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok")

    await withRetry(fn, 1, undefined, 0, undefined, (e, attempt) => {
      seen.push([e, attempt])
      return true
    })

    expect(seen).toEqual([[err, 1]])
  })
})

describe("retryBudgetMs", () => {
  it("equals the per-attempt budget when there are no retries", () => {
    // With a single attempt there is no backoff, so the two timers coincide.
    expect(retryBudgetMs(1000, 0)).toBe(1000)
  })

  it("uses the shared default backoff unit", () => {
    // 2 attempts of 1000ms + one backoff of DEFAULT_RETRY_DELAY_MS * 1.
    expect(retryBudgetMs(1000, 1)).toBe(2000 + DEFAULT_RETRY_DELAY_MS)
  })

  it("adds every attempt plus the linear backoff sum", () => {
    // 3 attempts of 1000 + (2000*1 + 2000*2) = 3000 + 6000.
    expect(retryBudgetMs(1000, 2)).toBe(9000)
  })

  it("honours an explicit backoff unit", () => {
    // 2 attempts of 500 + one backoff of 100*1.
    expect(retryBudgetMs(500, 1, 100)).toBe(1100)
  })
})
