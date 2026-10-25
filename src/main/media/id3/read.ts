/**
 * ID3v2 (and v1) tag reader.
 *
 * Covers v2.2, v2.3 and v2.4 because all three are still in circulation and the
 * frame IDs differ between them — a v2.2 tag uses `TT2` where v2.3 uses `TIT2`,
 * and reading the wrong one yields an empty title on a perfectly good file.
 *
 * ID3v1 is read as a fallback. It is a fixed 128-byte block at the end of the
 * file with no artwork support, but a great many older MP3s carry only that.
 *
 * Nothing here throws. A tag that is truncated, corrupt or simply absent yields
 * an all-null result, because a metadata failure must never fail a download.
 */

import type { MediaTags } from '@shared/media.js'
import { emptyTags } from '@shared/media.js'
import {
  ID3_ENCODING,
  decodeText,
  iterateFrames,
  readSyncsafe,
  trimNull
} from './frame.js'
import { toText } from '../text.js'

/** Frame IDs per minor version, normalised to one lookup. */
const TEXT_FRAMES: Record<string, keyof Pick<MediaTags, 'title' | 'artist' | 'albumArtist' | 'album' | 'genre'>> = {
  // v2.3 / v2.4
  TIT2: 'title',
  TPE1: 'artist',
  TPE2: 'albumArtist',
  TALB: 'album',
  TCON: 'genre',
  // v2.2
  TT2: 'title',
  TP1: 'artist',
  TP2: 'albumArtist',
  TAL: 'album',
  TCO: 'genre'
}

const NUMBER_FRAMES: Record<string, 'track' | 'disc'> = {
  TRCK: 'track',
  TPOS: 'disc',
  TRK: 'track',
  TPA: 'disc'
}

/** v2.3 stores the year in TYER; v2.4 moved it to TDRC. */
const YEAR_FRAMES = new Set(['TYER', 'TDRC', 'TYE'])

const ARTWORK_FRAMES = new Set(['APIC', 'PIC'])

/** Parses `"3/12"` or `"3"` into the leading number, or null. */
function parseIndex(value: string): number | null {
  const trimmed = trimNull(value).trim()
  if (!trimmed) return null
  const slash = trimmed.indexOf('/')
  const raw = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseYear(value: string): number | null {
  const trimmed = trimNull(value).trim()
  if (!trimmed) return null
  // TDRC may hold a full timestamp; only the year is wanted.
  const parsed = Number.parseInt(trimmed.slice(0, 4), 10)
  return Number.isFinite(parsed) && parsed > 0 && parsed < 3000 ? parsed : null
}

/** Reads the ID3v2 header. Returns null when the buffer is not an ID3 tag. */
function readHeader(buf: Uint8Array): { version: number; bodyStart: number; bodyLength: number } | null {
  if (buf.length < 10) return null
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null

  const version = buf[3] ?? 0
  if (version < 2 || version > 4) return null

  const flags = buf[5] ?? 0
  const bodyLength = readSyncsafe(buf, 6)
  let bodyStart = 10

  // An extended header sits at the start of the tag body. Its size is syncsafe
  // in v2.4 and a plain 32-bit integer in v2.3.
  if (flags & 0x40) {
    if (bodyStart + 4 > buf.length) return null
    const extendedSize = version === 4 ? readSyncsafe(buf, bodyStart) : readUint32(buf, bodyStart)
    bodyStart += extendedSize
  }

  return { version, bodyStart, bodyLength }
}

function readUint32(buf: Uint8Array, offset: number): number {
  const a = buf[offset] ?? 0
  const b = buf[offset + 1] ?? 0
  const c = buf[offset + 2] ?? 0
  const d = buf[offset + 3] ?? 0
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

/** MIME types an ID3 APIC frame is allowed to declare. */
const APIC_MIME: readonly string[] = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/webp',
  'jpeg',
  'jpg',
  'png',
  'gif'
]

function normalizeArtworkMime(mime: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  const cleaned = mime.trim().toLowerCase().replace(/^image\//, '')
  switch (cleaned) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    default:
      return null
  }
}

/** Extracts the image bytes from an APIC/PIC frame payload. */
function readArtwork(buf: Uint8Array, offset: number, size: number): MediaTags['artwork'] {
  if (size < 2) return null
  const encoding = buf[offset] ?? ID3_ENCODING.LATIN1
  let cursor = offset + 1

  // MIME type, NUL-terminated.
  const mimeEnd = indexOfNull(buf, cursor)
  if (mimeEnd === -1) return null
  const mime = toText(buf.subarray(cursor, mimeEnd), 'latin1').toLowerCase()
  if (!APIC_MIME.includes(mime)) return null
  cursor = mimeEnd + 1

  // Picture type byte, then a NUL-terminated description in the frame's own
  // encoding — which for UTF-16 means two NUL bytes.
  if (cursor >= offset + size) return null
  cursor += 1
  cursor = skipDescription(buf, cursor, offset + size, encoding)
  if (cursor === -1 || cursor >= offset + size) return null

  const data = buf.subarray(cursor, offset + size)
  if (data.length === 0) return null

  // The declared type is a hint only. The facade sniffs the real bytes, because
  // a tag claiming image/png while carrying anything else is common.
  const guessed = normalizeArtworkMime(mime)
  return { data, mime: guessed ?? 'image/png' }
}

function indexOfNull(buf: Uint8Array, from: number): number {
  for (let i = from; i < buf.length; i += 1) {
    if (buf[i] === 0) return i
  }
  return -1
}

/** Skips a NUL-terminated description, honouring UTF-16's two-byte terminator. */
function skipDescription(
  buf: Uint8Array,
  cursor: number,
  limit: number,
  encoding: number
): number {
  const step = encoding === ID3_ENCODING.UTF16_BOM || encoding === ID3_ENCODING.UTF16BE ? 2 : 1
  while (cursor + step <= limit) {
    const first = buf[cursor] ?? 0
    const second = step === 2 ? (buf[cursor + 1] ?? 0) : 0
    if (first === 0 && second === 0) return cursor + step
    cursor += step
  }
  return -1
}

/** Parses an ID3v2 tag from the leading bytes of an MP3. */
export function parseId3v2(buf: Uint8Array): MediaTags {
  const tags = emptyTags('mp3')
  const header = readHeader(buf)
  if (!header) return tags

  const { version, bodyStart } = header
  for (const frame of iterateFrames(buf, bodyStart, version)) {
    const textField = TEXT_FRAMES[frame.id]
    if (textField) {
      const value = decodeText(buf, frame.offset, frame.size)
      if (value) tags[textField] = value
      continue
    }

    const numberField = NUMBER_FRAMES[frame.id]
    if (numberField) {
      const value = parseIndex(decodeText(buf, frame.offset, frame.size))
      if (value !== null) tags[numberField] = value
      continue
    }

    if (YEAR_FRAMES.has(frame.id)) {
      const value = parseYear(decodeText(buf, frame.offset, frame.size))
      if (value !== null) tags.year = value
      continue
    }

    if (ARTWORK_FRAMES.has(frame.id)) {
      const artwork = readArtwork(buf, frame.offset, frame.size)
      if (artwork) tags.artwork = artwork
    }
  }

  return tags
}

/**
 * Parses an ID3v1 tag from the trailing 128 bytes of an MP3.
 *
 * Fixed-width Latin-1 fields with no artwork. Used only when no v2 tag exists.
 */
export function parseId3v1(tail: Uint8Array): MediaTags {
  const tags = emptyTags('mp3')
  if (tail.length < 128) return tags
  if (tail[0] !== 0x54 || tail[1] !== 0x41 || tail[2] !== 0x47) return tags

  const field = (from: number, length: number): string => {
    const raw = toText(tail.subarray(from, from + length), 'latin1')
    return trimNull(raw).trim()
  }

  const title = field(3, 30)
  const artist = field(33, 30)
  const album = field(63, 30)
  const year = field(93, 4)
  const genre = field(127, 1)

  if (title) tags.title = title
  if (artist) tags.artist = artist
  if (album) tags.album = album
  const parsedYear = Number.parseInt(year, 10)
  if (Number.isFinite(parsedYear) && parsedYear > 0 && parsedYear < 3000) tags.year = parsedYear
  if (genre) tags.genre = `Genre ${genre}`

  return tags
}
