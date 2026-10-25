import { describe, expect, it } from 'vitest'
import { emptyRequestSchema, findDeepLinkInArgv, parseDeepLink } from '../../src/main/protocol/deepLink.js'

const link = (query: string): string => `moth://download?${query}`
const inner = 'https://cdn.example.com/files/clip.mp4'
const enc = encodeURIComponent(inner)

describe('parseDeepLink — valid links', () => {
  it('accepts a minimal link and defaults format to video', () => {
    expect(parseDeepLink(link(`url=${enc}`))).toEqual({ url: inner, format: 'video' })
  })

  it('accepts format=audio', () => {
    expect(parseDeepLink(link(`url=${enc}&format=audio`))).toEqual({ url: inner, format: 'audio' })
  })

  it('accepts format=video explicitly', () => {
    expect(parseDeepLink(link(`url=${enc}&format=video`))).toEqual({ url: inner, format: 'video' })
  })

  it('accepts a supported video quality cap', () => {
    expect(parseDeepLink(link(`url=${enc}&format=video&videoQuality=1080`))).toEqual({
      url: inner,
      format: 'video',
      videoQuality: 1080
    })
  })

  it('normalises format case and surrounding whitespace', () => {
    expect(parseDeepLink(link(`url=${enc}&format=Audio`))).toEqual({ url: inner, format: 'audio' })
    expect(parseDeepLink(link(`url=${enc}&format=%20VIDEO%20`))).toEqual({ url: inner, format: 'video' })
  })

  it('treats an empty format as absent (video)', () => {
    expect(parseDeepLink(link(`url=${enc}&format=`))).toEqual({ url: inner, format: 'video' })
  })

  it('decodes an inner URL that carries its own query string', () => {
    const withQuery = 'https://x.example.com/f?token=abc&n=2'
    const parsed = parseDeepLink(link(`url=${encodeURIComponent(withQuery)}&format=audio`))
    expect(parsed).toEqual({ url: withQuery, format: 'audio' })
  })

  it('accepts plain http inner URLs', () => {
    const http = 'http://mirror.example.com/a.zip'
    expect(parseDeepLink(link(`url=${encodeURIComponent(http)}`))).toEqual({ url: http, format: 'video' })
  })

  it('accepts an unencoded inner URL when it survives query splitting', () => {
    expect(parseDeepLink(`moth://download?url=${inner}&format=audio`)).toEqual({
      url: inner,
      format: 'audio'
    })
  })

  it('accepts the opaque moth:download form (launchers sometimes strip slashes)', () => {
    expect(parseDeepLink(`moth:download?url=${enc}&format=audio`)).toEqual({ url: inner, format: 'audio' })
  })

  it('accepts an uppercase scheme', () => {
    expect(parseDeepLink(`Moth://download?url=${enc}`)).toEqual({ url: inner, format: 'video' })
  })

  it('ignores extra parameters', () => {
    expect(parseDeepLink(link(`url=${enc}&format=audio&ref=popup&x=1`))).toEqual({
      url: inner,
      format: 'audio'
    })
  })

  it('lets the first format win on duplicates', () => {
    expect(parseDeepLink(link(`url=${enc}&format=audio&format=video`))).toEqual({
      url: inner,
      format: 'audio'
    })
  })
})

describe('parseDeepLink — argv input', () => {
  it('picks the moth: entry out of a Windows argv', () => {
    const argv = [
      'C:\\Program Files\\Moth\\Moth.exe',
      link(`url=${enc}&format=audio`)
    ]
    expect(parseDeepLink(argv)).toEqual({ url: inner, format: 'audio' })
  })

  it('picks the moth: entry out of a second-instance argv with flags', () => {
    const argv = ['C:\\app\\Moth.exe', '--some-flag', link(`url=${enc}`), '--']
    expect(parseDeepLink(argv)).toEqual({ url: inner, format: 'video' })
  })

  it('tolerates quoting and surrounding whitespace', () => {
    expect(parseDeepLink([`  "${link(`url=${enc}`)}"  `])).toEqual({ url: inner, format: 'video' })
  })

  it('returns null for an empty argv or one with no moth: entry', () => {
    expect(parseDeepLink([])).toEqual(null)
    expect(parseDeepLink(['C:\\app\\Moth.exe', '--flag'])).toEqual(null)
  })
})

describe('parseDeepLink — rejections', () => {
  it('rejects garbage and non-URLs', () => {
    for (const bad of ['', '   ', 'not a url', 'https://example.com/f.mp4', 'moth://', 'moth:']) {
      expect(parseDeepLink(bad), bad).toEqual(null)
    }
  })

  it('rejects non-string garbage without throwing', () => {
    for (const bad of [null, undefined, 42, {}, true] as unknown as string[]) {
      expect(parseDeepLink(bad)).toEqual(null)
    }
  })

  it('rejects a foreign outer scheme', () => {
    expect(parseDeepLink(`http://download?url=${enc}`)).toEqual(null)
    expect(parseDeepLink(`tirx://download?url=${enc}`)).toEqual(null)
  })

  it('rejects anything but the download path', () => {
    expect(parseDeepLink(`moth://other?url=${enc}`)).toEqual(null)
    expect(parseDeepLink(`moth://download/extra?url=${enc}`)).toEqual(null)
    expect(parseDeepLink(`moth://download:8080?url=${enc}`)).toEqual(null)
    expect(parseDeepLink(`moth://user@download?url=${enc}`)).toEqual(null)
  })

  it('rejects a missing or empty url parameter', () => {
    expect(parseDeepLink('moth://download')).toEqual(null)
    expect(parseDeepLink('moth://download?format=audio')).toEqual(null)
    expect(parseDeepLink('moth://download?url=&format=audio')).toEqual(null)
  })

  it('rejects non-http(s) inner URLs', () => {
    for (const badInner of [
      'file:///C:/secret.txt',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'ftp://files.example.com/a.zip',
      '\\\\server\\share\\f.mp4'
    ]) {
      expect(parseDeepLink(link(`url=${encodeURIComponent(badInner)}`)), badInner).toEqual(null)
    }
  })

  it('rejects a malformed inner URL', () => {
    expect(parseDeepLink(link('url=%3A%2F%2F%5Bbroken'))).toEqual(null)
    expect(parseDeepLink(link('url=just-words'))).toEqual(null)
  })

  it('rejects an unrecognised format rather than guessing', () => {
    expect(parseDeepLink(link(`url=${enc}&format=banana`))).toEqual(null)
    expect(parseDeepLink(link(`url=${enc}&format=vide`))).toEqual(null)
    expect(parseDeepLink(link(`url=${enc}&format=mp3`))).toEqual(null)
  })

  it('rejects unsupported video quality caps', () => {
    expect(parseDeepLink(link(`url=${enc}&format=video&videoQuality=999`))).toEqual(null)
    expect(parseDeepLink(link(`url=${enc}&format=video&videoQuality=1080.5`))).toEqual(null)
  })
})

describe('findDeepLinkInArgv', () => {
  it('returns the first moth: entry', () => {
    const first = link(`url=${enc}`)
    expect(findDeepLinkInArgv(['app.exe', first, link(`url=${enc}&format=audio`)])).toEqual(first)
  })

  it('matches the prefix case-insensitively and strips quotes', () => {
    const found = findDeepLinkInArgv(['app.exe', `"Moth://download?url=${enc}"`])
    expect(found).toEqual(`Moth://download?url=${enc}`)
  })

  it('returns null when no entry matches', () => {
    expect(findDeepLinkInArgv([])).toEqual(null)
    expect(findDeepLinkInArgv(['app.exe', 'https://example.com'])).toEqual(null)
  })
})

describe('emptyRequestSchema', () => {
  it('accepts an absent or empty payload for the no-arg channels', () => {
    expect(emptyRequestSchema.safeParse(undefined).success).toEqual(true)
    expect(emptyRequestSchema.safeParse({}).success).toEqual(true)
  })
})
