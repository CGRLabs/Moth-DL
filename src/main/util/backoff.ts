/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (random in `[0, exp)`) is used rather than plain exponential
 * growth because a fleet of connections that all failed against the same host
 * (or the same 429) will otherwise retry in lockstep and re-create the
 * thundering herd that caused the failure.
 */

import { EngineError } from './errors.js'

export interface BackoffOptions {
  /** Delay before the first retry, milliseconds. */
  baseDelayMs?: number
  /** Upper bound on any single delay. */
  maxDelayMs?: number
  /** Growth factor per attempt. */
  factor?: number
  /** 0 = no jitter (tests), 1 = full jitter (production). */
  jitterRatio?: number
  /** Hard cap on attempts; `Infinity` for unlimited. */
  maxAttempts?: number
  /** Injected for deterministic tests. */
  random?: () => number
}

export interface BackoffState {
  attempts: number
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'random'>> = {
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  factor: 2,
  jitterRatio: 1,
  maxAttempts: 6
}

/** Computes the delay before attempt number `attempt` (1-based). */
export function computeBackoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseDelayMs ?? DEFAULT_BACKOFF.baseDelayMs
  const max = options.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs
  const factor = options.factor ?? DEFAULT_BACKOFF.factor
  const jitterRatio = options.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio
  const random = options.random ?? Math.random

  const exponential = base * factor ** Math.max(0, attempt - 1)
  const capped = Math.min(exponential, max)
  if (jitterRatio <= 0) return Math.round(capped)
  // Full jitter keeps the expected value at half the ceiling, which empirically
  // converges much faster than a fixed window.
  const jittered = capped * (1 - jitterRatio) + capped * jitterRatio * random()
  return Math.round(Math.max(0, jittered))
}

/**
 * Runs `task`, retrying on retryable failures with exponential backoff.
 *
 * Non-retryable errors propagate immediately, as does exhaustion of
 * `maxAttempts`. `onRetry` is invoked before each sleep so callers can log or
 * surface the countdown.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: BackoffOptions & {
    onRetry?: (error: EngineError, attempt: number, delayMs: number) => void
    signal?: AbortSignal
    /** Lets the caller veto a retry, e.g. because the user paused. */
    shouldRetry?: (error: EngineError, attempt: number) => boolean
  } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_BACKOFF.maxAttempts
  let attempt = 0

  for (;;) {
    attempt += 1
    if (options.signal?.aborted) {
      throw new EngineError({ code: 'CANCELED', message: 'Operation aborted' })
    }
    try {
      return await task(attempt)
    } catch (err) {
      const error =
        err instanceof EngineError
          ? err
          : new EngineError({ code: 'INTERNAL', message: String(err), cause: err })

      const canRetry =
        error.retryable && attempt < maxAttempts && (options.shouldRetry?.(error, attempt) ?? true)

      if (!canRetry) throw error

      const backoffDelayMs = computeBackoffDelay(attempt, options)
      const retryAfterMs = error.context?.retryAfterMs
      const delayMs =
        typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
          ? Math.max(backoffDelayMs, retryAfterMs)
          : backoffDelayMs
      options.onRetry?.(error, attempt, delayMs)
      await sleep(delayMs, options.signal)
    }
  }
}

/** Abortable sleep. Rejects with a CANCELED EngineError if the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EngineError({ code: 'CANCELED', message: 'Sleep aborted' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    // Do not keep the process alive purely for a backoff timer.
    if (typeof timer.unref === 'function') timer.unref()

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new EngineError({ code: 'CANCELED', message: 'Sleep aborted' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Converts a `Retry-After` header into milliseconds.
 * Handles both the delta-seconds and HTTP-date forms.
 */
export function parseRetryAfter(header: string | undefined, now = Date.now()): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number.parseInt(trimmed, 10) * 1000, 5 * 60_000)
  }
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return null
  return Math.min(Math.max(0, date - now), 5 * 60_000)
}
