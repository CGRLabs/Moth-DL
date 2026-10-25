/**
 * Shared PNG encoder, box-filter resampler and ICO packer for the Moth icons.
 *
 * The artwork comes from `resources/newmothicon.png` (decoded by
 * `pngDecoder.mjs`); this module only encodes and resamples — no binary blobs
 * in version control whose provenance nobody can check.
 */

import { deflateSync } from 'node:zlib'

export const SIZES = [16, 48, 128]

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let crc = -1
  for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** Encodes an RGBA pixel buffer as a PNG. */
export function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Area-average (box-filter) downscale of a square RGBA image.
 *
 * Box is the correct filter for shrinking: every source texel contributes to
 * exactly the destination pixels it overlaps, weighted by overlap area, so no
 * high-frequency detail aliases into moire. Fancier filters gain nothing here.
 */
export function downscaleBox(src, srcSize, dstSize) {
  if (!Number.isInteger(srcSize) || srcSize <= 0) throw new Error('downscaleBox: bad srcSize')
  if (!Number.isInteger(dstSize) || dstSize <= 0) throw new Error('downscaleBox: bad dstSize')
  if (dstSize > srcSize) throw new Error('downscaleBox: upscale refused, this is a shrinker')
  if (src.length !== srcSize * srcSize * 4) throw new Error('downscaleBox: src length mismatch')

  const dst = Buffer.alloc(dstSize * dstSize * 4)
  const scale = srcSize / dstSize

  for (let dy = 0; dy < dstSize; dy += 1) {
    const y0 = dy * scale
    const y1 = y0 + scale
    const syFrom = Math.floor(y0)
    const syTo = Math.min(srcSize - 1, Math.ceil(y1) - 1)
    for (let dx = 0; dx < dstSize; dx += 1) {
      const x0 = dx * scale
      const x1 = x0 + scale
      const sxFrom = Math.floor(x0)
      const sxTo = Math.min(srcSize - 1, Math.ceil(x1) - 1)

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let weight = 0
      for (let sy = syFrom; sy <= syTo; sy += 1) {
        const yOverlap = Math.min(y1, sy + 1) - Math.max(y0, sy)
        for (let sx = sxFrom; sx <= sxTo; sx += 1) {
          const xOverlap = Math.min(x1, sx + 1) - Math.max(x0, sx)
          const w = xOverlap * yOverlap
          const i = (sy * srcSize + sx) * 4
          // Premultiply by alpha while accumulating so translucent edges
          // average against transparent instead of against black.
          const sa = src[i + 3] / 255
          r += src[i] * sa * w
          g += src[i + 1] * sa * w
          b += src[i + 2] * sa * w
          a += src[i + 3] * w
          weight += w
        }
      }
      const o = (dy * dstSize + dx) * 4
      const outA = a / weight
      dst[o + 3] = Math.round(outA)
      if (outA > 0) {
        const un = 255 / outA
        dst[o] = Math.round((r / weight) * un)
        dst[o + 1] = Math.round((g / weight) * un)
        dst[o + 2] = Math.round((b / weight) * un)
      } else {
        dst[o] = 0
        dst[o + 1] = 0
        dst[o + 2] = 0
      }
    }
  }

  return dst
}

/**
 * Packs rendered RGBA images into a single Windows `.ico`.
 *
 * Windows shortcuts need a real `.ico`; PNG alone is not accepted for the icon
 * reference even though the image format itself is fine (Vista+ allows PNG
 * payloads inside an ICO container). Multi-size so the shortcut looks correct
 * at every DPI and in both the small and large icon views.
 *
 * @param {Array<{ size: number, rgba: Buffer }>} images square images to pack
 */
export function writeIco(images) {
  if (images.length === 0 || images.length > 255) throw new Error('writeIco: need 1..255 images')
  const pngs = images.map((image) => {
    if (image.rgba.length !== image.size * image.size * 4) {
      throw new Error(`writeIco: pixel length mismatch for size ${image.size}`)
    }
    return { size: image.size, png: encodePng(image.size, image.size, image.rgba) }
  })

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = []
  let offset = 6 + pngs.length * 16
  for (const image of pngs) {
    const entry = Buffer.alloc(16)
    // 256 is encoded as 0; the format uses a single byte.
    entry[0] = image.size >= 256 ? 0 : image.size
    entry[1] = image.size >= 256 ? 0 : image.size
    entry[2] = 0 // palette size
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(image.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += image.png.length
    entries.push(entry)
  }

  return Buffer.concat([header, ...entries, ...pngs.map((i) => i.png)])
}
