/**
 * Contract tests for the frozen cross-stream `format` field plus the helper
 * settings keys and the pure video helpers. No network, no binaries.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { MP3_VBR_QUALITY, VIDEO_MAX_HEIGHT } from '../../src/shared/constants.js'
import {
  addDownloadSchema,
  ingestRequestSchema,
  settingsPatchSchema,
  videoFormatSchema,
  videoQualitySchema
} from '../../src/shared/schemas.js'
import { validateIngestRequest } from '../../src/main/ingest/server.js'
import { ffmpegAssetFor, ytDlpAssetFor } from '../../src/main/video/constants.js'
import {
  StubHelperUpdateChecker,
  ensureFfmpegHelper,
  ensureYtDlpHelper,
  promptOnBreakageMessage,
  resolveBinDir
} from '../../src/main/video/helpers.js'
import { buildFfmpegArgs, buildFfmpegMuxArgs, withMp3Extension, withVideoExtension } from '../../src/main/video/transcode.js'

let helperTestDir: string | null = null

afterEach(async () => {
  vi.unstubAllGlobals()
  if (helperTestDir) await rm(helperTestDir, { recursive: true, force: true })
  helperTestDir = null
})

describe('videoFormatSchema', () => {
  it('accepts video and audio only', () => {
    expect(videoFormatSchema.safeParse('video').success).toBe(true)
    expect(videoFormatSchema.safeParse('audio').success).toBe(true)
    expect(videoFormatSchema.safeParse('mp3').success).toBe(false)
    expect(videoFormatSchema.safeParse('YouTube').success).toBe(false)
    expect(videoFormatSchema.safeParse('').success).toBe(false)
  })
})

describe('videoQualitySchema', () => {
  it.each([360, 480, 720, 1080, 1440, 2160])('accepts %i', (quality) => {
    expect(videoQualitySchema.safeParse(quality).success).toBe(true)
  })

  it('rejects unsupported caps', () => {
    expect(videoQualitySchema.safeParse(4320).success).toBe(false)
  })
})

describe('addDownloadSchema format', () => {
  it('absent format stays absent (legacy direct-file path)', () => {
    const out = addDownloadSchema.parse({ url: 'https://example.com/file.zip' })
    expect(out.format).toBeUndefined()
  })

  it('accepts video and audio', () => {
    expect(
      addDownloadSchema.parse({ url: 'https://example.com/w?v=1', format: 'video' }).format
    ).toBe('video')
    expect(
      addDownloadSchema.parse({ url: 'https://example.com/w?v=1', format: 'audio' }).format
    ).toBe('audio')
  })

  it('rejects an invalid format', () => {
    expect(
      addDownloadSchema.safeParse({ url: 'https://example.com/w?v=1', format: 'mp3' }).success
    ).toBe(false)
  })

  it('validates a selected video quality cap', () => {
    expect(addDownloadSchema.parse({ url: 'https://example.com/w?v=1', videoQuality: 480 }).videoQuality).toBe(480)
    expect(addDownloadSchema.safeParse({ url: 'https://example.com/w?v=1', videoQuality: 4320 }).success).toBe(false)
  })

  it('validates subtitle language selection bounds and syntax', () => {
    expect(addDownloadSchema.parse({
      url: 'https://example.com/watch?v=1',
      subtitleLanguages: ['en', 'es-419']
    }).subtitleLanguages).toEqual(['en', 'es-419'])
    expect(addDownloadSchema.safeParse({
      url: 'https://example.com/watch?v=1',
      subtitleLanguages: ['../../outside']
    }).success).toBe(false)
  })

  it('validates media filename templates without allowing path injection', () => {
    expect(addDownloadSchema.parse({
      url: 'https://example.com/watch?v=1',
      namingTemplate: '{title} - {host}.{ext}'
    }).namingTemplate).toBe('{title} - {host}.{ext}')
    expect(addDownloadSchema.safeParse({
      url: 'https://example.com/watch?v=1',
      namingTemplate: '../{title}.{ext}'
    }).success).toBe(false)
    expect(addDownloadSchema.safeParse({
      url: 'https://example.com/watch?v=1',
      namingTemplate: '{unknown}.{ext}'
    }).success).toBe(false)
  })
})

describe('ingestRequestSchema format', () => {
  it('absent means video-compat (undefined, backward compatible)', () => {
    const out = ingestRequestSchema.parse({ url: 'https://example.com/watch?v=1' })
    expect(out.format).toBeUndefined()
  })

  it('accepts explicit video/audio', () => {
    expect(
      ingestRequestSchema.parse({ url: 'https://example.com/w?v=1', format: 'audio' }).format
    ).toBe('audio')
  })

  it('accepts a selected video quality cap', () => {
    expect(ingestRequestSchema.parse({ url: 'https://example.com/w?v=1', videoQuality: 1080 }).videoQuality).toBe(1080)
  })

  it('accepts an audio output choice', () => {
    expect(ingestRequestSchema.parse({ url: 'https://example.com/w?v=1', audioFormat: 'source' }).audioFormat).toBe(
      'source'
    )
    expect(ingestRequestSchema.safeParse({ url: 'https://example.com/w?v=1', audioFormat: 'wav' }).success).toBe(
      false
    )
  })

  it('rejects garbage', () => {
    expect(
      ingestRequestSchema.safeParse({ url: 'https://example.com/w?v=1', format: '4k' }).success
    ).toBe(false)
  })
})

describe('validateIngestRequest format (server.ts)', () => {
  it('passes video/audio through', () => {
    expect(
      validateIngestRequest({ url: 'https://example.com/w?v=1', format: 'video' }).format
    ).toBe('video')
    expect(
      validateIngestRequest({ url: 'https://example.com/w?v=1', format: 'audio' }).format
    ).toBe('audio')
  })

  it('absent stays absent', () => {
    expect(validateIngestRequest({ url: 'https://example.com/w?v=1' }).format).toBeUndefined()
  })

  it('invalid throws (the endpoint maps this to a 400)', () => {
    expect(() => validateIngestRequest({ url: 'https://example.com/w?v=1', format: 'mp3' })).toThrow(
      /Invalid "format"/
    )
  })

  it('passes supported video quality caps and rejects an unsupported one', () => {
    for (const videoQuality of [360, 480, 720, 1080, 1440, 2160]) {
      expect(validateIngestRequest({ url: 'https://example.com/w?v=1', videoQuality }).videoQuality).toBe(
        videoQuality
      )
    }
    expect(() => validateIngestRequest({ url: 'https://example.com/w?v=1', videoQuality: 1000 })).toThrow(
      /Invalid "videoQuality"/
    )
  })

  it('passes through supported audio output choices and rejects invalid ones', () => {
    expect(validateIngestRequest({ url: 'https://example.com/w?v=1', audioFormat: 'source' }).audioFormat).toBe(
      'source'
    )
    expect(() => validateIngestRequest({ url: 'https://example.com/w?v=1', audioFormat: 'wav' })).toThrow(
      /Invalid "audioFormat"/
    )
  })
})

describe('helper settings keys', () => {
  it('accepts helperDir + pinned versions', () => {
    const out = settingsPatchSchema.parse({
      helperDir: 'C:\\ProgramData\\Moth\\bin',
      ytDlpVersion: '2026.08.01',
      ffmpegVersion: '7.1'
    })
    expect(out.helperDir).toBe('C:\\ProgramData\\Moth\\bin')
    expect(out.ytDlpVersion).toBe('2026.08.01')
    expect(out.ffmpegVersion).toBe('7.1')
  })

  it('rejects version labels with path separators', () => {
    expect(settingsPatchSchema.safeParse({ ytDlpVersion: '../../evil' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ ffmpegVersion: '' }).success).toBe(false)
  })
})

describe('helper asset constants', () => {
  it('pins the resolver per OS with the version in the URL', () => {
    expect(ytDlpAssetFor('win32', '2026.08.01').fileName).toBe('yt-dlp.exe')
    expect(ytDlpAssetFor('darwin', '2026.08.01').fileName).toBe('yt-dlp_macos')
    expect(ytDlpAssetFor('linux', '2026.08.01').fileName).toBe('yt-dlp')
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(ytDlpAssetFor(platform, '2026.08.01').url).toContain('2026.08.01')
    }
  })

  describe('lazy media helpers', () => {
    it('fetches only yt-dlp during page resolution setup', async () => {
      helperTestDir = await mkdtemp(join(tmpdir(), 'moth-helper-test-'))
      const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await ensureYtDlpHelper({
        userDataDir: helperTestDir,
        ytDlpVersion: 'test',
        ffmpegVersion: 'test',
        platform: 'win32'
      })

      expect(result.ytDlpPath).toBe(join(helperTestDir, 'bin', 'yt-dlp.exe'))
      expect(await readFile(result.ytDlpPath)).toEqual(Buffer.from([1, 2, 3]))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('yt-dlp.exe')
    })

    const ffmpegBinary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    const systemFfmpegPath = (process.env.PATH ?? '')
      .split(delimiter)
      .map((directory) => join(directory, ffmpegBinary))
      .find((candidate) => existsSync(candidate))

    it.skipIf(!systemFfmpegPath)('uses a working FFmpeg from PATH instead of fetching an archive', async () => {
      helperTestDir = await mkdtemp(join(tmpdir(), 'moth-system-ffmpeg-test-'))
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await ensureFfmpegHelper({
        userDataDir: helperTestDir,
        ytDlpVersion: 'test',
        ffmpegVersion: 'test'
      })

      expect(result.ffmpegPath).toBe(systemFfmpegPath)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  it('uses official transcoder builds with a named binary', () => {
    expect(ffmpegAssetFor('win32', '7.1').binaryName).toBe('ffmpeg.exe')
    expect(ffmpegAssetFor('darwin', '7.1').binaryName).toBe('ffmpeg')
    expect(ffmpegAssetFor('linux', '7.1').binaryName).toBe('ffmpeg')
  })

  it('slice 1 policy constants', () => {
    expect(VIDEO_MAX_HEIGHT).toBe(720)
    expect(MP3_VBR_QUALITY).toBe('2')
  })
})

describe('resolveBinDir', () => {
  it('defaults under user-data', () => {
    const dir = resolveBinDir('/tmp/moth-userdata')
    expect(dir.endsWith('bin')).toBe(true)
  })

  it('accepts an absolute override and rejects a relative one', () => {
    expect(resolveBinDir('/tmp/u', '/opt/moth/bin')).toBeTruthy()
    expect(() => resolveBinDir('/tmp/u', 'relative/bin')).toThrow(/absolute/)
  })
})

describe('transcode helpers (pure)', () => {
  it('builds a single-pass libmp3lame VBR command', () => {
    const args = buildFfmpegArgs('/tmp/in.m4a', '/tmp/out.mp3.mothconvert', '2')
    expect(args).toEqual([
      '-y',
      '-i',
      '/tmp/in.m4a',
      '-vn',
      '-map',
      '0:a:0',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '2',
      '-f',
      'mp3',
      '/tmp/out.mp3.mothconvert'
    ])
    // One input, one encode — never a copy-then-encode chain.
    expect(args.filter((a) => a === '-i')).toHaveLength(1)
  })

  it('forces .mp3 file names', () => {
    expect(withMp3Extension('song.m4a')).toBe('song.mp3')
    expect(withMp3Extension('song.mp3')).toBe('song.mp3')
    expect(withMp3Extension('noext')).toBe('noext.mp3')
  })

  it('builds a stream-copy mux command with separate video and audio inputs', () => {
    const args = buildFfmpegMuxArgs(
      '/tmp/video.mp4',
      'https://cdn.example/audio.m4a?sig=secret',
      '/tmp/output.mp4.mothmerge',
      'mp4',
      { Cookie: 'session=value', Referer: 'https://example.com/watch', 'User-Agent': 'Moth/1' }
    )
    expect(args).toContain('/tmp/video.mp4')
    expect(args).toContain('https://cdn.example/audio.m4a?sig=secret')
    expect(args).toContain('0:v:0')
    expect(args).toContain('1:a:0')
    expect(args).toContain('copy')
    expect(args).toContain('+faststart')
    expect(args).toContain('-f')
    expect(args).toContain('mp4')
    expect(args).toContain('Cookie: session=value\r\nReferer: https://example.com/watch\r\nUser-Agent: Moth/1\r\n')
    expect(args.join(' ')).not.toContain('cookies-from-browser')
  })

  it('drops injected newlines from forwarded mux headers', () => {
    const args = buildFfmpegMuxArgs(
      '/tmp/video.webm',
      'https://cdn.example/audio.webm',
      '/tmp/output.webm.mothmerge',
      'webm',
      { cookie: 'a=b\r\nOther: injected' }
    )
    expect(args).not.toContain('-headers')
    expect(args).not.toContain('Other: injected')
    expect(withVideoExtension('clip.mp4', 'mkv')).toBe('clip.mkv')
  })
})

describe('updater stub (policy UI out of scope)', () => {
  it('reports no update and keeps the breakage prompt generic', async () => {
    const checker = new StubHelperUpdateChecker()
    await expect(
      checker.checkForUpdates({ ytDlpVersion: '2026.08.01', ffmpegVersion: '7.1' })
    ).resolves.toEqual({ updateAvailable: false, latestVersion: null })
    expect(promptOnBreakageMessage().toLowerCase()).not.toContain('youtube')
  })
})
