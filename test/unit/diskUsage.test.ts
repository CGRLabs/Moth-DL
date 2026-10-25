import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDiskUsage } from '../../src/main/util/diskUsage.js'

describe('getDiskUsage', () => {
  it('reports total and free bytes for a real directory', () => {
    const usage = getDiskUsage(tmpdir())
    expect(usage).not.toBeNull()
    expect(usage!.totalBytes).toBeGreaterThan(0)
    expect(usage!.freeBytes).toBeGreaterThanOrEqual(0)
    expect(usage!.freeBytes).toBeLessThanOrEqual(usage!.totalBytes)
  })

  it('returns null for a path that cannot be statted', () => {
    expect(getDiskUsage(join(tmpdir(), 'moth-no-such-dir-9f8e7d6c'))).toBeNull()
  })

  it('returns null for an empty path', () => {
    expect(getDiskUsage('')).toBeNull()
  })
});
