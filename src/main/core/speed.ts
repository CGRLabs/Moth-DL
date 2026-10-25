/**
 * Transfer-rate measurement.
 *
 * A naive "bytes since start / elapsed" average is useless for a download that
 * was paused, throttled, or is recovering from a slow start. Moth uses an
 * exponentially weighted moving average over a sliding window, which reacts
 * quickly to changes while still suppressing per-packet jitter.
 */

export class SpeedMeter {
  private samples: { t: number; bytes: number }[] = []
  private ewma = 0
  private lastTotal = 0
  private lastAt: number

  constructor(
    private readonly windowMs = 5000,
    private readonly halfLifeMs = 1500,
    now: number = Date.now()
  ) {
    this.lastAt = now
  }

  /** Records that `totalBytes` have been transferred in total. */
  update(totalBytes: number, now: number = Date.now()): void {
    const delta = totalBytes - this.lastTotal
    // A negative delta means the download restarted or was rewound.
    if (delta < 0) {
      this.reset(now)
      return
    }
    this.lastTotal = totalBytes
    const elapsed = now - this.lastAt
    this.lastAt = now
    if (elapsed <= 0) return

    const instant = (delta / elapsed) * 1000
    this.samples.push({ t: now, bytes: delta })
    this.prune(now)

    if (this.ewma === 0) {
      this.ewma = instant
    } else {
      // Time-constant weighting: the newer sample dominates as it ages out.
      const alpha = 1 - Math.exp(-elapsed / this.halfLifeMs)
      this.ewma += alpha * (instant - this.ewma)
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    let index = 0
    while (index < this.samples.length && (this.samples[index] as { t: number }).t < cutoff) {
      index += 1
    }
    if (index > 0) this.samples.splice(0, index)
  }

  /** Current smoothed rate in bytes/second. */
  get bytesPerSecond(): number {
    if (this.samples.length === 0) return 0
    return Math.max(0, this.ewma)
  }

  /** Mean over the whole window; steadier than the EWMA for large files. */
  get windowedBytesPerSecond(): number {
    if (this.samples.length < 2) return this.bytesPerSecond
    const first = this.samples[0] as { t: number; bytes: number }
    const last = this.samples[this.samples.length - 1] as { t: number; bytes: number }
    const elapsed = last.t - first.t
    if (elapsed <= 0) return this.bytesPerSecond
    return Math.max(0, ((last.bytes - first.bytes) / elapsed) * 1000)
  }

  get totalBytes(): number {
    return this.lastTotal
  }

  get sampleCount(): number {
    return this.samples.length
  }

  reset(now: number = Date.now()): void {
    this.samples = []
    this.ewma = 0
    this.lastTotal = 0
    this.lastAt = now
  }

  /** Re-bases the meter onto a known total, e.g. after recovery. */
  rebase(totalBytes: number, now: number = Date.now()): void {
    this.samples = []
    this.ewma = 0
    this.lastTotal = totalBytes
    this.lastAt = now
  }
}

/**
 * Aggregate rate across many meters.
 * The global figure is the sum of each member's rate, which is correct because
 * the members transfer concurrently.
 */
export class AggregateSpeed {
  private readonly meters = new Map<string, SpeedMeter>()

  meterFor(id: string): SpeedMeter {
    let meter = this.meters.get(id)
    if (!meter) {
      meter = new SpeedMeter()
      this.meters.set(id, meter)
    }
    return meter
  }

  update(id: string, totalBytes: number, now = Date.now()): void {
    this.meterFor(id).update(totalBytes, now)
  }

  remove(id: string): void {
    this.meters.delete(id)
  }

  get bytesPerSecond(): number {
    let total = 0
    for (const meter of this.meters.values()) total += meter.bytesPerSecond
    return total
  }

  /** Per-id rates, for the UI. */
  rates(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [id, meter] of this.meters) out[id] = meter.bytesPerSecond
    return out
  }

  reset(): void {
    this.meters.clear()
  }
}
