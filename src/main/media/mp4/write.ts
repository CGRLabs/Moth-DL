/**
 * MP4/MOV tag writer.
 *
 * Builds a `moov/udta/meta/ilst` tree from scratch when the file has none, or
 * replaces the existing `ilst` when it does. Only non-null fields are written:
 * a null means "the user did not tell us", not "delete what is there".
 *
 * The box layout written here is the conventional one:
 *
 *   moov
 *   └─ udta
 *      └─ meta            (full box: version/flags + hdlr)
 *         └─ ilst
 *            ├─ ©nam > data
 *            ├─ ©ART > data
 *            └─ covr > data
 *
 * `data` boxes are `[size]['data'][type=1][locale=0][utf8]`.
 *
 * This module only builds bytes. The non-destructive copy-verify-replace cycle
 * lives in `write.ts`, so the box arithmetic here is unit-testable without
 * touching a file.
 */

import type { MediaTags } from '@shared/media.js'
import { bufferReader, childBoxes, findBox, type Box } from './boxes.js'

const ATOM = {
  MOOV: 'moov',
  UDTA: 'udta',
  META: 'meta',
  HDLR: 'hdlr',
  ILST: 'ilst',
  DATA: 'data',
  COVR: 'covr'
} as const

/** Text atom names, matching the reader's lookup table. */
const TEXT_ATOM_FOR: Partial<Record<string, string>> = {
  title: '©nam',
  artist: '©ART',
  albumArtist: 'aART',
  album: '©alb',
  genre: '©gen'
}

/** Builds a `data` box holding UTF-8 text. */
function dataBoxText(value: string): Buffer {
  const payload = Buffer.from(value, 'utf8')
  const inner = Buffer.alloc(8 + payload.length)
  inner.writeUInt32BE(1, 0) // type 1 = text
  inner.writeUInt32BE(0, 4) // locale
  payload.copy(inner, 8)
  return wrap(ATOM.DATA, inner)
}

/** Builds a `data` box holding raw image bytes. */
function dataBoxImage(bytes: Uint8Array, mime: string): Buffer {
  const type = mime === 'image/png' ? 14 : 13
  const inner = Buffer.alloc(8 + bytes.length)
  inner.writeUInt32BE(type, 0)
  inner.writeUInt32BE(0, 4)
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(inner, 8)
  return wrap(ATOM.DATA, inner)
}

/** Wraps a payload in a box with the given type. */
function wrap(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(payload.length + 8, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, payload])
}

/** Builds the `hdlr` box `meta` requires. */
function buildHdlr(): Buffer {
  const payload = Buffer.alloc(24)
  payload.write('mdir', 4, 'latin1')
  payload.write('appl', 8, 'latin1')
  return wrap(ATOM.HDLR, payload)
}

/** Builds a complete `meta` box containing `ilst`. */
function buildMeta(ilst: Buffer): Buffer {
  const versionFlags = Buffer.alloc(4)
  return wrap(ATOM.META, Buffer.concat([versionFlags, buildHdlr(), ilst]))
}

/**
 * Builds a `trkn`/`disk` box.
 *
 * The value is a `data` atom whose payload is `[type][locale][index:2][total:2]`.
 * The type is 0 (binary) rather than 1 (text), because a track number is not a
 * string — and the reader rejects anything that is not one of the types it
 * understands.
 */
function buildIndexBox(index: number): Buffer {
  const payload = Buffer.alloc(12)
  payload.writeUInt32BE(0, 0) // type 0 = binary
  payload.writeUInt32BE(0, 4) // locale
  // The index sits after the type and locale, at offset 8 — not 6, which would
  // overwrite the locale field.
  payload.writeUInt16BE(Math.min(index, 0xffff), 8)
  payload.writeUInt16BE(0, 10)
  return wrap(ATOM.DATA, payload)
}

/** Builds an `ilst` box from the non-null fields of `tags`. */
export function buildIlst(tags: MediaTags): Buffer | null {
  const atoms: Buffer[] = []

  for (const [field, atomName] of Object.entries(TEXT_ATOM_FOR)) {
    const value = tags[field as keyof MediaTags]
    if (typeof value === 'string' && value.length > 0 && atomName) {
      atoms.push(wrap(atomName, dataBoxText(value)))
    }
  }

  if (tags.track !== null) atoms.push(wrap('trkn', buildIndexBox(tags.track)))
  if (tags.disc !== null) atoms.push(wrap('disk', buildIndexBox(tags.disc)))
  if (tags.year !== null) {
    atoms.push(wrap('©day', dataBoxText(String(tags.year))))
  }
  if (tags.artwork) {
    atoms.push(wrap(ATOM.COVR, dataBoxImage(tags.artwork.data, tags.artwork.mime)))
  }

  if (atoms.length === 0) return null
  return wrap(ATOM.ILST, Buffer.concat(atoms))
}

/** Total bytes a box occupies, header included. */
function boxTotal(box: Box): number {
  return box.size + (box.offset - box.headerOffset)
}

/** Replaces `box`'s bytes with `replacement`. */
function replaceBox(buf: Uint8Array, box: Box, replacement: Buffer): Uint8Array {
  const start = box.headerOffset
  const end = start + boxTotal(box)
  return Buffer.concat([buf.subarray(0, start), replacement, buf.subarray(end)])
}

/**
 * Inserts `udta` inside the `moov` box.
 *
 * `udta` is a child of `moov`, not a sibling. Appending it after the box would
 * produce a file where no player finds the metadata, so the bytes go at the end
 * of `moov`'s payload and `moov`'s own size field is extended to cover them.
 */
function insertIntoMoov(buf: Uint8Array, moov: Box, udta: Buffer): Uint8Array {
  const at = moov.offset + moov.size
  return Buffer.concat([buf.subarray(0, at), udta, buf.subarray(at)])
}

function setBoxSize(data: Buffer, box: Box, payloadSize: number): boolean {
  const headerSize = box.offset - box.headerOffset
  const totalSize = payloadSize + headerSize
  if (headerSize === 8) {
    if (totalSize > 0xffffffff) return false
    data.writeUInt32BE(totalSize, box.headerOffset)
    return true
  }
  if (headerSize === 16) {
    data.writeUInt32BE(1, box.headerOffset)
    data.writeBigUInt64BE(BigInt(totalSize), box.headerOffset + 8)
    return true
  }
  return false
}

const OFFSET_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex'])

function adjustChunkOffsets(
  data: Buffer,
  moov: Box,
  oldMoovEnd: number,
  delta: number
): boolean {
  const reader = bufferReader(data)
  const visit = (parent: Box): boolean => {
    for (const child of childBoxes(reader, parent)) {
      if (child.type === 'stco' || child.type === 'co64') {
        const width = child.type === 'stco' ? 4 : 8
        const countOffset = child.offset + 4
        if (countOffset + 4 > child.offset + child.size) return false
        const count = reader.read(countOffset, 4)
        const entries = Buffer.from(count.buffer, count.byteOffset, count.byteLength).readUInt32BE(0)
        const entriesOffset = countOffset + 4
        if (entriesOffset + entries * width > child.offset + child.size) return false
        for (let index = 0; index < entries; index += 1) {
          const offset = entriesOffset + index * width
          const value =
            width === 4
              ? BigInt(data.readUInt32BE(offset))
              : data.readBigUInt64BE(offset)
          if (value < BigInt(oldMoovEnd)) continue
          const shifted = value + BigInt(delta)
          if (
            shifted < 0n ||
            (width === 4 && shifted > 0xffffffffn) ||
            shifted > 0xffffffffffffffffn
          ) {
            return false
          }
          if (width === 4) data.writeUInt32BE(Number(shifted), offset)
          else data.writeBigUInt64BE(shifted, offset)
        }
      } else if (OFFSET_CONTAINERS.has(child.type) && !visit(child)) {
        return false
      }
    }
    return true
  }
  return visit(moov)
}

function hasMdatAfterMoov(buf: Uint8Array, moovEnd: number): boolean {
  const reader = bufferReader(buf)
  let offset = 0
  while (offset + 8 <= reader.length) {
    const box = reader.readBox(offset)
    if (!box) return false
    if (box.type === 'mdat' && box.headerOffset >= moovEnd) return true
    offset = box.offset + box.size
  }
  return false
}

/**
 * Produces a new file buffer with the tags applied.
 *
 * Returns null when there is nothing to write, or when the file has no `moov`
 * box — inventing a structure a player may not accept is worse than leaving the
 * file untagged.
 */
export function buildTaggedMp4(original: Uint8Array, tags: MediaTags): Uint8Array | null {
  const ilst = buildIlst(tags)
  if (!ilst) return null

  const reader = bufferReader(original)
  const moov = findBox(reader, [ATOM.MOOV])
  if (!moov) return null

  const udta = wrap(ATOM.UDTA, buildMeta(ilst))
  const existingUdta = findBox(reader, [ATOM.MOOV, ATOM.UDTA])
  const originalMoovEnd = moov.offset + moov.size
  const output = existingUdta
    ? replaceBox(original, existingUdta, udta)
    : insertIntoMoov(original, moov, udta)
  const data = Buffer.from(output.buffer, output.byteOffset, output.byteLength)
  const updatedReader = bufferReader(data)
  const updatedMoov = findBox(updatedReader, [ATOM.MOOV])
  if (!updatedMoov) return null
  const delta = data.length - original.length
  if (!setBoxSize(data, updatedMoov, moov.size + delta)) return null
  // A larger moov before mdat shifts every absolute chunk offset that follows it.
  if (delta !== 0 && hasMdatAfterMoov(original, originalMoovEnd)) {
    const resizedReader = bufferReader(data)
    const resizedMoov = findBox(resizedReader, [ATOM.MOOV])
    if (!resizedMoov || !adjustChunkOffsets(data, resizedMoov, originalMoovEnd, delta)) return null
  }
  return data
}
