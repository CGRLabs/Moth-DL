import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildYtDlpDownloadArgs,
  ensureYtDlpWorkDirectory,
  isYouTubePage,
  normalizeReportedPath,
  parseYtDlpOutputPath,
  parseYtDlpProgressLine,
  readFragmentKey,
  resolveYtDlpOutput,
  workDirHasFragments,
  writeFragmentKey,
  ytDlpFragmentKey,
  YtDlpProgressAccumulator
} from '../../src/main/video/download.js'

const options = {
  binaryPath: 'yt-dlp.exe',
  ffmpegPath: 'ffmpeg.exe',
  pageUrl: 'https://www.youtube.com/watch?v=abc123',
  format: 'video' as const,
  videoQuality: 720 as const,
  audioFormat: 'mp3' as const,
  headers: {},
  workDir: 'C:\\temp\\media',
  speedLimit: null,
  ytDlpVersion: '2026.09.26'
}

describe('yt-dlp transfer setup', () => {
  it('parses progress templates with yt-dlp’s console prefix', () => {
    expect(parseYtDlpProgressLine('[download] MOTH_PROGRESS\t1024\t8192\tNA\t512\t14')).toEqual({
      filename: null,
      downloadedBytes: 1024,
      totalBytes: 8192,
      speed: 512,
      eta: 14
    })
  })

  it('parses progress templates without a known total size', () => {
    expect(parseYtDlpProgressLine('MOTH_PROGRESS\t1024\tNA\tNA\tNA\tNA')).toEqual({
      filename: null,
      downloadedBytes: 1024,
      totalBytes: null,
      speed: 0,
      eta: null
    })
  })

  it('parses the new filename-prefixed progress template', () => {
    expect(
      parseYtDlpProgressLine('MOTH_PROGRESS\tmedia.f308.mp4\t1024\t8192\tNA\t512\t14')
    ).toEqual({
      filename: 'media.f308.mp4',
      downloadedBytes: 1024,
      totalBytes: 8192,
      speed: 512,
      eta: 14
    })
  })

  it('strips extended-length prefixes from reported output paths', () => {
    expect(normalizeReportedPath('\\\\?\\C:\\work\\media.mp4')).toBe('C:\\work\\media.mp4')
    expect(normalizeReportedPath('"C:\\work\\media.mp4"')).toBe('C:\\work\\media.mp4')
  })

  it('falls back to the freshest work-dir file when the reported path escapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moth-yt-'))
    try {
      await writeFile(join(dir, 'media.mp4'), Buffer.from('fresh bytes'))
      const resolved = await resolveYtDlpOutput(dir, '\\\\?\\D:\\elsewhere\\media.mp4', Date.now() - 60_000)
      expect(resolved.fellBack).toBe(true)
      expect(resolved.path).toBe(join(dir, 'media.mp4'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects stale files when falling back, with the reported path in the message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moth-yt-'))
    try {
      await writeFile(join(dir, 'media.mp4'), Buffer.from('stale bytes'))
      await expect(resolveYtDlpOutput(dir, 'D:\\elsewhere\\media.mp4', Date.now() + 60_000)).rejects.toThrow(
        /outside its work directory/
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('pins fragment identity so stale partials are detectable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moth-yt-'))
    try {
      expect(await readFragmentKey(dir)).toBeNull()
      expect(await workDirHasFragments(dir)).toBe(false)
      const key = ytDlpFragmentKey(options)
      await writeFragmentKey(dir, key)
      expect(await readFragmentKey(dir)).toBe(key)
      expect(ytDlpFragmentKey({ ...options, videoQuality: 1080 })).not.toBe(key)
      await writeFile(join(dir, 'media.f308.mp4.part'), Buffer.from('stale'))
      expect(await workDirHasFragments(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('pins source, forwarded headers, and yt-dlp version without storing their values', () => {
    const key = ytDlpFragmentKey(options)
    expect(key).not.toContain(options.pageUrl)
    expect(key).not.toContain('SID=secret')
    expect(ytDlpFragmentKey({ ...options, pageUrl: 'https://www.youtube.com/watch?v=other' })).not.toBe(key)
    expect(ytDlpFragmentKey({ ...options, headers: { Cookie: 'SID=secret' } })).not.toBe(key)
    expect(ytDlpFragmentKey({ ...options, ytDlpVersion: '2026.09.27' })).not.toBe(key)
    expect(
      ytDlpFragmentKey({ ...options, headers: { cookie: 'SID=secret' } })
    ).toBe(ytDlpFragmentKey({ ...options, headers: { Cookie: 'SID=secret' } }))
  })

  it('clears partial fragments when the source identity changes and preserves matching resumes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moth-yt-'))
    try {
      await ensureYtDlpWorkDirectory(dir, options)
      const fragment = join(dir, 'media.f308.mp4.part')
      await writeFile(fragment, Buffer.from('partial'))

      await ensureYtDlpWorkDirectory(dir, options)
      expect(await readFile(fragment, 'utf8')).toBe('partial')

      await ensureYtDlpWorkDirectory(dir, {
        ...options,
        headers: { Cookie: 'SID=rotated' }
      })
      await expect(readFile(fragment)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFragmentKey(dir)).toBe(
        ytDlpFragmentKey({ ...options, headers: { Cookie: 'SID=rotated' } })
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sums video+audio files so progress never jumps backwards', () => {
    const acc = new YtDlpProgressAccumulator()
    const base = { id: 'x', fileSize: 0, downloadedBytes: 0, status: 'downloading' } as never
    const first = acc.update(base, {
      filename: 'media.f308.mp4',
      downloadedBytes: 100,
      totalBytes: 100,
      speed: 10,
      eta: 0
    })
    expect(first.event.progress.downloadedBytes).toBe(100)
    const second = acc.update(first.download, {
      filename: 'media.f140.m4a',
      downloadedBytes: 5,
      totalBytes: 50,
      speed: 10,
      eta: 0
    })
    // 100 (video done) + 5 (audio started) — monotonic, total summed.
    expect(second.event.progress.downloadedBytes).toBe(105)
    expect(second.event.progress.fileSize).toBe(150)
  })

  it('extracts the final output path when yt-dlp prefixes it with its download label', () => {
    expect(parseYtDlpOutputPath('[download] Destination: media.webm\n[download] C:\\temp\\media\\clip.mp4\n'))
      .toBe('C:\\temp\\media\\clip.mp4')
  })

  it('recognizes YouTube hosts and rejects lookalike domains', () => {
    expect(isYouTubePage('https://youtube.com/watch?v=abc')).toBe(true)
    expect(isYouTubePage('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isYouTubePage('https://youtu.be/abc')).toBe(true)
    expect(isYouTubePage('https://youtube.com.attacker.example/watch?v=abc')).toBe(false)
    expect(isYouTubePage('https://example.com/watch?v=abc')).toBe(false)
  })

  it('sets the selected height cap, prefers H.264/AAC, and remuxes to MP4', () => {
    const args = buildYtDlpDownloadArgs({ ...options, videoQuality: 2160 })
    const selector = args[args.indexOf('--format') + 1] ?? ''
    expect(selector).toContain('[height<=2160]')
    expect(selector).toContain('vcodec^=avc')
    expect(selector).toContain('acodec^=mp4a')
    expect(args).toContain('--continue')
    expect(args).toContain('--no-playlist')
    expect(args).toContain('--ffmpeg-location')
    expect(args).toContain('--format-sort')
    expect(args).toContain('res,fps,vcodec:avc,acodec:mp4a,ext')
    expect(args).toContain('--remux-video')
    expect(args).toContain('--merge-output-format')
    expect(args).toContain('mp4')
    expect(args).not.toContain('--recode-video')
  })

  it('selects the best audio-only stream and extracts MP3 when requested', () => {
    const args = buildYtDlpDownloadArgs({ ...options, format: 'audio', audioFormat: 'mp3' })
    expect(args).toContain('bestaudio')
    expect(args).toContain('--extract-audio')
    expect(args).toContain('--audio-format')
    expect(args).toContain('--audio-quality')
    expect(args).toContain('0')
    expect(args).not.toContain('--recode-video')
  })

  it('keeps source audio without adding an MP3 conversion', () => {
    const args = buildYtDlpDownloadArgs({ ...options, format: 'audio', audioFormat: 'source' })
    expect(args).toContain('bestaudio')
    expect(args).not.toContain('--extract-audio')
  })

  it('passes rate limits and validated forwarded headers', () => {
    const args = buildYtDlpDownloadArgs({
      ...options,
      speedLimit: 1_000_000,
      headers: { Cookie: 'SID=secret', 'Bad\r\nHeader': 'ignored', Referer: 'https://www.youtube.com/' }
    })
    expect(args).toContain('--limit-rate')
    expect(args).toContain('1000000')
    expect(args).toContain('--add-header')
    expect(args).toContain('Cookie:SID=secret')
    expect(args).not.toContain('Bad\r\nHeader:ignored')
  })
})
