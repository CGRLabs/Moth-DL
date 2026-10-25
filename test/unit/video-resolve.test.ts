/**
 * Resolver parsing unit tests (slice 1).
 *
 * Every fixture is a canned `yt-dlp -J` dump — no network, no binaries.
 * The spawn boundary is stubbed via `setVideoResolverForTests`, so these
 * tests pin the pick rules (quality cap, audio direct-copy gating) and the
 * never-`--cookies-from-browser` rule.
 */

import { describe, expect, it, afterEach } from 'vitest'
import {
  buildYtDlpArgs,
  headersForResolvedAudio,
  isDirectCopyAudio,
  parseYtDlpDump,
  pickFormat,
  resolvePlaylist,
  resolveVideo,
  setVideoResolverForTests
} from '../../src/main/video/resolve.js'

afterEach(() => {
  setVideoResolverForTests(null)
})

it('does not treat an unknown codec as proof that an audio-only file contains video', () => {
  const dump = parseYtDlpDump({
    title: 'Unknown video codec',
    formats: [
      {
        url: 'https://cdn.example/audio.mp4',
        ext: 'mp4',
        vcodec: 'unknown',
        acodec: 'mp4a.40.2',
        height: 1080
      }
    ]
  })
  expect(() => pickFormat(dump, 'video', 1080)).toThrow(/video and audio streams suitable for muxing/)
})

/** Canned dump: 1080p video-only, 720p + 480p with audio, three audio tracks. */
function cannedDump(): Record<string, unknown> {
  return {
    id: 'abc123',
    title: 'Some Title',
    formats: [
      {
        url: 'https://cdn.example/v1080.mp4',
        ext: 'mp4',
        vcodec: 'avc1.640028',
        acodec: 'none',
        height: 1080,
        tbr: 4000
      },
      {
        url: 'https://cdn.example/v720.mp4',
        ext: 'mp4',
        vcodec: 'avc1.64001f',
        acodec: 'mp4a.40.2',
        height: 720,
        tbr: 2000
      },
      {
        url: 'https://cdn.example/v480.mp4',
        ext: 'mp4',
        vcodec: 'avc1.64001e',
        acodec: 'mp4a.40.2',
        height: 480,
        tbr: 900
      },
      {
        url: 'https://cdn.example/a-opus.webm',
        ext: 'webm',
        vcodec: 'none',
        acodec: 'opus',
        abr: 160
      },
      {
        url: 'https://cdn.example/a-m4a.m4a',
        ext: 'm4a',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        abr: 128
      },
      {
        url: 'https://cdn.example/a-mp3.mp3',
        ext: 'mp3',
        vcodec: 'none',
        acodec: 'mp3',
        abr: 128
      }
    ]
  }
}

describe('pickFormat', () => {
  it('picks the tallest video-with-audio at or below 720p (never video-only)', () => {
    const picked = pickFormat(parseYtDlpDump(cannedDump()), 'video')
    expect(picked.url).toBe('https://cdn.example/v720.mp4')
    expect(picked.filename).toBe('Some Title.mp4')
    expect(picked.hint?.needsTranscode).toBe(false)
    expect(picked.hint?.height).toBe(720)
  })

  it('uses a higher-resolution video-only stream instead of downgrading to a muxed stream', () => {
    const picked = pickFormat(
      parseYtDlpDump({
        title: 'Higher quality',
        formats: [
          {
            url: 'https://cdn.example/video-480.mp4',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'mp4a.40.2',
            height: 480,
            vbr: 900
          },
          {
            url: 'https://cdn.example/video-1080.mp4',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'none',
            height: 1080,
            vbr: 3000
          },
          {
            url: 'https://cdn.example/audio.m4a',
            ext: 'm4a',
            vcodec: 'none',
            acodec: 'mp4a.40.2',
            abr: 128
          }
        ]
      }),
      'video',
      1080
    )

    expect(picked.url).toBe('https://cdn.example/video-1080.mp4')
    expect(picked.audioUrl).toBe('https://cdn.example/audio.m4a')
    expect(picked.mergeContainer).toBe('mp4')
    expect(picked.hint?.height).toBe(1080)
  })

  it('does not treat an audio codec mislabeled as a video stream as video', () => {
    const dump = parseYtDlpDump({
      title: 'Audio-only MP4',
      formats: [
        {
          url: 'https://cdn.example/audio-only.mp4',
          ext: 'mp4',
          vcodec: 'mp4a.40.2',
          acodec: 'mp4a.40.2',
          height: 1080
        }
      ]
    })
    expect(() => pickFormat(dump, 'video', 1080)).toThrow(/video and audio streams suitable for muxing/)
  })

  it.each([360, 480, 720, 1080, 1440, 2160] as const)('honors the selected %ip video quality cap', (quality) => {
    const formats = [360, 480, 720, 1080, 1440, 2160].map((height) => ({
      url: `https://cdn.example/v${height}.mp4`,
      ext: 'mp4',
      vcodec: 'avc1',
      acodec: 'mp4a.40.2',
      height,
      tbr: height * 2
    }))
    const picked = pickFormat(parseYtDlpDump({ title: 'Quality sample', formats }), 'video', quality)
    expect(picked.hint?.height).toBe(quality)
  })

  it('skips Google video manifest endpoints and picks a direct media fallback', () => {
    const picked = pickFormat(
      parseYtDlpDump({
        title: 'Manifest fallback',
        formats: [
          {
            url: 'https://manifest.googlevideo.com/api/manifest/dash/id/example',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'none',
            height: 720
          },
          {
            url: 'https://cdn.example/direct.mp4',
            protocol: 'https',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'mp4a.40.2',
            height: 480
          }
        ]
      }),
      'video'
    )

    expect(picked.url).toBe('https://cdn.example/direct.mp4')
  })

  it('rejects a page when the resolver only exposes manifests or segmented protocols', () => {
    const dump = parseYtDlpDump({
      formats: [
        {
          url: 'https://manifest.googlevideo.com/api/manifest/dash/id/example',
          ext: 'mp4',
          vcodec: 'avc1',
          acodec: 'none',
          height: 720
        },
        {
          url: 'https://cdn.example/segments.mp4',
          protocol: 'http_dash_segments',
          ext: 'mp4',
          vcodec: 'avc1',
          acodec: 'none',
          height: 720
        }
      ]
    })

    expect(() => pickFormat(dump, 'video')).toThrow(/only exposed segmented or manifest streams/)
  })

  it('returns a validated page thumbnail hint', () => {
    const dump = {
      ...cannedDump(),
      thumbnail: 'https://cdn.example/poster.jpg'
    }
    expect(pickFormat(parseYtDlpDump(dump), 'video').mediaHint).toEqual({
      title: 'Some Title',
      pageImage: 'https://cdn.example/poster.jpg'
    })
  })

  it('prefers yt-dlp selected thumbnail over a larger thumbnail variant', () => {
    const picked = pickFormat(
      parseYtDlpDump({
        ...cannedDump(),
        thumbnail: 'https://cdn.example/selected.jpg',
        thumbnails: [{ url: 'https://cdn.example/largest.jpg', width: 3840, height: 2160 }]
      }),
      'video'
    )
    expect(picked.mediaHint?.pageImage).toBe('https://cdn.example/selected.jpg')
  })

  it('falls back to the largest resolver thumbnail when the default is absent', () => {
    const picked = pickFormat(
      parseYtDlpDump({
        ...cannedDump(),
        thumbnail: undefined,
        thumbnails: [
          { url: 'https://cdn.example/small.jpg', width: 120, height: 90 },
          { url: 'https://cdn.example/large.jpg', width: 1280, height: 720 }
        ]
      }),
      'video'
    )
    expect(picked.mediaHint?.pageImage).toBe('https://cdn.example/large.jpg')
  })

  it('resolves requested subtitles as safe sidecar tracks without forwarding cross-host cookies', async () => {
    setVideoResolverForTests(async () =>
      JSON.stringify({
        id: 'subtitle123',
        extractor_key: 'Example',
        title: 'Captioned',
        formats: [{
          url: 'https://cdn.example/video.mp4',
          ext: 'mp4',
          vcodec: 'avc1',
          acodec: 'mp4a.40.2',
          height: 360
        }],
        subtitles: {
          en: [
            { url: 'https://captions.example/en.vtt', ext: 'vtt' },
            { url: 'javascript:alert(1)', ext: 'vtt' }
          ]
        },
        automatic_captions: {
          es: [{ url: 'https://captions.example/es.vtt', ext: 'vtt' }]
        }
      })
    )

    const picked = await resolveVideo('https://page.example/watch/123', 'video', {
      cookies: 'session=secret',
      subtitleLanguages: ['en', 'es']
    })

    expect(picked.subtitleTracks).toHaveLength(2)
    expect(picked.subtitleTracks?.[0]).toMatchObject({
      language: 'en',
      url: 'https://captions.example/en.vtt',
      automatic: false,
      headers: {}
    })
    expect(picked.subtitleTracks?.[1]).toMatchObject({
      language: 'es',
      automatic: true
    })
  })

  it('preserves safe yt-dlp stream headers for the selected formats', () => {
    const dump = {
      title: 'Header sample',
      formats: [
        {
          url: 'https://cdn.example/video.mp4',
          ext: 'mp4',
          vcodec: 'avc1',
          acodec: 'none',
          height: 720,
          http_headers: {
            'User-Agent': 'yt-dlp test agent',
            Referer: 'https://www.youtube.com/',
            Cookie: 'must-not-forward=1',
            Host: 'attacker.example'
          }
        },
        {
          url: 'https://cdn.example/audio.m4a',
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          abr: 128,
          http_headers: { 'User-Agent': 'audio agent', Referer: 'https://www.youtube.com/' }
        }
      ]
    }

    const picked = pickFormat(parseYtDlpDump(dump), 'video')
    expect(picked.headers).toEqual({
      'User-Agent': 'yt-dlp test agent',
      Referer: 'https://www.youtube.com/'
    })
    expect(picked.audioHeaders).toEqual({
      'User-Agent': 'audio agent',
      Referer: 'https://www.youtube.com/'
    })
    expect(
      headersForResolvedAudio(
        { Cookie: 'page=session', 'User-Agent': 'browser agent' },
        'https://www.youtube.com/watch?v=1',
        'https://cdn.example/audio.m4a',
        picked.audioHeaders
      )
    ).toEqual({ 'User-Agent': 'audio agent', Referer: 'https://www.youtube.com/' })
  })

  it('ignores an invalid thumbnail URL without failing stream resolution', () => {
    const dump = { ...cannedDump(), thumbnail: 'javascript:alert(1)' }
    expect(pickFormat(parseYtDlpDump(dump), 'video').mediaHint).toEqual({ title: 'Some Title' })
  })

  it('pairs separate video and audio streams when no muxed stream is available', () => {
    const dump = {
      title: 'Separate tracks',
      formats: [
        { url: 'https://cdn.example/v1080.mp4', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, tbr: 5000 },
        { url: 'https://cdn.example/v720.mp4', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720, tbr: 2500 },
        { url: 'https://cdn.example/a.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 160 },
        { url: 'https://cdn.example/a.webm', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 256 }
      ]
    }
    const picked = pickFormat(parseYtDlpDump(dump), 'video')
    expect(picked.url).toBe('https://cdn.example/v720.mp4')
    expect(picked.audioUrl).toBe('https://cdn.example/a.m4a')
    expect(picked.mergeContainer).toBe('mp4')
    expect(picked.filename).toBe('Separate tracks.mp4')
    expect(picked.hint?.height).toBe(720)
  })

  it('uses Matroska when the separate codecs do not share a common container', () => {
    const dump = {
      title: 'Mixed tracks',
      formats: [
        { url: 'https://cdn.example/v.mp4', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720 },
        { url: 'https://cdn.example/a.opus', ext: 'opus', vcodec: 'none', acodec: 'opus', abr: 160 }
      ]
    }
    const picked = pickFormat(parseYtDlpDump(dump), 'video')
    expect(picked.audioUrl).toBe('https://cdn.example/a.opus')
    expect(picked.mergeContainer).toBe('mkv')
    expect(picked.filename).toBe('Mixed tracks.mkv')
  })

  it('picks the highest-bitrate audio-only track and marks non-MP3 for transcode', () => {
    const picked = pickFormat(parseYtDlpDump(cannedDump()), 'audio')
    expect(picked.url).toBe('https://cdn.example/a-opus.webm')
    expect(picked.hint?.needsTranscode).toBe(true)
  })

  it('keeps the source audio container when source output is requested', () => {
    const picked = pickFormat(parseYtDlpDump(cannedDump()), 'audio', undefined, 'source')
    expect(picked.url).toBe('https://cdn.example/a-opus.webm')
    expect(picked.filename).toBe('Some Title.webm')
    expect(picked.hint?.needsTranscode).toBe(false)
  })

  it('marks an MP3 audio track for direct copy (no transcode)', () => {
    const dump = {
      title: 'Song',
      formats: [{ url: 'https://cdn.example/song.mp3', ext: 'mp3', vcodec: 'none', acodec: 'mp3', abr: 192 }]
    }
    const picked = pickFormat(parseYtDlpDump(dump), 'audio')
    expect(picked.url).toBe('https://cdn.example/song.mp3')
    expect(picked.hint?.needsTranscode).toBe(false)
  })

  it('does not forward cookies to a different host serving the audio stream', () => {
    expect(
      headersForResolvedAudio(
        { Cookie: 'session=secret', Referer: 'https://video.example/watch', 'User-Agent': 'Moth/1' },
        'https://video.example/watch',
        'https://cdn.example/audio.m4a'
      )
    ).toEqual({ Referer: 'https://video.example/watch', 'User-Agent': 'Moth/1' })
  })

  it('forwards cookies when the resolved audio stays on the page host', () => {
    expect(
      headersForResolvedAudio(
        { cookie: 'session=value' },
        'https://media.example/watch',
        'https://media.example/audio.m4a'
      )
    ).toEqual({ cookie: 'session=value' })
  })

  it('fails honestly when only video-only tracks exist above the cap', () => {
    const dump = {
      title: 'Tall',
      formats: [
        { url: 'https://cdn.example/v1080.mp4', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080 },
        { url: 'https://cdn.example/a.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }
      ]
    }
    expect(() => pickFormat(parseYtDlpDump(dump), 'video')).toThrow(/720p/)
  })

  it('passes protected-format streams through instead of refusing them', () => {
    const dump = {
      title: 'Locked',
      formats: [
        {
          url: 'https://cdn.example/v.mp4',
          ext: 'mp4',
          vcodec: 'avc1',
          acodec: 'mp4a.40.2',
          height: 720,
          has_drm: true
        }
      ]
    }
    const resolved = pickFormat(parseYtDlpDump(dump), 'video')
    expect(resolved.url).toBe('https://cdn.example/v.mp4')
  })

  it('fails clearly when no stream carries a fetchable URL', () => {
    expect(() => pickFormat(parseYtDlpDump({ title: 'Empty', formats: [] }), 'video')).toThrow(
      /no downloadable streams/i
    )
  })
})

describe('parseYtDlpDump', () => {
  it('parses a JSON string dump', () => {
    const dump = parseYtDlpDump(JSON.stringify(cannedDump()))
    expect(dump.title).toBe('Some Title')
    expect(dump.formats).toHaveLength(6)
  })

  it('rejects unreadable resolver output with a clear error', () => {
    expect(() => parseYtDlpDump('not json{{{')).toThrow(/unreadable/)
  })

  it('rejects a shape this version does not understand', () => {
    expect(() => parseYtDlpDump({ formats: 'nope' })).toThrow(/does not understand/)
  })
})

describe('buildYtDlpArgs', () => {
  it('runs resolver-only flags and never touches a browser profile', () => {
    const args = buildYtDlpArgs('https://example.com/watch?v=1', {
      cookies: 'session=abc',
      userAgent: 'agent/1',
      referer: 'https://example.com/'
    })
    expect(args).toContain('-J')
    expect(args).toContain('--no-playlist')
    expect(args).toContain('https://example.com/watch?v=1')
    expect(args.join(' ')).not.toContain('cookies-from-browser')
    expect(args).toContain('Cookie: session=abc')
  })
})

describe('isDirectCopyAudio', () => {
  it.each([
    ['mp3', true],
    ['MP3', true],
    ['aac', false],
    ['mp4a.40.2', false],
    ['opus', false]
  ])('acodec %j -> direct copy %j', (acodec, expected) => {
    expect(isDirectCopyAudio(acodec)).toBe(expected)
  })

  it('null/undefined codecs never direct-copy', () => {
    expect(isDirectCopyAudio(null)).toBe(false)
    expect(isDirectCopyAudio(undefined)).toBe(false)
  })
})

describe('resolveVideo (stubbed runner, no spawn)', () => {
  it('resolves a page URL through the stub without spawning', async () => {
    setVideoResolverForTests(async () => JSON.stringify(cannedDump()))
    const resolved = await resolveVideo('https://example.com/watch?v=abc12345', 'video')
    expect(resolved.url).toBe('https://cdn.example/v720.mp4')
    expect(resolved.filename).toBe('Some Title.mp4')
  })

  describe('resolvePlaylist (stubbed runner, no spawn)', () => {
    it('returns bounded item metadata and uses flat playlist resolution', async () => {
      let capturedArgs: string[] = []
      setVideoResolverForTests(async (_binary, args) => {
        capturedArgs = args
        return JSON.stringify({
          title: 'Collection',
          extractor_key: 'YouTube',
          entries: [
            {
              id: 'videoA',
              title: 'First',
              webpage_url: 'https://www.youtube.com/watch?v=videoA',
              thumbnail: 'https://i.ytimg.com/vi/videoA/default.jpg'
            },
            { id: 'videoB', title: 'Second', url: 'https://cdn.example/videoB', duration: 42 },
            { id: 'bad', title: 'Unsafe', webpage_url: 'file:///tmp/nope' }
          ]
        })
      })

      const result = await resolvePlaylist('https://www.youtube.com/playlist?list=collection')

      expect(capturedArgs).toContain('--flat-playlist')
      expect(capturedArgs).not.toContain('--no-playlist')
      expect(result.title).toBe('Collection')
      expect(result.entries).toHaveLength(2)
      expect(result.entries[0]).toMatchObject({
        id: 'videoA',
        title: 'First',
        sourceKey: 'youtube:videoA',
        thumbnailUrl: 'https://i.ytimg.com/vi/videoA/default.jpg',
        alreadyDownloaded: false
      })
      expect(result.entries[1]?.durationSeconds).toBe(42)
      expect(result.truncated).toBe(false)
    })
  })

  it('rejects a non-http page URL without calling the runner', async () => {
    let called = false
    setVideoResolverForTests(async () => {
      called = true
      return '{}'
    })
    await expect(resolveVideo('ftp://example.com/file', 'video')).rejects.toThrow(/page URL/)
    expect(called).toBe(false)
  })

  it('requires a configured binary outside tests (no silent PATH drift)', async () => {
    await expect(resolveVideo('https://example.com/watch?v=1', 'video', {})).rejects.toThrow(
      /not ready yet/
    )
  })
})
