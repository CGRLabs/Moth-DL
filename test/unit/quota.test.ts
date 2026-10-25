import { describe, expect, it } from 'vitest'
import { fromQuotaBytes, toQuotaBytes } from '../../src/shared/quota.js'
import { setDownloadQuotaSchema } from '../../src/shared/schemas.js'

describe('download quota conversion', () => {
  it('converts a custom megabyte quota to bytes', () => {
    expect(toQuotaBytes('1.5')).toBe(1_572_864)
    expect(toQuotaBytes('0.25')).toBe(262_144)
  })

  it('rejects empty, non-positive, non-finite, and out-of-range quotas', () => {
    expect(toQuotaBytes('')).toBeNull()
    expect(toQuotaBytes('0')).toBeNull()
    expect(toQuotaBytes('-1')).toBeNull()
    expect(toQuotaBytes('Infinity')).toBeNull()
    expect(toQuotaBytes('9007199254')).toBeNull()
  })

  it('formats stored quota bytes as megabytes', () => {
    expect(fromQuotaBytes(1_572_864)).toBe('1.5')
  })

  it('validates nullable integer quotas at the IPC boundary', () => {
    expect(setDownloadQuotaSchema.safeParse({ id: 'download_1', quotaBytes: null }).success).toBe(true)
    expect(setDownloadQuotaSchema.safeParse({ id: 'download_1', quotaBytes: 1 }).success).toBe(true)
    expect(setDownloadQuotaSchema.safeParse({ id: 'download_1', quotaBytes: 0 }).success).toBe(false)
    expect(setDownloadQuotaSchema.safeParse({ id: 'download_1', quotaBytes: 1.5 }).success).toBe(false)
    expect(setDownloadQuotaSchema.safeParse({ id: 'download_1', quotaBytes: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
  })
})
