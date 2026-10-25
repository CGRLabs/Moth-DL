/**
 * Container format detection from magic bytes.
 *
 * Sniffing is deliberately conservative: a false positive makes the parser walk
 * a file that is not what it claims, and a false negative only costs us metadata
 * we could have had. When in doubt, return `unknown`.
 *
 * Every comparison is bounds-safe. Under `noUncheckedIndexedAccess` an out-of-range
 * index yields `undefined`, which simply fails the equality check rather than
 * throwing or reading past the buffer.
 */

import type { MediaFormat } from '@shared/media.js'

/** True when `buf` starts with the given byte sequence. */
function startsWith(buf: Uint8Array, bytes: readonly number[]): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[i] !== bytes[i]) return false
  }
  return true
}

/** True when `buf` contains `bytes` at `offset`. */
function at(buf: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[offset + i] !== bytes[i]) return false
  }
  return true
}

/**
 * MPEG audio frame sync: `111` in the top three bits of the second byte.
 * The version bits (`01`) and layer bits (`00`) are reserved, so exclude them —
 * otherwise random data gets misread as MP3 and the parser walks garbage.
 */
function looksLikeMpegFrame(buf: Uint8Array): boolean {
  if (buf.length < 2) return false
  const first = buf[0] ?? 0
  const second = buf[1] ?? 0
  if (first !== 0xff) return false
  if ((second & 0xe0) !== 0xe0) return false
  const version = (second >> 3) & 0x03
  const layer = (second >> 1) & 0x03
  return version !== 0x01 && layer !== 0x00
}

/** Identifies a container from its leading bytes. Never throws. */
export function detectFormat(buf: Uint8Array): MediaFormat {
  if (buf.length < 4) return 'unknown'

  // ID3v2 tags precede the audio frames, so check them first.
  if (startsWith(buf, [0x49, 0x44, 0x33])) return 'mp3'
  if (looksLikeMpegFrame(buf)) return 'mp3'

  // ISO-BMFF: a 4-byte size followed by 'ftyp' at offset 4.
  if (at(buf, 4, [0x66, 0x74, 0x79, 0x70])) return 'mp4'

  // Matroska and WebM share the EBML magic.
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'matroska'

  if (startsWith(buf, [0x66, 0x4c, 0x61, 0x43])) return 'flac'
  if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53])) return 'ogg'

  // RIFF....WAVE
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && at(buf, 8, [0x57, 0x41, 0x56, 0x45])) {
    return 'wav'
  }

  return 'unknown'
}

/** True when the format carries embedded metadata Moth can read. */
export function formatIsSupported(format: MediaFormat): boolean {
  return format === 'mp3' || format === 'mp4' || format === 'flac' || format === 'ogg'
}

/** True when the format can carry an embedded cover image. */
export function formatSupportsArtwork(format: MediaFormat): boolean {
  return format === 'mp3' || format === 'mp4' || format === 'flac' || format === 'ogg'
}
