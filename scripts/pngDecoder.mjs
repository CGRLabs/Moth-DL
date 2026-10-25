/**
 * Minimal PNG reader for the Moth icon pipeline.
 *
 * Reads what `iconEncoder.mjs` writes and what the brand source is: 8-bit
 * RGBA, non-interlaced, IHDR/IDAT/IEND. Everything else (other bit depths,
 * colour types, interlace) fails loudly — the icon scripts must never
 * silently resample a pixel format they do not understand.
 *
 * Only `node:zlib` (inflate) is used; no new dependencies.
 */

import { inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Decodes a PNG buffer into raw pixels.
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('decodePng: bad PNG signature')
  }

  let offset = 8
  let width = 0
  let height = 0
  let seenIhdr = false
  const idatParts = []

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`decodePng: truncated ${type} chunk`)
    }
    const data = buffer.subarray(dataStart, dataEnd)

    if (type === 'IHDR') {
      if (seenIhdr) throw new Error('decodePng: duplicate IHDR')
      seenIhdr = true
      if (length !== 13) throw new Error('decodePng: corrupt IHDR')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]
      const colorType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8 || colorType !== 6) {
        throw new Error(
          `decodePng: RGBA8 only (got depth=${bitDepth} color=${colorType}); refusing to guess`
        )
      }
      if (interlace !== 0) {
        throw new Error('decodePng: interlaced PNG not supported; save the source without interlace')
      }
    } else if (type === 'IDAT') {
      if (!seenIhdr) throw new Error('decodePng: IDAT before IHDR')
      idatParts.push(data)
    } else if (type === 'IEND') {
      break
    }
    // Ancillary chunks (tEXt, pHYs, iCCP, …) carry no pixels: skip by length.
    offset = dataEnd + 4 // +4: CRC, validated by the writer, unchecked here
  }

  if (!seenIhdr) throw new Error('decodePng: missing IHDR')
  if (idatParts.length === 0) throw new Error('decodePng: missing IDAT')

  const raw = inflateSync(Buffer.concat(idatParts))
  const stride = width * 4
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`decodePng: inflated ${raw.length} bytes, expected ${(stride + 1) * height}`)
  }

  const rgba = Buffer.alloc(stride * height)
  const prev = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    const filter = raw[rowStart]
    raw.copy(current, 0, rowStart + 1, rowStart + 1 + stride)

    switch (filter) {
      case 0: // None
        break
      case 1: // Sub
        for (let i = 4; i < stride; i += 1) current[i] = (current[i] + current[i - 4]) & 0xff
        break
      case 2: // Up
        for (let i = 0; i < stride; i += 1) current[i] = (current[i] + prev[i]) & 0xff
        break
      case 3: // Average
        for (let i = 0; i < stride; i += 1) {
          const a = i >= 4 ? current[i - 4] : 0
          current[i] = (current[i] + ((a + prev[i]) >> 1)) & 0xff
        }
        break
      case 4: // Paeth
        for (let i = 0; i < stride; i += 1) {
          const a = i >= 4 ? current[i - 4] : 0
          const b = prev[i]
          const c = i >= 4 ? prev[i - 4] : 0
          current[i] = (current[i] + paethPredictor(a, b, c)) & 0xff
        }
        break
      default:
        throw new Error(`decodePng: unknown filter type ${filter} on row ${y}`)
    }

    current.copy(rgba, y * stride)
    current.copy(prev)
  }

  return { width, height, rgba }
}

function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}
