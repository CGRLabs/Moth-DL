/**
 * ID3 tag round-trip tests.
 *
 * The whole point of these is the failure mode that is easy to get wrong and
 * hard to notice: a tag that writes successfully but reads back wrong, or a file
 * that is subtly corrupted. A corrupted MP3 still plays for a few seconds before
 * desyncing, so it looks fine at first — which is why the writer verifies its own
 * output rather than trusting it.
 */

import { describe, it, expect } from 'vitest'
import { buildId3v2Tag, stripId3v2 } from '../../src/main/media/id3/write.js'
import { parseId3v2 } from '../../src/main/media/id3/read.js'
import { encodeSyncsafe, readSyncsafe } from '../../src/main/media/id3/frame.js'
import { emptyTags } from '@shared/media.js'

const VERSION_2_3 = Buffer.from([
  0x49, 0x44, 0x33, // "ID3"
  0x03, 0x00, // version 2.3, revision 0
  0x00, // flags
  0x00, 0x00, 0x00, 0x00 // size, filled in by the test
])

function buildTag(tags: Parameters<typeof buildId3v2Tag>[0]): Buffer {
  const tag = buildId3v2Tag(tags)
  if (!tag) throw new Error('buildId3v2Tag returned null')
  return tag
}

/** Wraps a tag in a valid ID3v2 header carrying the correct syncsafe size. */
function withHeader(body: Buffer): Buffer {
  const header = Buffer.from(VERSION_2_3)
  encodeSyncsafe(body.length).copy(header, 6)
  return Buffer.concat([header, body])
}

describe('syncsafe integers', () => {
  it('round-trips values below 128', () => {
    for (const value of [0, 1, 127]) {
      expect(readSyncsafe(encodeSyncsafe(value), 0)).toBe(value)
    }
  })

  it('round-trips values that cross the 128-byte boundary', () => {
    // This is where a plain 32-bit write breaks: 128 needs two syncsafe bytes.
    for (const value of [128, 255, 256, 16383, 16384, 2097151]) {
      expect(readSyncsafe(encodeSyncsafe(value), 0)).toBe(value)
    }
  })

  it('never sets the top bit of any byte', () => {
    const encoded = encodeSyncsafe(0x0fffffff)
    for (const byte of encoded) {
      expect(byte & 0x80).toBe(0)
    }
  })
})

describe('buildId3v2Tag', () => {
  it('returns null when there is nothing to write', () => {
    expect(buildId3v2Tag(emptyTags('mp3'))).toBeNull()
  })

  it('writes text fields as v2.3 frames', () => {
    const tag = buildTag({
      ...emptyTags('mp3'),
      title: 'Night Drive',
      artist: 'Kavinsky',
      album: 'OutRun',
      albumArtist: 'Kavinsky',
      year: 2011,
      genre: 'Synthwave',
      track: 3,
      disc: 1
    })

    expect(tag.subarray(0, 3).toString('latin1')).toBe('ID3')
    expect(tag[3]).toBe(3)

    const parsed = parseId3v2(withHeader(tag.subarray(10)))
    expect(parsed.title).toBe('Night Drive')
    expect(parsed.artist).toBe('Kavinsky')
    expect(parsed.album).toBe('OutRun')
    expect(parsed.albumArtist).toBe('Kavinsky')
    expect(parsed.year).toBe(2011)
    expect(parsed.genre).toBe('Synthwave')
    expect(parsed.track).toBe(3)
    expect(parsed.disc).toBe(1)
  })

  it('encodes non-Latin-1 text as UTF-16 with a BOM', () => {
    const tag = buildTag({ ...emptyTags('mp3'), title: '真夜中のドア' })
    const parsed = parseId3v2(withHeader(tag.subarray(10)))
    expect(parsed.title).toBe('真夜中のドア')
  })

  it('writes Latin-1 text without a BOM', () => {
    const tag = buildTag({ ...emptyTags('mp3'), title: 'Café del Mar' })
    const body = tag.subarray(10)
    // The TIT2 frame payload starts with the encoding byte.
    const tit2 = body.indexOf(Buffer.from('TIT2'))
    expect(tit2).toBeGreaterThanOrEqual(0)
    expect(body[tit2 + 10]).toBe(0) // encoding 0 = Latin-1
  })

  it('strips an existing ID3v2 tag rather than stacking', () => {
    const original = Buffer.concat([
      withHeader(buildTag({ ...emptyTags('mp3'), title: 'Old' }).subarray(10)),
      Buffer.from([0xff, 0xfb, 0x90, 0x00]) // fake MPEG frame
    ])

    const stripped = stripId3v2(original)
    expect(stripped.length).toBe(4)
    expect(stripped[0]).toBe(0xff)
  })

  it('leaves a file with no ID3 tag untouched', () => {
    const bare = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00])
    expect(stripId3v2(bare)).toBe(bare)
  })
})

describe('parseId3v2 on hostile input', () => {
  it('returns an all-null result for random bytes', () => {
    const random = Buffer.from(
      Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 0xff)
    )
    const parsed = parseId3v2(new Uint8Array(random))
    expect(parsed.title).toBeNull()
    expect(parsed.artist).toBeNull()
  })

  it('ignores a frame whose size runs past the buffer', () => {
    // A TIT2 frame claiming 1 MB in a 64-byte buffer must be skipped, not
    // trusted.
    const tag = Buffer.alloc(10 + 10 + 4)
    tag.write('ID3', 0, 'latin1')
    tag.writeUInt8(3, 3)
    encodeSyncsafe(4).copy(tag, 6)
    tag.write('TIT2', 10, 'latin1')
    encodeSyncsafe(0x00ffff).copy(tag, 14) // absurd size
    const parsed = parseId3v2(new Uint8Array(tag))
    expect(parsed.title).toBeNull()
  })

  it('does not throw on a truncated header', () => {
    expect(() => parseId3v2(new Uint8Array([0x49, 0x44]))).not.toThrow()
    expect(() => parseId3v2(new Uint8Array(0))).not.toThrow()
  })

  it('reads an APIC frame as artwork', () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04])
    const mime = Buffer.from('image/jpeg\0', 'latin1')
    const description = Buffer.from('\0', 'latin1')
    const payload = Buffer.concat([
      Buffer.from([0]), // encoding
      mime,
      Buffer.from([0x03]), // picture type: front cover
      description,
      image
    ])
    const header = Buffer.alloc(10)
    header.write('APIC', 0, 'latin1')
    encodeSyncsafe(payload.length).copy(header, 4)
    const body = Buffer.concat([header, payload])
    const tag = withHeader(body)

    const parsed = parseId3v2(new Uint8Array(tag))
    expect(parsed.artwork).not.toBeNull()
    expect(parsed.artwork?.mime).toBe('image/jpeg')
    expect(Buffer.from(parsed.artwork?.data ?? []).equals(image)).toBe(true)
  })
})
