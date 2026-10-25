/**
 * URL-first preview: instant classification + probed file card.
 * The probe half runs against the local test HTTP server — no internet.
 */

import { describe, expect, it } from 'vitest'
import { classifyUrl, hostOf, previewUrl } from '../../src/main/core/preview.js'
import { previewDownloadSchema } from '../../src/shared/schemas.js'
import { startTestServer } from '../helpers/testServer.js'

describe('classifyUrl (pure, no network)', () => {
  it('treats watch pages as pages', () => {
    expect(classifyUrl('https://www.youtube.com/watch?v=abc12345678')).toBe('page')
    expect(classifyUrl('https://youtu.be/abc12345678')).toBe('page')
    expect(classifyUrl('https://vimeo.com/123456')).toBe('page')
    expect(classifyUrl('https://music.youtube.com/watch?v=abc12345678')).toBe('page')
  })

  it('treats files with known extensions as direct', () => {
    expect(classifyUrl('https://example.com/big-file.zip')).toBe('direct')
    expect(classifyUrl('https://example.com/movie.mp4?token=abc')).toBe('direct')
    expect(classifyUrl('https://example.com/song.mp3#t=10')).toBe('direct')
  })

  it('treats extension-less non-page URLs as pages (offer the choice)', () => {
    expect(classifyUrl('https://example.com/some/article')).toBe('page')
    expect(classifyUrl('https://example.com/')).toBe('page')
  })

  it('never throws for garbage', () => {
    expect(classifyUrl('not a url')).toBe('direct')
    expect(classifyUrl('')).toBe('direct')
  })
})

describe('hostOf', () => {
  it('lowercases the host', () => {
    expect(hostOf('https://Example.COM/x.zip')).toBe('example.com')
  })

  it('returns empty for garbage', () => {
    expect(hostOf('nope')).toBe('')
  })
})

describe('previewDownloadSchema', () => {
  it('accepts http(s) and rejects the rest', () => {
    expect(previewDownloadSchema.safeParse({ url: 'https://example.com/a.zip' }).success).toBe(true)
    expect(previewDownloadSchema.safeParse({ url: 'ftp://example.com/a.zip' }).success).toBe(false)
    expect(previewDownloadSchema.safeParse({}).success).toBe(false)
  })
})

describe('previewUrl', () => {
  it('probes a direct file for name, size and resumability', async () => {
    const server = await startTestServer()
    try {
      const result = await previewUrl(server.url)
      expect(result.kind).toBe('direct')
      expect(result.filename).toBe('file.bin')
      expect(result.fileSize).toBeGreaterThan(0)
      expect(result.acceptRanges).toBe(true)
      expect(result.undetermined).toBe(false)
      expect(result.host).toBe('127.0.0.1')
    } finally {
      await server.close()
    }
  })

  it('returns undetermined instead of throwing when the server is gone', async () => {
    const result = await previewUrl('http://127.0.0.1:1/nope.bin')
    expect(result.kind).toBe('direct')
    expect(result.undetermined).toBe(true)
    expect(result.fileSize).toBeNull()
  })

  it('skips the probe for pages (resolver runs after Add)', async () => {
    const result = await previewUrl('https://www.youtube.com/watch?v=abc12345678')
    expect(result.kind).toBe('page')
    expect(result.undetermined).toBe(true)
    expect(result.category).toBe('video')
  })

  it('probes an extension-less unknown host and finds the file it redirects to', async () => {
    const server = await startTestServer()
    try {
      // The URL text says nothing; the response says "file".
      const downloadUrl = server.url.replace('/file.bin', '/r2/download')
      expect(classifyUrl(downloadUrl)).toBe('page')
      const result = await previewUrl(downloadUrl)
      expect(result.kind).toBe('direct')
      expect(result.filename).toBe('file.bin')
      expect(result.fileSize).toBeGreaterThan(0)
      expect(result.acceptRanges).toBe(true)
      expect(result.resumeSupport).toBe('safe')
    } finally {
      await server.close()
    }
  })

  it('keeps offering the media choice when the response is an HTML page', async () => {
    const server = await startTestServer({ htmlPaths: ['/watch'] })
    try {
      const result = await previewUrl(server.url.replace('/file.bin', '/watch/clip'))
      expect(result.kind).toBe('page')
      expect(result.category).toBe('video')
    } finally {
      await server.close()
    }
  })

  it('throws for non-http URLs', async () => {
    await expect(previewUrl('ftp://example.com/a.zip')).rejects.toThrow()
  })
})
