import { describe, expect, it } from 'vitest'
import { selectIfRangeValidator } from '../../src/main/net/httpClient.js'

/**
 * Contract for If-Range emission (RISK 3): a weak validator must never reach
 * the wire. Stripping `W/` to fake a strong validator would assert byte
 * identity we do not have, so weak means absent.
 */
describe('selectIfRangeValidator', () => {
  it('prefers a strong ETag over Last-Modified', () => {
    expect(selectIfRangeValidator('"abc123"', 'Wed, 01 Nov 2023 00:00:00 GMT')).toEqual({
      value: '"abc123"',
      droppedWeakETag: false
    })
  })

  it('falls back to Last-Modified when no ETag exists', () => {
    expect(selectIfRangeValidator(null, 'Wed, 01 Nov 2023 00:00:00 GMT')).toEqual({
      value: 'Wed, 01 Nov 2023 00:00:00 GMT',
      droppedWeakETag: false
    })
  })

  it('drops weak ETags instead of forwarding them', () => {
    expect(selectIfRangeValidator('W/"abc123"', 'Wed, 01 Nov 2023 00:00:00 GMT')).toEqual({
      value: null,
      droppedWeakETag: true
    })
    // Case-insensitive: dropping is always the safe direction.
    expect(selectIfRangeValidator('w/"abc123"', null)).toEqual({
      value: null,
      droppedWeakETag: true
    })
  })

  it('reports no usable validator when both are absent', () => {
    expect(selectIfRangeValidator(null, null)).toEqual({ value: null, droppedWeakETag: false })
    expect(selectIfRangeValidator('', '')).toEqual({ value: null, droppedWeakETag: false })
  })

  it('treats a blank ETag as absent and falls back', () => {
    expect(selectIfRangeValidator('   ', 'Wed, 01 Nov 2023 00:00:00 GMT')).toEqual({
      value: 'Wed, 01 Nov 2023 00:00:00 GMT',
      droppedWeakETag: false
    })
  })
})
