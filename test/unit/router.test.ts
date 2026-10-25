import { describe, expect, it } from 'vitest'
import { classifyProbedResponse, routeSource, routeTransfer } from '../../src/main/core/router.js'

describe('download router', () => {
  it('keeps ordinary URLs on the direct HTTP path unless media resolution was requested', () => {
    expect(routeSource('https://example.com/file.zip')).toMatchObject({
      kind: 'direct-file',
      transport: 'http'
    })
    expect(routeSource('https://example.com/watch', 'video')).toMatchObject({
      kind: 'media-page',
      transport: 'resolver'
    })
  })

  it('routes YouTube media requests to yt-dlp and recognizes supported host aliases', () => {
    for (const url of [
      'https://youtube.com/watch?v=abc',
      'https://www.youtube.com/watch?v=abc',
      'https://music.youtube.com/watch?v=abc',
      'https://youtu.be/abc',
      'https://www.youtube-nocookie.com/embed/abc'
    ]) {
      expect(routeSource(url, 'video')).toMatchObject({
        kind: 'youtube-page',
        transport: 'yt-dlp'
      })
    }
    expect(routeSource('https://youtube.com.evil.example/watch?v=abc', 'video').kind).toBe('media-page')
    expect(routeSource('https://youtube.com/watch?v=abc').kind).toBe('direct-file')
  })

  it('selects parallel ranges when supported and sizes are known', () => {
    expect(routeTransfer({
      size: 1024,
      acceptRanges: true,
      rangeUnsupported: false,
      etag: '"source-v1"',
      lastModified: null
    })).toMatchObject({
      strategy: 'parallel-ranges',
      resumable: true
    })
  })

  it('warns that ranged transfers without a validator are not safely resumable', () => {
    expect(routeTransfer({
      size: 1024,
      acceptRanges: true,
      rangeUnsupported: false,
      etag: null,
      lastModified: null
    })).toMatchObject({
      strategy: 'parallel-ranges',
      resumable: false
    })
  })

  it('does not treat a weak ETag as a safe resume validator', () => {
    expect(routeTransfer({
      size: 1024,
      acceptRanges: true,
      rangeUnsupported: false,
      etag: 'W/"weak-v1"',
      lastModified: null
    })).toMatchObject({
      strategy: 'parallel-ranges',
      resumable: false
    })
  })

  it('chooses sequential transfer when ranges or a positive size are unknown', () => {
    for (const metadata of [
      { size: 1024, acceptRanges: false, rangeUnsupported: true, etag: null, lastModified: null },
      { size: null, acceptRanges: true, rangeUnsupported: false, etag: '"v1"', lastModified: null },
      { size: 0, acceptRanges: true, rangeUnsupported: false, etag: null, lastModified: null }
    ]) {
      expect(routeTransfer(metadata)).toMatchObject({
        strategy: 'single-stream',
        resumable: false
      })
    }
  })
})

describe('classifyProbedResponse', () => {
  it('trusts an attachment disposition over any content type', () => {
    expect(classifyProbedResponse({
      contentType: 'text/html',
      contentDisposition: 'attachment; filename="setup.exe"',
      size: 861_225_552
    })).toBe('direct-file')
  })

  it('treats an HTML document as a media page', () => {
    expect(classifyProbedResponse({
      contentType: 'text/html; charset=utf-8',
      contentDisposition: null,
      size: 51_233
    })).toBe('media-page')
    expect(classifyProbedResponse({
      contentType: 'application/xhtml+xml',
      contentDisposition: null,
      size: null
    })).toBe('media-page')
  })

  it('treats any other declared type, or a bare size, as a file', () => {
    expect(classifyProbedResponse({
      contentType: 'application/octet-stream',
      contentDisposition: null,
      size: 861_225_552
    })).toBe('direct-file')
    expect(classifyProbedResponse({
      contentType: null,
      contentDisposition: null,
      size: 4096
    })).toBe('direct-file')
  })

  it('reports undetermined instead of guessing when the response says nothing', () => {
    expect(classifyProbedResponse({
      contentType: null,
      contentDisposition: null,
      size: null
    })).toBe('undetermined')
    expect(classifyProbedResponse({
      contentType: null,
      contentDisposition: null,
      size: 0
    })).toBe('undetermined')
  })
})
