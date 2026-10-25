import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadContentHelpers } from './loadContentHelpers.mjs'

const {
  isGrabbableUrl,
  mediaKindForUrl,
  mediaElementsIn,
  collectVariants,
  discoverPageMedia,
  discoverExperimentalSiteHints,
  captureFormatOptions,
  buildDeepLink
} = loadContentHelpers()

function anchor(href) {
  return { href, getAttribute(name) { return name === 'href' ? href : null } }
}

describe('isGrabbableUrl', () => {
  it('rejects blob:, data:, file:, javascript: and empty strings', () => {
    assert.equal(isGrabbableUrl('blob:https://e.com/9c9c9c9c'), false)
    assert.equal(isGrabbableUrl('data:audio/mp3;base64,AAA='), false)
    assert.equal(isGrabbableUrl('file:///C:/music/song.mp3'), false)
    assert.equal(isGrabbableUrl('javascript:play()'), false)
    assert.equal(isGrabbableUrl(''), false)
    assert.equal(isGrabbableUrl('   '), false)
    assert.equal(isGrabbableUrl(null), false)
    assert.equal(isGrabbableUrl(undefined), false)
  })

  it('accepts http and https', () => {
    assert.equal(isGrabbableUrl('http://e.com/song.mp3'), true)
    assert.equal(isGrabbableUrl('https://e.com:8443/v/a.mp4?t=1#h'), true)
    assert.equal(isGrabbableUrl('  https://e.com/song.mp3  '), true)
  })
})

describe('mediaKindForUrl', () => {
  it('classifies every video extension', () => {
    for (const ext of ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'flv', 'avi']) {
      assert.equal(mediaKindForUrl(`https://e.com/v.${ext}`), 'video', ext)
    }
  })

  it('classifies every audio extension', () => {
    for (const ext of ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus', 'aac', 'm4b']) {
      assert.equal(mediaKindForUrl(`https://e.com/a.${ext}`), 'audio', ext)
    }
  })

  it('handles case, queries and non-media URLs', () => {
    assert.equal(mediaKindForUrl('https://e.com/A.MP3?dl=1'), 'audio')
    assert.equal(mediaKindForUrl('https://e.com/page.html'), null)
    assert.equal(mediaKindForUrl('https://e.com/photo.jpg'), null)
    assert.equal(mediaKindForUrl('https://e.com/noext'), null)
    assert.equal(mediaKindForUrl('blob:https://e.com/x'), null)
    assert.equal(mediaKindForUrl(''), null)
  })
})

describe('mediaElementsIn', () => {
  it('collects video, audio and media links only', () => {
    const video = { tagName: 'VIDEO' }
    const audio = { tagName: 'AUDIO' }
    const root = {
      querySelectorAll(sel) {
        if (sel === 'video') return [video]
        if (sel === 'audio') return [audio]
        if (sel === 'a[href]') {
          return [anchor('https://e.com/song.mp3'), anchor('https://e.com/page.html'), anchor('https://e.com/clip.webm')]
        }
        return []
      }
    }
    const found = mediaElementsIn(root)
    assert.ok(found.includes(video))
    assert.ok(found.includes(audio))
    assert.equal(found.length, 4)
  })

  it('returns [] for unusable roots', () => {
    assert.deepEqual(mediaElementsIn(null), [])
    assert.deepEqual(mediaElementsIn({}), [])
  })
})

function source(src, attrs = {}) {
  return {
    getAttribute(name) {
      if (name === 'src') return src
      return Object.hasOwn(attrs, name) ? attrs[name] : null
    }
  }
}

function video({ currentSrc = '', src = '', sources = [] } = {}) {
  return {
    tagName: 'VIDEO',
    currentSrc,
    src,
    querySelectorAll(sel) { return sel === 'source' ? sources : [] }
  }
}

describe('collectVariants', () => {
  it('lists every discrete file, playing source first and flagged', () => {
    const element = video({
      currentSrc: 'https://e.com/v-720.mp4',
      sources: [
        source('https://e.com/v-720.mp4'),
        source('https://e.com/v-1080.mp4', { label: '1080p' })
      ]
    })
    const variants = collectVariants(element)
    assert.equal(variants.length, 2)
    assert.equal(variants[0].url, 'https://e.com/v-720.mp4')
    assert.equal(variants[0].isCurrent, true)
    assert.equal(variants[1].url, 'https://e.com/v-1080.mp4')
    assert.equal(variants[1].label, '1080p')
    assert.equal(variants[1].isCurrent, false)
  })

  it('dedupes currentSrc, src and repeated sources', () => {
    const element = video({
      currentSrc: 'https://e.com/a.mp4',
      src: 'https://e.com/a.mp4',
      sources: [source('https://e.com/a.mp4'), source('https://e.com/a.mp4')]
    })
    const variants = collectVariants(element)
    assert.equal(variants.length, 1)
    assert.equal(variants[0].isCurrent, true)
  })

  it('filters blob:, playlists and unknown extensions', () => {
    const element = video({
      currentSrc: 'blob:https://e.com/9c9c',
      sources: [
        source('https://e.com/stream.m3u8'),
        source('https://e.com/page.html'),
        source('https://e.com/real.webm')
      ]
    })
    const variants = collectVariants(element)
    assert.equal(variants.length, 1)
    assert.equal(variants[0].url, 'https://e.com/real.webm')
    assert.equal(variants[0].isCurrent, false)
  })

  it('resolves relative sources against the base, skipping them without one', () => {
    const element = video({ sources: [source('/v/clip.mp4')] })
    assert.deepEqual(collectVariants(element), [])
    const resolved = collectVariants(element, 'https://e.com/watch')
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].url, 'https://e.com/v/clip.mp4')
  })

  it('prefers author labels, falling back to the filename', () => {
    const element = video({
      sources: [
        source('https://e.com/a.mp4', { 'data-quality': '720p' }),
        source('https://e.com/b.mp4', { title: 'Director cut' }),
        source('https://e.com/nice-name.mp4')
      ]
    })
    const variants = collectVariants(element)
    assert.equal(variants[0].label, '720p')
    assert.equal(variants[1].label, 'Director cut')
    assert.equal(variants[2].label, 'nice-name.mp4')
  })

  it('returns [] for anchors, audio stubs and hostile shapes', () => {
    assert.deepEqual(collectVariants({ tagName: 'A', href: 'https://e.com/a.mp3' }), [])
    assert.deepEqual(collectVariants(null), [])
    assert.deepEqual(collectVariants({}), [])
    assert.deepEqual(collectVariants(video()), [])
    const hostile = video({ currentSrc: 'https://e.com/a.mp4' })
    hostile.querySelectorAll = () => { throw new Error('nope') }
    const variants = collectVariants(hostile)
    assert.equal(variants.length, 1)
    assert.equal(variants[0].url, 'https://e.com/a.mp4')
  })

  it('yields nothing grabbable for MSE/blob playback (format-picker territory)', () => {
    assert.deepEqual(collectVariants(video({ currentSrc: 'blob:https://e.com/9c9c' })), [])
  })
})

describe('discoverPageMedia', () => {
  it('finds direct media, extensionless active streams, and page-resolver signals', () => {
    const videoElement = video({
      currentSrc: 'https://cdn.example/media?id=1',
      sources: [source('https://cdn.example/clip.mp4'), source('https://cdn.example/live.m3u8')]
    })
    const root = {
      querySelectorAll(selector) {
        if (selector === 'video') return [videoElement]
        if (selector === 'audio') return []
        if (selector === 'a[href]') return [anchor('https://cdn.example/song.mp3')]
        return []
      }
    }
    const result = discoverPageMedia(root, 'https://example.com/watch', [
      { name: 'https://cdn.example/another.webm', initiatorType: 'fetch' },
      { name: 'https://cdn.example/manifest.mpd', initiatorType: 'xmlhttprequest' }
    ])
    assert.equal(result.hasMediaSignal, true)
    assert.deepEqual(result.candidates.map((candidate) => candidate.url), [
      'https://cdn.example/media?id=1',
      'https://cdn.example/clip.mp4',
      'https://cdn.example/song.mp3',
      'https://cdn.example/another.webm'
    ])
    assert.equal(result.candidates.some((candidate) => candidate.url.endsWith('.m3u8')), false)
  })

  it('does not include non-HTTP sources or claim an empty page has media', () => {
    const root = {
      querySelectorAll() { return [] }
    }
    assert.deepEqual(discoverPageMedia(root, 'https://example.com', []), {
      candidates: [],
      hasMediaSignal: false
    })
    assert.deepEqual(discoverPageMedia(null, 'https://example.com'), {
      candidates: [],
      hasMediaSignal: false
    })
  })
})

describe('discoverExperimentalSiteHints', () => {
  it('detects experimental social-video hosts and preserves the candidate list', () => {
    const root = {
      location: { href: 'https://www.tiktok.com/@example/video/123' },
      querySelectorAll(selector) {
        if (selector === 'video') return [{ currentSrc: 'https://cdn.example.com/tiktok.mp4' }]
        if (selector === 'audio') return []
        if (selector === 'a[href]') return []
        return []
      }
    }

    const result = discoverExperimentalSiteHints(root, 'https://www.tiktok.com/@example/video/123')
    assert.equal(result.hasExperimentalSignal, true)
    assert.equal(result.adapters[0].site, 'tiktok')
    assert.equal(result.adapters[0].enabled, false)
    assert.equal(result.adapters[0].candidates[0].url, 'https://cdn.example.com/tiktok.mp4')
  })

  it('returns nothing for unsupported hosts', () => {
    const root = {
      location: { href: 'https://example.com/notes' },
      querySelectorAll() { return [] }
    }
    assert.deepEqual(discoverExperimentalSiteHints(root, 'https://example.com/notes'), {
      adapters: [],
      hasExperimentalSignal: false
    })
  })
})

describe('captureFormatOptions', () => {
  it('offers supported video quality caps and MP3 with generic labels', () => {
    assert.deepEqual(captureFormatOptions(), [
      { format: 'video', videoQuality: 360, kind: '360p', label: 'Video · up to 360p' },
      { format: 'video', videoQuality: 480, kind: '480p', label: 'Video · up to 480p' },
      { format: 'video', videoQuality: 720, kind: '720p', label: 'Video · up to 720p' },
      { format: 'video', videoQuality: 1080, kind: '1080p', label: 'Video · up to 1080p' },
      { format: 'video', videoQuality: 1440, kind: '1440p', label: 'Video · up to 1440p' },
      { format: 'video', videoQuality: 2160, kind: '2160p', label: 'Video · up to 2160p' },
      { format: 'audio', kind: 'MP3', label: 'Audio (MP3)' }
    ])
  })
})

describe('buildDeepLink', () => {
  it('encodes the page URL and appends a known format', () => {
    assert.equal(
      buildDeepLink('https://e.com/watch?v=1&x=y', 'video'),
      `moth://download?url=${encodeURIComponent('https://e.com/watch?v=1&x=y')}&format=video`
    )
    assert.equal(
      buildDeepLink('https://e.com/a', 'audio'),
      `moth://download?url=${encodeURIComponent('https://e.com/a')}&format=audio`
    )
  })

  it('includes a selected video quality cap in a cold-start link', () => {
    const link = buildDeepLink('https://e.com/watch?v=1', 'video', 1080)
    assert.equal(
      link,
      `moth://download?url=${encodeURIComponent('https://e.com/watch?v=1')}&format=video&videoQuality=1080`
    )
    assert.equal(buildDeepLink('https://e.com/watch', 'video', 999), `moth://download?url=${encodeURIComponent('https://e.com/watch')}&format=video`)
  })

  it('omits unknown formats and rejects empty URLs', () => {
    assert.equal(buildDeepLink('https://e.com/a', 'hd'), `moth://download?url=${encodeURIComponent('https://e.com/a')}`)
    assert.equal(buildDeepLink('https://e.com/a'), `moth://download?url=${encodeURIComponent('https://e.com/a')}`)
    assert.equal(buildDeepLink('', 'video'), '')
    assert.equal(buildDeepLink(null), '')
  })
})
