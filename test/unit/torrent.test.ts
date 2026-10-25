import { describe, expect, it } from 'vitest'
import { routeSource } from '../../src/main/core/router.js'
import {
  isImportedTorrentFileUri,
  isTorrentFileUrl,
  parseMagnetUri
} from '../../src/shared/torrent.js'
import { addDownloadSchema } from '../../src/shared/schemas.js'

const hexHash = '0123456789abcdef0123456789abcdef01234567'

describe('BitTorrent source links', () => {
  it('normalizes hexadecimal info hashes and preserves an optional name', () => {
    expect(parseMagnetUri(`magnet:?xt=urn:btih:${hexHash.toUpperCase()}&dn=Example`)).toEqual({
      uri: `magnet:?xt=urn:btih:${hexHash.toUpperCase()}&dn=Example`,
      infoHash: hexHash,
      v1InfoHash: hexHash,
      v2InfoHash: null,
      displayName: 'Example'
    })
  })

  it('decodes base32 info hashes to the same canonical hexadecimal form', () => {
    expect(parseMagnetUri(`magnet:?xt=urn:btih:${'a'.repeat(32)}`)?.infoHash).toBe('0'.repeat(40))
  })

  it('accepts v2 SHA-256 multihashes and hybrid v1/v2 magnets', () => {
    const v2Hash = 'ab'.repeat(32)
    expect(parseMagnetUri(`magnet:?xt=urn:btmh:1220${v2Hash}`)).toMatchObject({
      infoHash: v2Hash,
      v1InfoHash: null,
      v2InfoHash: v2Hash
    })
    expect(parseMagnetUri('magnet:?xt=urn:btmh:bciqkxk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xky')?.v2InfoHash)
      .toBe(v2Hash)
    expect(parseMagnetUri(`magnet:?xt=urn:btmh:1220${v2Hash}&xt=urn:btih:${hexHash}`)).toMatchObject({
      infoHash: hexHash,
      v1InfoHash: hexHash,
      v2InfoHash: v2Hash
    })
  })

  it('routes .torrent URLs to Transmission without mistaking ordinary HTTP files for torrents', () => {
    const torrentUrl = 'https://tracker.example/releases/show.TORRENT?token=redacted'
    expect(isTorrentFileUrl(torrentUrl)).toBe(true)
    expect(routeSource(torrentUrl)).toMatchObject({ kind: 'torrent', transport: 'transmission' })
    expect(isTorrentFileUrl('https://example.com/file.zip')).toBe(false)
  })

  it('requires metainfo for a locally selected torrent file request', () => {
    const metainfo = 'dGVzdA=='
    const digest = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
    const url = `moth-torrent-file:${digest}`
    expect(isImportedTorrentFileUri(url)).toBe(true)
    expect(addDownloadSchema.safeParse({ url }).success).toBe(false)
    expect(addDownloadSchema.safeParse({ url, torrentMetainfo: metainfo }).success).toBe(true)
    expect(addDownloadSchema.safeParse({
      url: `moth-torrent-file:${'0'.repeat(64)}`,
      torrentMetainfo: metainfo
    }).success).toBe(true)
  })

  it.each([
    'magnet:?xt=urn:btih:short',
    `magnet:?xt=urn:btih:${'0'.repeat(32)}`,
    'magnet:?xt=urn:btmh:1220abcdef',
    `magnet:?xt=urn:btih:${hexHash}${'a'.repeat(5000)}`
  ])('rejects unsupported or malformed links: %s', (uri) => {
    expect(parseMagnetUri(uri)).toBeNull()
    expect(addDownloadSchema.safeParse({ url: uri }).success).toBe(false)
  })

  it('validates magnet links at submission and routes them only to Transmission', () => {
    const uri = `magnet:?xt=urn:btih:${hexHash}`
    expect(addDownloadSchema.parse({ url: uri }).url).toBe(uri)
    expect(routeSource(uri)).toMatchObject({
      kind: 'torrent',
      transport: 'transmission'
    })
    expect(routeSource('https://example.com/file.zip')).toMatchObject({
      kind: 'direct-file',
      transport: 'http'
    })
  })
})
