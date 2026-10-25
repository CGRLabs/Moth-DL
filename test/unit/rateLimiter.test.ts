/**
 * Rate limiter (GCRA).
 *
 * The important properties are not "does it limit" but:
 *  - the long-run rate equals the configured rate,
 *  - there is no burst beyond the configured window,
 *  - concurrent callers are paced, not serialised behind one another,
 *  - raising the limit takes effect immediately (no stale debt).
 *
 * A fake clock makes all of these deterministic.
 */

import { describe, it, expect } from 'vitest'
import { CompositeRateLimiter, RateLimiter } from '../../src/main/util/rateLimiter.js'

/** A monotonic clock the test drives by hand. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    }
  }
}

describe('RateLimiter', () => {
  it('is unlimited when the rate is zero or infinite', () => {
    for (const rate of [0, Number.POSITIVE_INFINITY]) {
      const limiter = new RateLimiter({ bytesPerSecond: rate, now: () => 0 })
      expect(limiter.isUnlimited).toBe(true)
      expect(limiter.tryAcquire(1_000_000)).toBe(0)
    }
  })

  it('lets the first burst through immediately', () => {
    const clock = fakeClock()
    // 1000 B/s, burst capped at one second of traffic = 1000 B.
    const limiter = new RateLimiter({ bytesPerSecond: 1000, now: clock.now })
    expect(limiter.tryAcquire(1000)).toBe(0)
  })

  it('is not a no-op at low transfer rates', () => {
    // Regression: a 64 KiB burst *floor* made the burst window wider than all
    // the debt a sub-512 kbps limit could ever accumulate, so every request
    // was admitted instantly and the setting did nothing.
    const clock = fakeClock()
    const limiter = new RateLimiter({ bytesPerSecond: 1000, now: clock.now })
    limiter.tryAcquire(1000)
    expect(limiter.tryAcquire(100)).toBeGreaterThan(0)
  })

  it('paces a sustained stream at the configured rate', () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ bytesPerSecond: 1000, now: clock.now })

    // GCRA grants a one-off allowance (burst + first packet) before pacing
    // begins, so measure the steady state after discarding the first packets.
    const packet = 100
    const warmup = 10
    const measured = 90
    let elapsed = 0

    for (let i = 0; i < warmup + measured; i += 1) {
      const wait = limiter.tryAcquire(packet)
      if (i >= warmup) elapsed += wait
      clock.advance(wait)
    }

    // In steady state each 100 B packet at 1000 B/s must cost ~100 ms.
    const seconds = elapsed / 1000
    const actualRate = (measured * packet) / seconds
    expect(Math.abs(actualRate - 1000) / 1000).toBeLessThan(0.01)
  })

  it('paces each packet at approximately packet/rate once warm', () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ bytesPerSecond: 1000, now: clock.now })
    const waits: number[] = []
    for (let i = 0; i < 12; i += 1) {
      const wait = limiter.tryAcquire(100)
      waits.push(wait)
      clock.advance(wait)
    }
    // Every wait after warm-up is one packet's worth of time.
    for (const wait of waits.slice(4)) {
      expect(wait).toBeGreaterThanOrEqual(95)
      expect(wait).toBeLessThanOrEqual(115)
    }
  })

  it('averages the configured rate over a long run', () => {
    const clock = fakeClock()
    const rate = 10_000
    const limiter = new RateLimiter({ bytesPerSecond: rate, now: clock.now })

    const packet = 500
    let elapsed = 0
    const iterations = 2000
    for (let i = 0; i < iterations; i += 1) {
      const wait = limiter.tryAcquire(packet)
      elapsed += wait
      clock.advance(wait)
    }
    const transferred = packet * iterations
    const seconds = elapsed / 1000
    expect(seconds).toBeGreaterThan(0)
    const actual = transferred / seconds
    // Tolerance is the one-time burst (capped at 64 KiB) over the run total.
    const burst = Math.min(rate, 64 * 1024)
    const tolerance = (2 * burst) / transferred + 0.005
    expect(Math.abs(actual - rate) / rate).toBeLessThan(tolerance)
  })

  it('paces concurrent callers fairly rather than letting them all burst', () => {
    const clock = fakeClock()
    // A 250 B burst against four simultaneous 250 B requests: only two fit
    // inside the window, so the later callers must be delayed.
    const limiter = new RateLimiter({
      bytesPerSecond: 1000,
      burstBytes: 250,
      now: clock.now
    })
    const waits = [
      limiter.tryAcquire(250),
      limiter.tryAcquire(250),
      limiter.tryAcquire(250),
      limiter.tryAcquire(250)
    ]

    // Reservations are strictly ordered: caller N waits at least as long as the
    // time needed to transfer everything ahead of it, minus the burst window.
    expect(waits[0]).toBe(0)
    expect(waits[1]).toBe(0) // still inside the burst window
    expect(waits[2]).toBeGreaterThan(0)
    expect(waits[3]).toBeGreaterThanOrEqual(waits[2]!)
    // After four 250 B reservations the bucket's theoretical arrival time is
    // 1000 ms (all 1000 B committed). The fourth caller was admitted at
    // `tat_before - burst` = 750 - 250 = 500 ms.
    expect(waits[2]).toBe(250)
    expect(waits[3]).toBe(500)
  })

  it('applies a raised limit immediately instead of draining old debt', () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ bytesPerSecond: 1000, now: clock.now })

    // Build up a large debt at the slow rate.
    for (let i = 0; i < 20; i += 1) {
      const wait = limiter.tryAcquire(1000)
      clock.advance(wait)
    }
    const debtBefore = limiter.stats().debtMs
    expect(debtBefore).toBeGreaterThan(0)

    // Raise the limit 10x and reset the clock to "now".
    limiter.setRate(10_000)
    // The next request should not be blocked by the old debt.
    const wait = limiter.tryAcquire(1000)
    expect(wait).toBeLessThan(1000)
  })

  it('clears debt when switched to unlimited', () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ bytesPerSecond: 1000, now: clock.now })
    for (let i = 0; i < 20; i += 1) clock.advance(limiter.tryAcquire(1000))
    expect(limiter.stats().debtMs).toBeGreaterThan(0)

    limiter.setRate(0)
    expect(limiter.isUnlimited).toBe(true)
    expect(limiter.tryAcquire(1_000_000)).toBe(0)
  })

  it('treats zero and negative byte requests as free', () => {
    const limiter = new RateLimiter({ bytesPerSecond: 1000, now: () => 0 })
    expect(limiter.tryAcquire(0)).toBe(0)
    expect(limiter.tryAcquire(-100)).toBe(0)
  })
})

describe('CompositeRateLimiter', () => {
  it('lets everything through when no limits are set', () => {
    const composite = new CompositeRateLimiter({ globalBytesPerSecond: 0, now: () => 0 })
    return expect(composite.acquire('a', 1_000_000)).resolves.toBeUndefined()
  })

  it('applies the global limit', () => {
    const clock = fakeClock()
    const composite = new CompositeRateLimiter({
      globalBytesPerSecond: 1000,
      now: clock.now
    })
    const global = composite.stats().global
    expect(global.rate).toBe(1000)
  })

  it('registers and clears per-download limiters', () => {
    const composite = new CompositeRateLimiter({ globalBytesPerSecond: 0, now: () => 0 })
    composite.setPerDownload('a', 500)
    expect(composite.stats().perDownload.map((d) => d.id)).toEqual(['a'])

    composite.setPerDownload('a', 800)
    expect(composite.stats().perDownload[0]?.rate).toBe(800)

    // null, undefined and 0 all mean "no per-download limit".
    composite.setPerDownload('a', null)
    expect(composite.stats().perDownload).toHaveLength(0)

    composite.setPerDownload('b', 100)
    composite.remove('b')
    expect(composite.stats().perDownload).toHaveLength(0)
  })

  it('honours the tighter of the global and per-download limits', async () => {
    // Global is effectively unlimited; the per-download limit must still bite.
    // `acquire` sleeps on the real clock, so this measures wall time.
    const composite = new CompositeRateLimiter({ globalBytesPerSecond: 0 })
    composite.setPerDownload('slow', 1000)

    // The first reservation is granted immediately (burst + one packet).
    await composite.acquire('slow', 1000)

    // The next 1000 B at 1000 B/s must cost about a second.
    const startedAt = Date.now()
    await composite.acquire('slow', 1000)
    const waited = Date.now() - startedAt
    expect(waited).toBeGreaterThanOrEqual(500)
  })

  it('applies the global limit when it is the tighter one', async () => {
    const composite = new CompositeRateLimiter({ globalBytesPerSecond: 1000 })
    await composite.acquire('a', 1000)

    const startedAt = Date.now()
    await composite.acquire('a', 1000)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const composite = new CompositeRateLimiter({ globalBytesPerSecond: 1000, now: () => 0 })
    const controller = new AbortController()
    controller.abort()
    await expect(composite.acquire('a', 1000, controller.signal)).rejects.toThrow()
  })
})
