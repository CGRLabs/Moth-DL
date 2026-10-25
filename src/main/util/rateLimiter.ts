/**
 * Byte-rate limiting.
 *
 * A naive token bucket lets a paused-then-resumed download fire a multi-megabyte
 * burst that saturates the link and stalls every other connection. Moth instead
 * uses GCRA (a leaky bucket / virtual-scheduling rate limiter):
 *
 *   Each caller asks for `n` bytes. The limiter keeps a "theoretical arrival
 *   time" (TAT) — the instant at which the bucket would be full again. A
 *   request is admissible if `TAT - burstTime <= now`, and it *reserves* its
 *   slot by advancing the TAT, so concurrent connections are paced fairly and
 *   in FIFO order rather than each independently bursting.
 *
 * The long-run rate is exactly the configured limit, with no bursts, and it
 * reacts to `setRate()` immediately (no draining of a stale bucket).
 */

import { sleep } from './backoff.js'
import { EngineError } from './errors.js'

export interface RateLimiterOptions {
  /** Bytes per second. `0` or `Infinity` means unlimited. */
  bytesPerSecond: number
  /**
   * Maximum instantaneous burst, in bytes. Defaults to one second of traffic.
   * Small values smooth the flow; the value is clamped to the bucket capacity.
   */
  burstBytes?: number
  /** Injected clock, in milliseconds. Tests use a fake. */
  now?: () => number
}

export class RateLimiter {
  private rate: number
  private readonly burst: number
  private readonly now: () => number
  /** Theoretical arrival time of the bucket, in ms on the injected clock. */
  private tat = 0
  private initialised = false
  private totalGranted = 0

  constructor(options: RateLimiterOptions) {
    this.rate = Math.max(0, options.bytesPerSecond)
    this.now = options.now ?? Date.now

    // Default burst is ~100 ms of traffic: enough to absorb a normal socket
    // read without jitter, small enough that the limit still feels smooth.
    // A one-second burst (the previous default) let a capped download fire
    // two full seconds of data at once, which is exactly the burstiness this
    // limiter exists to prevent.
    //
    // The cap at 64 KiB keeps a fast link from accumulating a huge one-shot
    // allowance, and the floor of 1 byte keeps a very slow limit enforceable
    // (an earlier 64 KiB *floor* silently disabled every limit under ~512 kbps).
    const requested = options.burstBytes ?? Math.max(1, Math.floor(this.rate / 10))
    this.burst = Math.max(1, Math.min(requested, 64 * 1024))
  }

  get bytesPerSecond(): number {
    return this.rate
  }

  get isUnlimited(): boolean {
    return !Number.isFinite(this.rate) || this.rate <= 0
  }

  setRate(bytesPerSecond: number): void {
    const next = Math.max(0, bytesPerSecond)
    const previous = this.rate
    if (next === previous) return
    this.rate = next

    const current = this.now()
    if (!this.initialised) {
      this.tat = current
      this.initialised = true
      return
    }
    if (this.tat < current) {
      // No outstanding debt; re-anchor.
      this.tat = current
      return
    }
    if (next <= 0) {
      // Became unlimited: debt is meaningless, drop it.
      this.tat = current
      return
    }
    if (next > previous && previous > 0) {
      // Scale the outstanding debt by the ratio of the rates so a raised limit
      // takes effect immediately instead of after the old debt drains.
      const debt = this.tat - current
      this.tat = current + debt * (previous / next)
    }
  }

  /**
   * Reserves `bytes` of capacity.
   * Returns the number of milliseconds the caller must wait before the bytes
   * are considered transferred. `0` means "go now".
   *
   * The slot is reserved even when the caller must wait, which is what keeps
   * concurrent connections paced instead of stampeding.
   */
  tryAcquire(bytes: number): number {
    if (this.isUnlimited || bytes <= 0) {
      this.totalGranted += Math.max(0, bytes)
      return 0
    }
    const now = this.now()
    if (!this.initialised) {
      this.tat = now
      this.initialised = true
    }
    // Charge the full request even when it exceeds the burst window. Clamping
    // the charge to the burst would let a single large read pass for free and
    // silently break the long-run rate.
    const tatBase = Math.max(this.tat, now)
    const allowAt = tatBase - (this.burst / this.rate) * 1000
    this.tat = tatBase + (bytes / this.rate) * 1000
    this.totalGranted += bytes
    return allowAt <= now ? 0 : Math.ceil(allowAt - now)
  }

  /**
   * Acquires capacity for `bytes`, sleeping for as long as GCRA requires.
   *
   * A single reservation is taken up-front and the caller sleeps exactly the
   * time that reservation grants. Looping would double-pay for the same bytes.
   */
  async acquire(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.isUnlimited || bytes <= 0) return
    const waitMs = this.tryAcquire(bytes)
    if (waitMs <= 0) return
    await sleep(waitMs, signal)
  }

  /** Diagnostics for the stats panel. */
  stats(): { rate: number; burst: number; debtMs: number; granted: number } {
    return {
      rate: this.rate,
      burst: this.burst,
      debtMs: Math.max(0, this.tat - this.now()),
      granted: this.totalGranted
    }
  }
}

/**
 * A global limiter combined with per-download limits.
 *
 * The global and saved per-download admissions are reserved together, so a
 * caller waits for whichever of the two is slower rather than for both in turn.
 */
export class CompositeRateLimiter {
  private readonly global: RateLimiter
  private readonly perDownload = new Map<string, RateLimiter>()

  constructor(options: { globalBytesPerSecond: number; now?: () => number }) {
    this.global = new RateLimiter({
      bytesPerSecond: options.globalBytesPerSecond,
      now: options.now
    })
  }

  setGlobalRate(bytesPerSecond: number): void {
    this.global.setRate(bytesPerSecond)
  }

  /** Registers or updates the limit for one download. `0`/`null` clears it. */
  setPerDownload(id: string, bytesPerSecond: number | null | undefined): void {
    if (bytesPerSecond === null || bytesPerSecond === undefined || bytesPerSecond <= 0) {
      this.perDownload.delete(id)
      return
    }
    const existing = this.perDownload.get(id)
    if (existing) existing.setRate(bytesPerSecond)
    else this.perDownload.set(id, new RateLimiter({ bytesPerSecond }))
  }

  remove(id: string): void {
    this.perDownload.delete(id)
  }

  /** Forgets accumulated debt for a download, e.g. right after a resume. */
  reset(id: string): void {
    this.perDownload.delete(id)
  }

  /**
   * Admits `bytes` under the global and saved per-download limits.
   *
   * Both persistent limits reserve up front, so the sleep covers the stricter
   * of the two and no capacity is held back waiting for the other.
   */
  async acquire(id: string, bytes: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new EngineError({ code: 'CANCELED', message: 'Rate limiter aborted' })
    }
    if (bytes <= 0) return

    const local = this.perDownload.get(id)
    const wait = Math.max(
      this.global.isUnlimited ? 0 : this.global.tryAcquire(bytes),
      local && !local.isUnlimited ? local.tryAcquire(bytes) : 0
    )
    if (wait <= 0) return
    await sleep(wait, signal)
  }

  stats(): {
    global: { rate: number; debtMs: number }
    perDownload: { id: string; rate: number; debtMs: number }[]
  } {
    const global = this.global.stats()
    const perDownload = [...this.perDownload.entries()].map(([id, limiter]) => {
      const info = limiter.stats()
      return { id, rate: info.rate, debtMs: info.debtMs }
    })
    return {
      global: { rate: global.rate, debtMs: global.debtMs },
      perDownload
    }
  }
}
