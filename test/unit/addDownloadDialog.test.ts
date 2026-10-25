import { describe, expect, it } from 'vitest'
import { isYouTubePlaylistUrl } from '../../src/shared/mediaUrl.js'

describe('isYouTubePlaylistUrl', () => {
  it.each([
    'https://www.youtube.com/playlist?list=PL123',
    'https://youtube.com/watch?v=video&list=PL123',
    'https://music.youtube.com/playlist?list=PL123',
    'https://youtu.be/video?list=PL123'
  ])('recognizes playlist link %s', (url) => {
    expect(isYouTubePlaylistUrl(url)).toBe(true)
  })

  it.each([
    'https://www.youtube.com/watch?v=video',
    'ftp://youtube.com/playlist?list=PL123',
    'https://notyoutube.com/playlist?list=PL123',
    'https://example.com/watch?list=PL123',
    'not a URL'
  ])('does not recognize non-playlist link %s', (url) => {
    expect(isYouTubePlaylistUrl(url)).toBe(false)
  })
})
