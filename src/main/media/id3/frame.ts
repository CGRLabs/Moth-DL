/**
 * ID3v2 frame primitives.
 *
 * Two details in this format produce the majority of real-world bugs, so they are
 * isolated here and unit-tested on their own:
 *
 *  - **Syncsafe integers.** Frame sizes in v2.3/v2.4 are 28-bit values stored
 *    7 bits per byte, with the top bit of each byte always zero. Writing a plain
 *    32-bit integer produces a size that other players read as enormous, which
 *    is exactly the kind of corruption that makes a file "still play for ten
 *    seconds then desync".
 *  - **Text encodings.** v2.2 uses ISO-8859-1 only; v2.3 adds UTF-16 with a BOM;
 *    v2.4 adds UTF-16BE and UTF-8. The encoding byte is the first byte of the
 *    frame payload, and the payload is NUL-terminated.
 *
 * Text decoding lives in `../text.js` and is re-exported here so the ID3
 * readers and writers share one implementation.
 */

import { decodeUtf16be, toText } from '../text.js'

export { decodeUtf16be, toText }

/** Reads a 28-bit syncsafe integer. */
export function readSyncsafe(buf: Uint8Array, offset: number): number {
  let value = 0
  for (let i = 0; i < 4; i += 1) {
    const byte = buf[offset + i] ?? 0
    value = (value << 7) | (byte & 0x7f)
  }
  return value
}

/** Writes a 28-bit syncsafe integer into a 4-byte buffer. */
export function encodeSyncsafe(value: number): Buffer {
  const out = Buffer.alloc(4)
  let remaining = value >>> 0
  for (let i = 3; i >= 0; i -= 1) {
    out[i] = remaining & 0x7f
    remaining >>>= 7
  }
  return out
}

/** Reads a plain (non-syncsafe) 24-bit big-endian integer, used by v2.2. */
export function readUint24(buf: Uint8Array, offset: number): number {
  const a = buf[offset] ?? 0
  const b = buf[offset + 1] ?? 0
  const c = buf[offset + 2] ?? 0
  return (a << 16) | (b << 8) | c
}

export function encodeUint24(value: number): Buffer {
  return Buffer.from([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

export interface FrameHeader {
  id: string
  /** Size of the frame payload, excluding the header. */
  size: number
  /** Offset of the frame payload within the tag. */
  offset: number
}

/**
 * Walks the frames of an ID3v2 tag.
 *
 * `version` is the minor version from the ID3 header (2, 3 or 4), which decides
 * the header width and whether sizes are syncsafe. Frames whose declared size
 * would run past the end of the buffer are skipped rather than trusted — a
 * truncated or corrupt tag must not send the reader off the end of the file.
 */
export function* iterateFrames(
  buf: Uint8Array,
  start: number,
  version: number
): Generator<FrameHeader> {
  const isV2 = version === 2
  const headerSize = isV2 ? 6 : 10
  // v2.2 uses three-byte frame IDs; v2.3 and v2.4 use four. Reading three bytes
  // for a v2.3 tag yields "TIT" instead of "TIT2", so every frame is missed.
  const idLength = isV2 ? 3 : 4
  let offset = start

  while (offset + headerSize <= buf.length) {
    let id = ''
    for (let i = 0; i < idLength; i += 1) {
      id += String.fromCharCode(buf[offset + i] ?? 0)
    }
    // A zero byte where an ID should be means we have reached the padding that
    // follows the last real frame.
    if (id.charCodeAt(0) === 0) return

    const size = isV2 ? readUint24(buf, offset + 3) : readSyncsafe(buf, offset + 4)
    const payload = offset + headerSize

    if (size < 0 || payload + size > buf.length) {
      // Corrupt or truncated. Stop rather than emit a frame that would read
      // past the buffer.
      return
    }

    yield { id, size, offset: payload }
    offset = payload + size
  }
}


/** Text encodings defined by the ID3v2 spec. */
export const ID3_ENCODING = {
  LATIN1: 0,
  UTF16_BOM: 1,
  UTF16BE: 2,
  UTF8: 3
} as const

/**
 * Decodes an ID3 text frame payload.
 *
 * The first byte is the encoding; the remainder is the text, NUL-terminated.
 * A missing or unknown encoding falls back to Latin-1, which is what every
 * v2.2 tag in existence uses.
 */
export function decodeText(buf: Uint8Array, offset: number, length: number): string {
  if (length === 0) return ''
  const encoding = buf[offset] ?? ID3_ENCODING.LATIN1
  const body = buf.subarray(offset + 1, offset + length)

  let text: string
  switch (encoding) {
    case ID3_ENCODING.UTF16_BOM: {
      const bom = body[0]
      if (bom === 0xff && (body[1] ?? 0) === 0xfe) {
        text = toText(body.subarray(2), 'utf16le')
      } else if (bom === 0xfe && (body[1] ?? 0) === 0xff) {
        text = decodeUtf16be(body.subarray(2))
      } else {
        // No BOM: the spec says to assume the byte order of the surrounding
        // tag, which for a v2.3 tag is effectively undefined. Latin-1 is the
        // safe fallback.
        text = toText(body, 'latin1')
      }
      break
    }
    case ID3_ENCODING.UTF16BE:
      text = decodeUtf16be(body)
      break
    case ID3_ENCODING.UTF8:
      text = toText(body, 'utf8')
      break
    default:
      text = toText(body, 'latin1')
  }

  // Strip the NUL terminator and any padding after it.
  const nul = text.indexOf('\u0000')
  return nul === -1 ? text : text.slice(0, nul)
}

/**
 * Encodes text for an ID3v2.3 frame.
 *
 * Latin-1 is used when every character fits, because it is the encoding every
 * player in existence understands. Anything else becomes UTF-16LE with a BOM.
 */
export function encodeText(value: string): { encoding: number; data: Buffer } {
  let latin1 = true
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0xff) {
      latin1 = false
      break
    }
  }

  if (latin1) {
    return { encoding: ID3_ENCODING.LATIN1, data: Buffer.from(value, 'latin1') }
  }
  const bom = Buffer.from([0xff, 0xfe])
  return { encoding: ID3_ENCODING.UTF16_BOM, data: Buffer.concat([bom, Buffer.from(value, 'utf16le')]) }
}

/** Strips a trailing NUL and anything after it. */
export function trimNull(text: string): string {
  const nul = text.indexOf('\u0000')
  return nul === -1 ? text : text.slice(0, nul)
}
