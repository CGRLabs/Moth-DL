import { describe, expect, it } from 'vitest'
import { isYouTubeUrl } from '../../src/shared/mediaUrl.js'
import { formatDateTime } from '../../src/shared/dateTime.js'

describe('YouTube URL helper', () => {
  it('recognizes supported YouTube host variants', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isYouTubeUrl('https://youtu.be/abc')).toBe(true)
    expect(isYouTubeUrl('https://www.youtube-nocookie.com/embed/abc')).toBe(true)
  })

  describe('formatDateTime', () => {
    it('formats an epoch timestamp in the current locale with date and time', () => {
      const timestamp = Date.UTC(2024, 0, 2, 15, 4)
      expect(formatDateTime(timestamp)).toBe(
        new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      )
    })

    it('returns a placeholder for an invalid timestamp', () => {
      expect(formatDateTime(Number.NaN)).toBe('—')
    })
  })

  it('does not mistake lookalike hosts or malformed URLs for YouTube', () => {
    expect(isYouTubeUrl('https://youtube.com.example.org/watch?v=abc')).toBe(false)
    expect(isYouTubeUrl('not a url')).toBe(false)
  })
})
