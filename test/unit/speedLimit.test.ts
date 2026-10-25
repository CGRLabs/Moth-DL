import { describe, expect, it } from 'vitest'
import { fromBytesPerSecond, toBytesPerSecond } from '../../src/shared/speedLimit.js'

describe('download speed limit conversion', () => {
  it('converts custom fractional rates to bytes per second', () => {
    expect(toBytesPerSecond('1.5', 'MB/s')).toBe(1_572_864)
    expect(toBytesPerSecond('128', 'KB/s')).toBe(131_072)
    expect(toBytesPerSecond('2.4', 'B/s')).toBe(2)
  })

  it('rejects empty, non-positive, non-finite, and out-of-range rates', () => {
    expect(toBytesPerSecond('', 'KB/s')).toBeNull()
    expect(toBytesPerSecond('-1', 'KB/s')).toBeNull()
    expect(toBytesPerSecond('0', 'KB/s')).toBeNull()
    expect(toBytesPerSecond('Infinity', 'MB/s')).toBeNull()
    expect(toBytesPerSecond('1024.01', 'GB/s')).toBeNull()
  })

  it('round-trips stored rates using a readable unit', () => {
    expect(fromBytesPerSecond(1_572_864)).toEqual({ value: '1.5', unit: 'MB/s' })
    const smallRate = fromBytesPerSecond(64)
    expect(toBytesPerSecond(smallRate.value, smallRate.unit)).toBe(64)
  })
})
