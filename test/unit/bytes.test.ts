import { describe, expect, it } from 'vitest';
import {
  clamp,
  estimateEta,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  parseByteSize,
} from '../../src/main/util/bytes.js';

describe('formatBytes', () => {
  it('formats zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats sub-KB values without decimals', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('walks the KB -> TB unit ladder (1024-based)', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB');
  });

  it('honours the precision argument', () => {
    expect(formatBytes(1536, 2)).toBe('1.50 KB');
    expect(formatBytes(1536, 0)).toBe('2 KB');
  });

  it('returns an em dash for zero/negative/NaN/Infinity inputs', () => {
    // Deliberate guard: unknown sizes render as '—' in the UI.
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatRate', () => {
  it('returns an em dash for zero, negative or non-finite rates', () => {
    expect(formatRate(0)).toBe('—');
    expect(formatRate(-100)).toBe('—');
    expect(formatRate(Number.NaN)).toBe('—');
  });

  it('appends /s to a byte size', () => {
    expect(formatRate(512)).toBe('512 B/s');
    expect(formatRate(1024 * 1024)).toBe('1.0 MB/s');
  });

  it('uses 0 decimals below 100 KB/s and 1 decimal above', () => {
    expect(formatRate(50 * 1024)).toBe('50 KB/s');
    expect(formatRate(150 * 1024)).toBe('150.0 KB/s');
  });
});

describe('formatDuration', () => {
  it('says "just now" for sub-second durations', () => {
    expect(formatDuration(0)).toBe('just now');
    expect(formatDuration(0.5)).toBe('just now');
  });

  it('formats seconds, minutes and hours compactly', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3661)).toBe('1h 1m');
  });

  it('formats days as "Nd Nh"', () => {
    expect(formatDuration(90_000)).toBe('1d 1h');
  });

  it('returns an em dash for negative or non-finite input', () => {
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('parseByteSize', () => {
  it('parses decimal megabytes', () => {
    expect(parseByteSize('1.5MB')).toBe(Math.round(1.5 * 1024 ** 2));
  });

  it('parses kilobit-per-second rates into bytes', () => {
    expect(parseByteSize('512kbps')).toBe(512 * 1024);
  });

  it('parses gigabytes with an explicit B suffix', () => {
    expect(parseByteSize('2GB')).toBe(2 * 1024 ** 3);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseByteSize('1.5 MB')).toBe(parseByteSize('1.5MB'));
    expect(parseByteSize('1mb')).toBe(parseByteSize('1MB'));
  });

  it('returns null when the mandatory B suffix is missing', () => {
    // The grammar requires a trailing B, so a bare "2G" is garbage by design.
    expect(parseByteSize('2G')).toBeNull();
  });

  it('returns null for garbage, empty or unit-less input', () => {
    expect(parseByteSize('hello')).toBeNull();
    expect(parseByteSize('')).toBeNull();
    expect(parseByteSize('10')).toBeNull();
  });
});

describe('formatPercent', () => {
  it('converts a fraction to percent', () => {
    expect(formatPercent(0.42)).toBe('42%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('honours the digits argument', () => {
    expect(formatPercent(0.1234, 1)).toBe('12.3%');
  });

  it('returns an em dash for non-finite input', () => {
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('estimateEta', () => {
  it('divides remaining bytes by the rate', () => {
    expect(estimateEta(1000, 100)).toBe(10);
  });

  it('returns null for a zero or stalled (negative) rate', () => {
    expect(estimateEta(100, 0)).toBeNull();
    expect(estimateEta(100, -5)).toBeNull();
  });

  it('returns null for a non-finite rate', () => {
    expect(estimateEta(100, Number.NaN)).toBeNull();
  });

  it('returns null when there is nothing left', () => {
    expect(estimateEta(0, 100)).toBeNull();
    expect(estimateEta(-10, 100)).toBeNull();
  });

  it('returns null when the estimate exceeds ~100 years', () => {
    expect(estimateEta(1e12, 1)).toBeNull();
  });
});

describe('clamp', () => {
  it('passes through values inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to min and max', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});
