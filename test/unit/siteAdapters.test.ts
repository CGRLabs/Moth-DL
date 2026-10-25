import { afterEach, describe, expect, it } from 'vitest'
import { routeSource } from '../../src/main/core/router.js'
import { registerSiteAdapter, resetSiteAdapters, resolveSiteAdapterCandidate } from '../../src/main/core/siteAdapters.js'

describe('site adapter routing', () => {
  afterEach(() => {
    resetSiteAdapters()
  })

  it('keeps YouTube on the yt-dlp route even if a site adapter matches', () => {
    registerSiteAdapter({
      id: 'demo-tiktok',
      name: 'Demo TikTok adapter',
      enabled: true,
      supportedHosts: ['youtube.com'],
      matches: (url) => url.includes('youtube.com'),
      extract: async () => ({ url: 'https://example.com/video.mp4', kind: 'video' }),
      reason: 'demo only'
    })

    expect(routeSource('https://www.youtube.com/watch?v=abc', 'video')).toMatchObject({
      kind: 'youtube-page',
      transport: 'yt-dlp'
    })
  })

  it('uses an enabled site adapter before the generic media-page route', () => {
    registerSiteAdapter({
      id: 'demo-facebook',
      name: 'Demo Facebook adapter',
      enabled: true,
      supportedHosts: ['example.com'],
      matches: (url) => url.includes('example.com'),
      extract: async () => ({ url: 'https://example.com/video.mp4', kind: 'video' }),
      reason: 'demo only'
    })

    expect(routeSource('https://example.com/watch?v=123', 'video')).toMatchObject({
      kind: 'site-adapter',
      transport: 'site-adapter'
    })
  })

  it('keeps unknown hosts on the generic media-page resolver path', () => {
    expect(routeSource('https://example.org/video', 'video')).toMatchObject({
      kind: 'media-page',
      transport: 'resolver'
    })
  })

  it('resolves a candidate from HTML metadata with a social-media-like source', async () => {
    registerSiteAdapter({
      id: 'demo-tiktok-extractor',
      name: 'Demo TikTok extractor',
      enabled: true,
      supportedHosts: ['tiktok.com'],
      matches: (url) => url.includes('tiktok.com'),
      extract: async (url, context) => {
        const html = context?.pageHtml ?? ''
        const match = /https?:\/\/[^\s"'<>]+\.(?:mp4|webm|mkv|mov|avi)(?:\?[^\s"'<>]*)?/i.exec(html)
        return match ? { url: match[0], kind: 'video', headers: { Referer: url } } : null
      },
      reason: 'demo only'
    })

    const candidate = await resolveSiteAdapterCandidate('https://www.tiktok.com/@demo/video/123', {
      pageHtml: '<script>playAddr":"https://cdn.example.com/tiktok-video.mp4"</script>'
    })

    expect(candidate).toMatchObject({
      url: 'https://cdn.example.com/tiktok-video.mp4',
      kind: 'video'
    })
  })
})
