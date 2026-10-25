/**
 * ID3v2.3 tag writer.
 *
 * Emits a complete, self-contained v2.3 tag that can be prepended to an MP3.
 * v2.3 is chosen over v2.4 because it is the version every player in existence
 * understands, and because v2.4's relative timestamps buy us nothing.
 *
 * The frame sizes are syncsafe 28-bit integers. Writing a plain 32-bit size is
 * the classic bug here: other players read it as an enormous length and the file
 * appears to desync a few seconds in.
 */

import type { MediaTags } from '@shared/media.js'
import { encodeSyncsafe, encodeText, ID3_ENCODING } from './frame.js'

/** Builds a text frame: `[id][syncsafe size][flags][encoding][text]`. */
function textFrame(id: string, value: string): Buffer {
  const { encoding, data } = encodeText(value)
  const payload = Buffer.alloc(1 + data.length)
  payload[0] = encoding
  data.copy(payload, 1)

  const header = Buffer.alloc(10)
  header.write(id, 0, 'latin1')
  encodeSyncsafe(payload.length).copy(header, 4)
  // Flags: 0x0000 = no compression, no encryption, no unsynchronisation.
  header.writeUInt16BE(0, 8)
  return Buffer.concat([header, payload])
}

/** Builds an APIC frame holding the cover image. */
function apicFrame(artwork: { data: Uint8Array; mime: string }): Buffer {
  const mime = artwork.mime === 'image/png' ? 'image/png' : 'image/jpeg'
  const mimeBytes = Buffer.from(`${mime}\u0000`, 'latin1')

  // Encoding 0 (Latin-1) for the description, picture type 3 (front cover).
  const description = Buffer.from('\u0000', 'latin1')
  const payload = Buffer.alloc(1 + mimeBytes.length + 1 + description.length + artwork.data.length)
  let cursor = 0

  payload[cursor] = ID3_ENCODING.LATIN1
  cursor += 1
  mimeBytes.copy(payload, cursor)
  cursor += mimeBytes.length
  payload[cursor] = 0x03
  cursor += 1
  description.copy(payload, cursor)
  cursor += description.length
  Buffer.from(artwork.data.buffer, artwork.data.byteOffset, artwork.data.byteLength).copy(
    payload,
    cursor
  )

  const header = Buffer.alloc(10)
  header.write('APIC', 0, 'latin1')
  encodeSyncsafe(payload.length).copy(header, 4)
  header.writeUInt16BE(0, 8)
  return Buffer.concat([header, payload])
}

/** Builds a TRCK/TPOS frame from a numeric index. */
function indexFrame(id: string, index: number): Buffer {
  const value = String(Math.max(1, Math.min(index, 9999)))
  return textFrame(id, value)
}

/**
 * Builds a complete ID3v2.3 tag.
 *
 * Returns null when there is nothing to write. The tag is a 10-byte header
 * followed by the frames, with no padding — players tolerate a tag that ends
 * exactly at the last frame, and padding only wastes space.
 */
export function buildId3v2Tag(tags: MediaTags): Buffer | null {
  const frames: Buffer[] = []

  if (tags.title) frames.push(textFrame('TIT2', tags.title))
  if (tags.artist) frames.push(textFrame('TPE1', tags.artist))
  if (tags.albumArtist) frames.push(textFrame('TPE2', tags.albumArtist))
  if (tags.album) frames.push(textFrame('TALB', tags.album))
  if (tags.genre) frames.push(textFrame('TCON', tags.genre))
  if (tags.year !== null) frames.push(textFrame('TYER', String(tags.year)))
  if (tags.track !== null) frames.push(indexFrame('TRCK', tags.track))
  if (tags.disc !== null) frames.push(indexFrame('TPOS', tags.disc))
  if (tags.artwork) frames.push(apicFrame(tags.artwork))

  if (frames.length === 0) return null

  const body = Buffer.concat(frames)
  const header = Buffer.alloc(10)
  header.write('ID3', 0, 'latin1')
  header.writeUInt8(3, 3) // version 2.3
  header.writeUInt8(0, 4) // revision
  header.writeUInt8(0, 5) // flags: none
  // Syncsafe size of the tag body, excluding this header.
  encodeSyncsafe(body.length).copy(header, 6)

  return Buffer.concat([header, body])
}

/**
 * Strips an existing ID3v2 header from the front of an MP3.
 *
 * Without this, writing a tag to a file that already has one stacks two tags and
 * most players read only the first — so the new metadata would be silently
 * ignored while the old artwork stayed.
 */
export function stripId3v2(buf: Uint8Array): Uint8Array {
  if (buf.length < 10) return buf
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return buf

  const size = readSyncsafe(buf, 6)
  const total = 10 + size
  if (total > buf.length) return buf

  return buf.subarray(total)
}

function readSyncsafe(buf: Uint8Array, offset: number): number {
  let value = 0
  for (let i = 0; i < 4; i += 1) {
    value = (value << 7) | ((buf[offset + i] ?? 0) & 0x7f)
  }
  return value
}
