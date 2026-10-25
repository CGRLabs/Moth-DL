import { describe, expect, it } from 'vitest'
import { getHttpResumeCapability } from '../../src/shared/resumeCapability.js'

describe('HTTP resume capability', () => {
  const knownSize = 1024

  it('confirms safe resume only when ranges and a usable validator are present', () => {
    expect(getHttpResumeCapability({
      fileSize: knownSize,
      acceptRanges: true,
      etag: '"strong-tag"'
    }).support).toBe('safe')
    expect(getHttpResumeCapability({
      fileSize: knownSize,
      acceptRanges: true,
      lastModified: 'Wed, 01 Nov 2023 00:00:00 GMT'
    }).support).toBe('safe')
  })

  it('says interrupted transfers restart when range or validator support is absent', () => {
    const noRanges = getHttpResumeCapability({
      fileSize: knownSize,
      acceptRanges: false,
      etag: '"strong-tag"'
    })
    expect(noRanges.support).toBe('restart')
    expect(noRanges.label).toBe('Cannot safely resume — will restart')

    const noValidator = getHttpResumeCapability({
      fileSize: knownSize,
      acceptRanges: true
    })
    expect(noValidator.support).toBe('restart')
    expect(noValidator.explanation).toContain('discard partial progress')
  })

  it('does not claim safe resume for a weak ETag even when Last-Modified exists', () => {
    expect(getHttpResumeCapability({
      fileSize: knownSize,
      acceptRanges: true,
      etag: 'W/"weak-tag"',
      lastModified: 'Wed, 01 Nov 2023 00:00:00 GMT'
    }).support).toBe('restart')
  })

  it('keeps an unknown size distinct from known-unsafe resume', () => {
    expect(getHttpResumeCapability({
      fileSize: null,
      acceptRanges: false
    }).support).toBe('unknown')
    expect(getHttpResumeCapability({
      fileSize: 0,
      acceptRanges: true,
      etag: '"tag"'
    }).support).toBe('unknown')
  })
})
