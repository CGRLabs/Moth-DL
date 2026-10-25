/**
 * ISO-BMFF (MP4/MOV) box traversal.
 *
 * A box is `[4-byte size][4-byte type][payload]`. Two size encodings exist and
 * getting either wrong produces a parser that reads garbage or loops forever:
 *
 *  - `size === 1` means a 64-bit extended size follows the type.
 *  - `size === 0` means the box extends to the end of its parent.
 *
 * `moov` is frequently past the first 256 KB — it sits after `mdat` on
 * non-faststart files — so callers that need it must page through the file
 * rather than assuming it is near the front.
 */

export interface Box {
  type: string
  /** Offset of the payload within the buffer. */
  offset: number
  /** Payload length in bytes. */
  size: number
  /** Offset of the box header itself. */
  headerOffset: number
}

export interface BoxReader {
  /** Reads a box header at `offset`. Returns null when out of bounds. */
  readBox(offset: number): Box | null
  /**
   * Reads `length` bytes at `offset`, clamped to the available data.
   *
   * Needed because `data` atom payloads are read directly rather than through
   * `readBox`, and because callers page through a file in windows.
   */
  read(offset: number, length: number): Uint8Array
  /** Total bytes available to this reader. */
  readonly length: number
}

/** Reads a 32-bit big-endian unsigned integer. */
function readUint32(buf: Uint8Array, offset: number): number {
  const a = buf[offset] ?? 0
  const b = buf[offset + 1] ?? 0
  const c = buf[offset + 2] ?? 0
  const d = buf[offset + 3] ?? 0
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

function readUint64(buf: Uint8Array, offset: number): number {
  // Values above 2^53 lose precision, but no media file is that large and the
  // only use here is bounds checking.
  const high = readUint32(buf, offset)
  const low = readUint32(buf, offset + 4)
  return high * 0x100000000 + low
}

function typeAt(buf: Uint8Array, offset: number): string {
  const a = buf[offset] ?? 0
  const b = buf[offset + 1] ?? 0
  const c = buf[offset + 2] ?? 0
  const d = buf[offset + 3] ?? 0
  return String.fromCharCode(a, b, c, d)
}

/**
 * A reader over an in-memory buffer.
 *
 * `limit` lets a caller restrict traversal to a parent box's payload without
 * slicing, which matters when the buffer is a large file.
 */
export function bufferReader(buf: Uint8Array, limit?: number): BoxReader {
  const totalLength = limit === undefined ? buf.length : Math.min(buf.length, limit)
  return {
    length: totalLength,
    read(offset: number, length: number): Uint8Array {
      if (offset < 0 || offset >= totalLength) return new Uint8Array(0)
      const end = Math.min(offset + length, totalLength)
      return buf.subarray(offset, end)
    },
    readBox(offset: number): Box | null {
      if (offset < 0 || offset + 8 > totalLength) return null

      const declared = readUint32(buf, offset)
      const type = typeAt(buf, offset + 4)
      const headerOffset = offset

      let headerSize = 8
      let size = declared

      if (declared === 1) {
        if (offset + 16 > totalLength) return null
        size = readUint64(buf, offset + 8)
        headerSize = 16
      } else if (declared === 0) {
        // Extends to the end of the available data.
        size = totalLength - offset
      }

      if (size < headerSize || offset + size > totalLength) {
        // A corrupt size. Stop rather than hand back a box that would read past
        // the buffer.
        return null
      }

      return { type, offset: offset + headerSize, size: size - headerSize, headerOffset }
    }
  }
}

/**
 * Finds a box by path, e.g. `['moov', 'udta', 'meta', 'ilst']`.
 *
 * Each level scans only within its parent's payload. Scanning from offset 0
 * instead would read the outer `moov` box, skip to its end in a single step, and
 * never descend into the children — which is exactly the bug this prevents.
 *
 * `meta` is a full box, so its payload begins with a 4-byte version/flags field
 * that must be skipped before its children. Returns null if any segment is
 * missing.
 */
export function findBox(reader: BoxReader, path: readonly string[]): Box | null {
  let parentStart = 0
  let parentEnd = reader.length
  let current: Box | null = null

  for (const wanted of path) {
    let found: Box | null = null
    let offset = parentStart

    while (offset + 8 <= parentEnd) {
      const box = reader.readBox(offset)
      if (!box) break
      if (box.type === wanted) {
        found = box
        break
      }
      offset = box.offset + box.size
    }

    if (!found) return null

    // `meta` carries a version/flags prefix before its child boxes.
    const payloadStart = found.type === 'meta' ? found.offset + 4 : found.offset
    current = {
      ...found,
      offset: payloadStart,
      size: found.size - (payloadStart - found.offset)
    }
    parentStart = payloadStart
    parentEnd = payloadStart + current.size
  }

  return current
}

/**
 * Lists the immediate children of a box.
 *
 * Used to enumerate `ilst` atoms and to check whether a `udta` already exists
 * before creating one.
 */
export function childBoxes(reader: BoxReader, parent: Box): Box[] {
  const out: Box[] = []
  let offset = parent.offset
  const end = parent.offset + parent.size

  while (offset + 8 <= end) {
    const box = reader.readBox(offset)
    if (!box) break
    out.push(box)
    const headerSize = box.offset - box.headerOffset
    if (box.size + headerSize <= 0) break
    offset = box.offset + box.size
  }

  return out
}
