/**
 * MP4 box arithmetic and tag round-trip tests.
 *
 * The box size encoding is the part of this format that is easy to get wrong and
 * hard to notice: a `size === 1` box carries a 64-bit extended size, and a
 * `size === 0` box runs to the end of its parent. Getting either wrong produces
 * a parser that reads garbage or walks off the file.
 */

import { describe, it, expect } from 'vitest'
import { bufferReader, childBoxes, findBox } from '../../src/main/media/mp4/boxes.js'
import { buildIlst, buildTaggedMp4 } from '../../src/main/media/mp4/write.js'
import { parseMp4 } from '../../src/main/media/mp4/read.js'
import { emptyTags } from '@shared/media.js'

/** Builds a box: `[size][type][payload]`. */
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(payload.length + 8, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, payload])
}

/** Builds a `data` atom holding UTF-8 text. */
function dataText(value: string): Buffer {
  const payload = Buffer.from(value, 'utf8')
  const inner = Buffer.alloc(8 + payload.length)
  inner.writeUInt32BE(1, 0)
  inner.writeUInt32BE(0, 4)
  payload.copy(inner, 8)
  return box('data', inner)
}

/** Builds a `meta` box with an `hdlr` and the given `ilst` payload. */
function metaWith(ilst: Buffer): Buffer {
  const hdlrPayload = Buffer.alloc(24)
  hdlrPayload.write('mdir', 4, 'latin1')
  hdlrPayload.write('appl', 8, 'latin1')
  const hdlr = box('hdlr', hdlrPayload)
  const metaPayload = Buffer.concat([Buffer.alloc(4), hdlr, ilst])
  return box('meta', metaPayload)
}

/** Builds a `moov` containing `udta` with the given `ilst`. */
function moovWithIlst(ilst: Buffer): Buffer {
  const udta = box('udta', metaWith(ilst))
  return box('moov', udta)
}

describe('box size arithmetic', () => {
  it('reads a plain 32-bit size', () => {
    const buf = new Uint8Array(box('free', Buffer.alloc(4)))
    const reader = bufferReader(buf)
    const found = reader.readBox(0)
    expect(found?.type).toBe('free')
    expect(found?.size).toBe(4)
  })

  it('reads a 64-bit extended size when size is 1', () => {
    // A size of 1 means the total box size follows as 64-bit. Here the box is
    // a 16-byte header plus 32 payload bytes, so the total is 48.
    const header = Buffer.alloc(16)
    header.writeUInt32BE(1, 0)
    header.write('free', 4, 'latin1')
    header.writeBigUInt64BE(BigInt(48), 8)
    const buf = new Uint8Array(Buffer.concat([header, Buffer.alloc(32)]))
    const reader = bufferReader(buf)
    const found = reader.readBox(0)
    expect(found?.size).toBe(32)
  })

  it('treats a size of 0 as extending to the end', () => {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(0, 0)
    header.write('free', 4, 'latin1')
    const buf = new Uint8Array(Buffer.concat([header, Buffer.alloc(20)]))
    const reader = bufferReader(buf)
    const found = reader.readBox(0)
    expect(found?.size).toBe(20)
  })

  it('rejects a size that would run past the buffer', () => {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(0xffffff, 0)
    header.write('free', 4, 'latin1')
    const reader = bufferReader(new Uint8Array(header))
    expect(reader.readBox(0)).toBeNull()
  })
})

describe('findBox', () => {
  it('walks a nested path', () => {
    const buf = new Uint8Array(moovWithIlst(box('ilst', dataText('x'))))
    const reader = bufferReader(buf)
    const ilst = findBox(reader, ['moov', 'udta', 'meta', 'ilst'])
    expect(ilst?.type).toBe('ilst')
  })

  it('returns null when a segment is missing', () => {
    const buf = new Uint8Array(box('moov', Buffer.alloc(4)))
    const reader = bufferReader(buf)
    expect(findBox(reader, ['moov', 'udta', 'meta', 'ilst'])).toBeNull()
  })

  it('skips the version/flags prefix inside meta', () => {
    // meta's payload starts with 4 bytes of version/flags before its children.
    // If those are not skipped, 'hdlr' is never found.
    const buf = new Uint8Array(moovWithIlst(box('ilst', dataText('x'))))
    const reader = bufferReader(buf)
    const meta = findBox(reader, ['moov', 'udta', 'meta'])
    expect(meta).not.toBeNull()
    const children = childBoxes(reader, meta!)
    expect(children.map((child) => child.type)).toContain('hdlr')
  })
})

describe('buildIlst / parseMp4 round trip', () => {
  it('returns null when there is nothing to write', () => {
    expect(buildIlst(emptyTags('mp4'))).toBeNull()
  })

  it('round-trips text fields', () => {
    const ilst = buildIlst({
      ...emptyTags('mp4'),
      title: 'Big Buck Bunny',
      artist: 'Blender Foundation',
      album: 'Open Movies',
      genre: 'Animation',
      year: 2008
    })
    expect(ilst).not.toBeNull()

    const buf = new Uint8Array(moovWithIlst(ilst!))
    const parsed = parseMp4(buf)
    expect(parsed.title).toBe('Big Buck Bunny')
    expect(parsed.artist).toBe('Blender Foundation')
    expect(parsed.album).toBe('Open Movies')
    expect(parsed.genre).toBe('Animation')
    expect(parsed.year).toBe(2008)
  })

  it('round-trips track and disc numbers', () => {
    const ilst = buildIlst({ ...emptyTags('mp4'), track: 4, disc: 1 })
    const parsed = parseMp4(new Uint8Array(moovWithIlst(ilst!)))
    expect(parsed.track).toBe(4)
    expect(parsed.disc).toBe(1)
  });

  it('round-trips artwork', () => {
    const image = [0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04]
    const ilst = buildIlst({
      ...emptyTags('mp4'),
      title: 'Cover',
      artwork: { data: new Uint8Array(image), mime: 'image/png' }
    })
    const parsed = parseMp4(new Uint8Array(moovWithIlst(ilst!)))
    expect(parsed.artwork).not.toBeNull()
    expect(parsed.artwork?.mime).toBe('image/png')
    expect(Array.from(parsed.artwork?.data ?? [])).toEqual(image)
  });
})

describe('buildTaggedMp4', () => {
  it('returns null when there is no moov box', () => {
    const buf = new Uint8Array(Buffer.concat([Buffer.alloc(64), Buffer.from('not an mp4')]))
    expect(buildTaggedMp4(buf, { ...emptyTags('mp4'), title: 'x' })).toBeNull()
  });

  it('inserts a udta when the file has none', () => {
    // A realistic minimal MP4: ftyp, then moov containing an mvhd. Zero bytes as
    // the moov payload would read as a "size 0 = extends to end" box and hide
    // anything inserted after them.
    const ftyp = box('ftyp', Buffer.from('isom', 'latin1'))
    const moov = box('moov', box('mvhd', Buffer.alloc(4)))
    const original = new Uint8Array(Buffer.concat([ftyp, moov]))
    const tagged = buildTaggedMp4(original, { ...emptyTags('mp4'), title: 'Inserted' })
    expect(tagged).not.toBeNull()
    expect(parseMp4(tagged!).title).toBe('Inserted')
  });

  it('replaces an existing udta rather than duplicating it', () => {
    const original = new Uint8Array(moovWithIlst(buildIlst({ ...emptyTags('mp4'), title: 'Old' })!))
    const tagged = buildTaggedMp4(original, { ...emptyTags('mp4'), title: 'New' })
    expect(tagged).not.toBeNull()

    const parsed = parseMp4(tagged!)
    expect(parsed.title).toBe('New')

    // There must still be exactly one udta.
    const reader = bufferReader(tagged!)
    const moov = findBox(reader, ['moov'])!
    const udtas = childBoxes(reader, moov).filter((child) => child.type === 'udta')
    expect(udtas.length).toBe(1);
  });

  it('preserves the audio payload', () => {
    const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0xaa, 0xbb, 0xcc, 0xdd])
    const moov = box('moov', Buffer.alloc(4))
    const original = new Uint8Array(Buffer.concat([moov, audio]))
    const tagged = buildTaggedMp4(original, { ...emptyTags('mp4'), title: 'Kept' })
    expect(tagged).not.toBeNull()
    // The audio bytes must still be present, untouched.
    const tail = Buffer.from(tagged!.subarray(tagged!.length - audio.length))
    expect(tail.equals(audio)).toBe(true)
  });
})
