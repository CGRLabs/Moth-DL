/**
 * Byte-to-text decoding shared by the tag parsers.
 *
 * `Uint8Array.prototype.toString()` takes no arguments and joins with commas —
 * only `Buffer.toString(encoding)` interprets an encoding. Every `subarray()`
 * result is a `Uint8Array`, so this wrapper is required throughout the media
 * layer. It lives in its own module because ID3, MP4 and Vorbis all need it.
 */

/** Decodes bytes using a Node buffer encoding, without copying the payload. */
export function toText(bytes: Uint8Array, encoding: BufferEncoding): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding)
}

/**
 * Decodes UTF-16 big-endian.
 *
 * Node's `BufferEncoding` union has `utf16le` but not `utf16be`, so the byte
 * order has to be handled manually. Tag text is short, so a character loop is
 * cheaper than copying the payload to swap it.
 */
export function decodeUtf16be(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)
    out += String.fromCharCode(code)
  }
  return out
}
