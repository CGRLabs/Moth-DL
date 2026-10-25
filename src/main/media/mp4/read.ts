/**
 * MP4/MOV tag reader.
 *
 * Metadata lives in `moov/udta/meta/ilst`, where each value is a `data` box:
 * `[4-byte size]['data'][4-byte type=1][4-byte locale][payload]`. Type 1 is
 * UTF-8/UTF-16 text; type 13 is JPEG; type 14 is PNG.
 *
 * `moov` is not guaranteed to be near the front of the file, so
 * `readTagsFromFile` pages through the file to find it rather than assuming the
 * first 256 KB is enough.
 */

import type { MediaTags } from '@shared/media.js'
import { emptyTags } from '@shared/media.js'
import { bufferReader, childBoxes, findBox, type Box, type BoxReader } from './boxes.js'

/** `ilst` atom names to metadata fields. */
const TEXT_ATOMS: Record<string, keyof Pick<MediaTags, 'title' | 'artist' | 'albumArtist' | 'album' | 'genre'>> = {
  '©nam': 'title',
  '©ART': 'artist',
  'aART': 'albumArtist',
  '©alb': 'album',
  '©gen': 'genre',
  'gnre': 'genre'
}

const NUMBER_ATOMS: Record<string, 'track' | 'disc'> = {
  trkn: 'track',
  disk: 'disc'
}

const YEAR_ATOMS = new Set(['©day'])

/** A parsed `data` atom: its type marker and the value that follows it. */
interface DataBox {
  type: number
  payload: Uint8Array
}

/**
 * Reads the value of an `ilst` atom.
 *
 * The atom wraps a `data` box: `©nam > data > [type][locale][value]`. Reading
 * the atom's own payload would return the `data` box's size field rather than
 * its type, so the nested box has to be located first.
 */
function readDataBox(reader: BoxReader, atom: Box): DataBox | null {
  const dataBox = childBoxes(reader, atom).find((child) => child.type === 'data')
  if (!dataBox || dataBox.size < 8) return null

  // Type 0 is binary (used by trkn/disk), 1 is text, 13 is JPEG, 14 is PNG.
  // Anything else is not a value we know how to read.
  const type = readUint32(reader, dataBox.offset)
  if (type !== 0 && type !== 1 && type !== 13 && type !== 14) return null

  return { type, payload: reader.read(dataBox.offset + 8, dataBox.size - 8) }
}

function readUint32(reader: BoxReader, offset: number): number {
  const a = reader.read(offset, 1)[0] ?? 0
  const b = reader.read(offset + 1, 1)[0] ?? 0
  const c = reader.read(offset + 2, 1)[0] ?? 0
  const d = reader.read(offset + 3, 1)[0] ?? 0
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

/** Decodes a `data` box payload as text, honouring its UTF-16 marker. */
function decodeDataText(payload: Uint8Array): string {
  if (payload.length === 0) return ''
  // A UTF-16 payload starts with a BOM; UTF-8 does not.
  if (payload[0] === 0xff && (payload[1] ?? 0) === 0xfe) {
    let out = ''
    for (let i = 2; i + 1 < payload.length; i += 2) {
      out += String.fromCharCode(((payload[i] ?? 0) << 8) | (payload[i + 1] ?? 0))
    }
    return out
  }
  if (payload[0] === 0xfe && (payload[1] ?? 0) === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < payload.length; i += 2) {
      out += String.fromCharCode(((payload[i + 1] ?? 0) << 8) | (payload[i] ?? 0))
    }
    return out
  }
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8')
}

function parseYear(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed.slice(0, 4), 10)
  return Number.isFinite(parsed) && parsed > 0 && parsed < 3000 ? parsed : null
}

/** Parses the `ilst` box into metadata fields. */
export function parseIlst(reader: BoxReader, ilst: Box): MediaTags {
  const tags = emptyTags('mp4')

  for (const atom of childBoxes(reader, ilst)) {
    const data = readDataBox(reader, atom)
    if (!data) continue

    const field = TEXT_ATOMS[atom.type]
    if (field) {
      const value = decodeDataText(data.payload)
      if (value) tags[field] = value
      continue
    }

    const numberField = NUMBER_ATOMS[atom.type]
    if (numberField) {
      // The value is [index:2][total:2], read as big-endian.
      const payload = data.payload
      if (payload.length >= 2) {
        const index = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0)
        if (index > 0) tags[numberField] = index
      }
      continue
    }

    if (YEAR_ATOMS.has(atom.type)) {
      const value = parseYear(decodeDataText(data.payload))
      if (value !== null) tags.year = value
      continue
    }

    if (atom.type === 'covr') {
      const payload = data.payload
      if (payload.length > 0) {
        tags.artwork = { data: payload, mime: data.type === 14 ? 'image/png' : 'image/jpeg' }
      }
    }
  }

  return tags
}

/**
 * Parses MP4 tags from a buffer that contains the whole file.
 *
 * Returns an all-null result when there is no `moov` box, which is the normal
 * case for a file that has not been tagged.
 */
export function parseMp4(buf: Uint8Array): MediaTags {
  const reader = bufferReader(buf)
  const ilst = findBox(reader, ['moov', 'udta', 'meta', 'ilst'])
  if (!ilst) return emptyTags('mp4')
  return parseIlst(reader, ilst)
}
