/**
 * Vorbis comment reader, covering FLAC and Ogg Vorbis.
 *
 * Both store metadata as a vendor string followed by `KEY=value` pairs, which
 * makes the parsing shared. The container framing differs:
 *
 *  - **FLAC** wraps the comment in a `METADATA_BLOCK_VORBIS_COMMENT` (type 4)
 *    and the picture in a `METADATA_BLOCK_PICTURE` (type 6).
 *  - **Ogg** stores it in the second page of the stream, length-prefixed.
 *
 * Only the comment block is read here; artwork is left to the caller because
 * FLAC's picture block is a structured record rather than a bare image.
 */

import type { MediaTags } from '@shared/media.js'
import { emptyTags } from '@shared/media.js'
import { toText } from './text.js'

/** Reads a little-endian unsigned integer. */
function readUint(buf: Uint8Array, offset: number, bytes: number): number {
  let value = 0
  for (let i = bytes - 1; i >= 0; i -= 1) {
    value = value * 256 + (buf[offset + i] ?? 0)
  }
  return value
}

/** Maps Vorbis comment keys to metadata fields. */
const VORBIS_KEYS: Record<string, keyof Pick<MediaTags, 'title' | 'artist' | 'albumArtist' | 'album' | 'genre'>> = {
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUMARTIST: 'albumArtist',
  ALBUM: 'album',
  GENRE: 'genre'
}

const NUMBER_KEYS: Record<string, 'track' | 'disc'> = {
  TRACKNUMBER: 'track',
  DISCNUMBER: 'disc'
}

const YEAR_KEYS = new Set(['DATE', 'YEAR', 'ORIGINALDATE'])

function parseIndex(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const slash = trimmed.indexOf('/')
  const raw = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseYear(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed.slice(0, 4), 10)
  return Number.isFinite(parsed) && parsed > 0 && parsed < 3000 ? parsed : null
}

/**
 * Parses a Vorbis comment block.
 *
 * Layout: 4-byte vendor length, vendor string, 4-byte count, then for each
 * comment a 4-byte length and `KEY=value`. Lengths are little-endian, which is
 * the opposite endianness from ID3 and MP4 — a common source of bugs.
 */
export function parseVorbisComment(buf: Uint8Array, offset = 0): MediaTags {
  const tags = emptyTags('ogg')
  let cursor = offset

  if (cursor + 4 > buf.length) return tags
  const vendorLength = readUint(buf, cursor, 4)
  cursor += 4 + vendorLength

  if (cursor + 4 > buf.length) return tags
  const count = readUint(buf, cursor, 4)
  cursor += 4

  for (let i = 0; i < count; i += 1) {
    if (cursor + 4 > buf.length) break
    const length = readUint(buf, cursor, 4)
    cursor += 4
    if (length === 0 || cursor + length > buf.length) break

    const raw = buf.subarray(cursor, cursor + length)
    cursor += length

    const separator = raw.indexOf(0x3d) // '='
    if (separator <= 0) continue

    const key = toText(raw.subarray(0, separator), 'latin1').trim().toUpperCase()
    const value = toText(raw.subarray(separator + 1), 'utf8')
    if (!value) continue

    const field = VORBIS_KEYS[key]
    if (field) {
      tags[field] = value
      continue
    }

    const numberField = NUMBER_KEYS[key]
    if (numberField) {
      const parsed = parseIndex(value)
      if (parsed !== null) tags[numberField] = parsed
      continue
    }

    if (YEAR_KEYS.has(key)) {
      const parsed = parseYear(value)
      if (parsed !== null) tags.year = parsed
    }
  }

  return tags
}

/**
 * Locates and parses the Vorbis comment inside a FLAC stream.
 *
 * FLAC metadata blocks are `[4-byte header][payload]` where the header's top
 * bit flags "last block" and the low 7 bits give the block type. The comment is
 * type 4; the picture is type 6.
 */
export function parseFlac(buf: Uint8Array): MediaTags {
  const tags = emptyTags('flac')
  if (buf.length < 4) return tags
  if (buf[0] !== 0x66 || buf[1] !== 0x4c || buf[2] !== 0x61 || buf[3] !== 0x43) return tags

  let cursor = 4
  let last = false

  while (!last && cursor + 4 <= buf.length) {
    const header = buf[cursor] ?? 0
    last = (header & 0x80) !== 0
    const type = header & 0x7f
    const blockSize = readUint(buf, cursor + 1, 3)
    const payloadStart = cursor + 4

    if (payloadStart + blockSize > buf.length) break

    if (type === 4) {
      Object.assign(tags, parseVorbisComment(buf.subarray(payloadStart, payloadStart + blockSize)))
    } else if (type === 6) {
      const picture = parseFlacPicture(buf, payloadStart, blockSize)
      if (picture) tags.artwork = picture
    }

    cursor = payloadStart + blockSize
  }

  return tags
}

/**
 * Parses a FLAC `METADATA_BLOCK_PICTURE`.
 *
 * Layout: 4-byte type, 4-byte mime length, mime, 4-byte description length,
 * description, width/height/depth/colours (4 bytes each), 4-byte data length,
 * then the image. The mime is a plain string, not a declared type to trust.
 */
function parseFlacPicture(
  buf: Uint8Array,
  offset: number,
  size: number
): MediaTags['artwork'] {
  let cursor = offset
  const end = offset + size

  if (cursor + 4 > end) return null
  cursor += 4 // picture type

  if (cursor + 4 > end) return null
  const mimeLength = readUint(buf, cursor, 4)
  cursor += 4
  if (cursor + mimeLength > end) return null
  const mime = toText(buf.subarray(cursor, cursor + mimeLength), 'latin1').toLowerCase()
  cursor += mimeLength

  if (cursor + 4 > end) return null
  const descriptionLength = readUint(buf, cursor, 4)
  cursor += 4
  cursor += descriptionLength

  // width, height, depth, colours
  if (cursor + 16 > end) return null
  cursor += 16

  if (cursor + 4 > end) return null
  const dataLength = readUint(buf, cursor, 4)
  cursor += 4
  if (dataLength === 0 || cursor + dataLength > end) return null

  const data = buf.subarray(cursor, cursor + dataLength)
  if (mime.includes('png')) return { data, mime: 'image/png' }
  if (mime.includes('jpeg') || mime.includes('jpg')) return { data, mime: 'image/jpeg' }
  if (mime.includes('gif')) return { data, mime: 'image/gif' }
  if (mime.includes('webp')) return { data, mime: 'image/webp' }
  return { data, mime: 'image/png' }
}
