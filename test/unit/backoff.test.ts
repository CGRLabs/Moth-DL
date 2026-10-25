import { describe, expect, it } from 'vitest';
import {
  computeBackoffDelay,
  parseRetryAfter,
  sleep,
  withRetry,
} from '../../src/main/util/backoff.js';
import { EngineError } from '../../src/main/util/errors.js';

const retryable = (message = 'boom'): EngineError =>
  new EngineError({ code: 'NETWORK', message });
const fatal = (message = 'nope'): EngineError =>
  new EngineError({ code: 'HTTP_CLIENT_ERROR', message, httpStatus: 404 });

describe('computeBackoffDelay', () => {
  it('grows exponentially with jitter disabled', () => {
    const opts = { baseDelayMs: 500, factor: 2, jitterRatio: 0 };
    expect(computeBackoffDelay(1, opts)).toBe(500);
    expect(computeBackoffDelay(2, opts)).toBe(1000);
    expect(computeBackoffDelay(3, opts)).toBe(2000);
    expect(computeBackoffDelay(4, opts)).toBe(4000);
  });

  it('caps the delay at maxDelayMs', () => {
    const opts = { baseDelayMs: 500, factor: 2, maxDelayMs: 1500, jitterRatio: 0 };
    expect(computeBackoffDelay(10, opts)).toBe(1500);
  });

  it('returns the cap for random()=1 and zero for random()=0 (full jitter)', () => {
    const base = { baseDelayMs: 1000, factor: 2, maxDelayMs: 1000, jitterRatio: 1 };
    expect(computeBackoffDelay(5, { ...base, random: () => 1 })).toBe(1000);
    expect(computeBackoffDelay(5, { ...base, random: () => 0 })).toBe(0);
    expect(computeBackoffDelay(1, { ...base, random: () => 0.5 })).toBe(500);
  });

  it('keeps full-jitter delays within [0, cap]', () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const delay = computeBackoffDelay(attempt, {
        baseDelayMs: 500,
        maxDelayMs: 2000,
        jitterRatio: 1,
        random: () => 0.9999,
      });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });
});

describe('withRetry', () => {
  const fast = { baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 };

  it('succeeds on the first try without retrying', async () => {
    let calls = 0;
    const result = await withRetry(
      async (attempt: number) => {
        calls += 1;
        expect(attempt).toBe(1);
        return 'ok';
      },
      { ...fast },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a retryable EngineError then succeeds', async () => {
    let calls = 0;
    const seenAttempts: number[] = [];
    const result = await withRetry(
      async (attempt: number) => {
        calls += 1;
        seenAttempts.push(attempt);
        if (calls < 3) throw retryable();
        return 'recovered';
      },
      { ...fast },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
    expect(seenAttempts).toEqual([1, 2, 3]);
  });

  it('does NOT retry a non-retryable error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw fatal();
        },
        { ...fast },
      ),
    ).rejects.toMatchObject({ code: 'HTTP_CLIENT_ERROR' });
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw retryable();
        },
        { ...fast, maxAttempts: 3 },
      ),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toBe(3);
  });

  it('respects an already-aborted AbortSignal without calling the task', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      withRetry(
        async () => {
          calls += 1;
          return 1;
        },
        { ...fast, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'CANCELED' });
    expect(calls).toBe(0);
  });

  it('invokes onRetry before each sleep with the error, attempt and delay', async () => {
    const seen: Array<{ attempt: number; delayMs: number; code: string }> = [];
    await expect(
      withRetry(
        async () => {
          throw retryable();
        },
        {
          ...fast,
          maxAttempts: 3,
          onRetry: (error: EngineError, attempt: number, delayMs: number) => {
            seen.push({ attempt, delayMs, code: error.code });
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    // Two retries (attempts 1 and 2 sleep; attempt 3 exhausts maxAttempts).
    expect(seen).toHaveLength(2);
    expect(seen[0]?.attempt).toBe(1);
    expect(seen[1]?.attempt).toBe(2);
    for (const entry of seen) {
      expect(entry.code).toBe('NETWORK');
      expect(entry.delayMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('waits at least as long as a server Retry-After hint', async () => {
    const seen: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw new EngineError({
            code: 'HTTP_TOO_MANY_REQUESTS',
            message: 'try later',
            context: { retryAfterMs: 35 }
          });
        },
        {
          ...fast,
          maxAttempts: 2,
          onRetry: (_error, _attempt, delayMs) => seen.push(delayMs)
        }
      )
    ).rejects.toMatchObject({ code: 'HTTP_TOO_MANY_REQUESTS' });
    expect(seen).toEqual([35]);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    await sleep(5);
  });

  it('resolves immediately for zero or negative durations', async () => {
    await sleep(0);
    await sleep(-10);
  });

  it('rejects with CANCELED for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toMatchObject({
      code: 'CANCELED',
    });
  });

  it('rejects when aborted mid-sleep', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
  });
});

describe('parseRetryAfter', () => {
  it('parses the delta-seconds form into milliseconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('  90 ')).toBe(90_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('clamps delta-seconds to 5 minutes', () => {
    expect(parseRetryAfter('1000')).toBe(5 * 60_000);
  });

  it('parses the HTTP-date form relative to now', () => {
    const now = Date.now();
    const header = new Date(now + 60_000).toUTCString();
    const ms = parseRetryAfter(header, now);
    expect(ms).not.toBeNull();
    expect(ms as number).toBeGreaterThan(59_000);
    expect(ms as number).toBeLessThanOrEqual(60_000);
  });

  it('clamps past HTTP dates to zero and far-future dates to 5 minutes', () => {
    const now = Date.now();
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter(new Date(now + 60 * 60_000).toUTCString(), now)).toBe(
      5 * 60_000,
    );
  });

  it('returns null for garbage, empty and missing headers', () => {
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});
