/**
 * Icon pipeline tests.
 *
 * The tray icon once shipped as a 0-byte file, so every emitted artefact is
 * asserted non-empty here alongside dimensions and a decode→encode→decode
 * pixel-identity round trip over the canonical new Moth icon.
 */

import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from '../../scripts/pngDecoder.mjs'
import { downscaleBox, encodePng } from '../../scripts/iconEncoder.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RES = join(REPO_ROOT, 'resources')
const ICO_PATH = join(RES, 'moth.ico')

interface EmittedPng {
  path: string
  size: number
}

const EMITTED_PNGS: EmittedPng[] = [
  { path: join(RES, 'icon.png'), size: 256 },
  { path: join(RES, 'trayIcon.png'), size: 32 },
  { path: join(RES, 'trayIcon@2x.png'), size: 64 },
  { path: join(REPO_ROOT, 'browser-extension', 'chrome', 'icon16.png'), size: 16 },
  { path: join(REPO_ROOT, 'browser-extension', 'chrome', 'icon48.png'), size: 48 },
  { path: join(REPO_ROOT, 'browser-extension', 'chrome', 'icon128.png'), size: 128 },
  { path: join(REPO_ROOT, 'browser-extension', 'firefox', 'icon16.png'), size: 16 },
  { path: join(REPO_ROOT, 'browser-extension', 'firefox', 'icon48.png'), size: 48 },
  { path: join(REPO_ROOT, 'browser-extension', 'firefox', 'icon128.png'), size: 128 }
]

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

describe('moth icon pipeline', () => {
  it('decodes the new Moth icon source as 380x380 RGBA', () => {
    const source = decodePng(readFileSync(join(RES, 'newmothicon.png')))
    expect(source.width).toBe(380)
    expect(source.height).toBe(380)
    expect(source.rgba.length).toBe(380 * 380 * 4)
  })

  it('round-trips decode→encode→decode pixel-identical', () => {
    const first = decodePng(readFileSync(join(RES, 'newmothicon.png')))
    const encoded = encodePng(first.width, first.height, first.rgba)
    const second = decodePng(encoded)
    expect(second.width).toBe(first.width)
    expect(second.height).toBe(first.height)
    expect(second.rgba.equals(first.rgba)).toBe(true)
  })

  it('decodes all five PNG filter types', () => {
    // 2x5 image, one row per filter type; stored bytes are hand-computed so
    // the decoder must invert Sub/Up/Average/Paeth exactly to match.
    const raw = Buffer.from([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
      1, 10, 20, 30, 40, 40, 40, 40, 40,
      2, 90, 81, 72, 63, 60, 51, 42, 33,
      3, 226, 228, 229, 231, 231, 234, 236, 239,
      4, 243, 242, 241, 240, 247, 246, 245, 244
    ])
    const decoded = decodePng(buildPng(2, 5, raw))
    expect(decoded.width).toBe(2)
    expect(decoded.height).toBe(5)
    expect(decoded.rgba.equals(Buffer.from([
      1, 2, 3, 4, 5, 6, 7, 8,
      10, 20, 30, 40, 50, 60, 70, 80,
      100, 101, 102, 103, 110, 111, 112, 113,
      20, 22, 24, 26, 40, 44, 48, 52,
      7, 8, 9, 10, 11, 12, 13, 14
    ]))).toBe(true)
  })

  it('emits every PNG at its specified dimensions', () => {
    for (const target of EMITTED_PNGS) {
      const decoded = decodePng(readFileSync(target.path))
      expect(decoded.width).toBe(target.size)
      expect(decoded.height).toBe(target.size)
    }
  })

  it('uses the same new artwork in every generated icon', () => {
    const source = decodePng(readFileSync(join(RES, 'newmothicon.png')))
    for (const target of EMITTED_PNGS) {
      const expected = downscaleBox(source.rgba, source.width, target.size)
      const emitted = decodePng(readFileSync(target.path))
      expect(emitted.rgba.equals(expected), target.path).toBe(true)
    }
  })

  it('emits no empty files (the 0-byte tray regression)', () => {
    for (const target of EMITTED_PNGS) {
      expect(statSync(target.path).size).toBeGreaterThan(0)
    }
    expect(statSync(ICO_PATH).size).toBeGreaterThan(0)
  })

  it('packs moth.ico with decodable 16–256 entries', () => {
    const ico = readFileSync(ICO_PATH)
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(ICO_SIZES.length)

    const sizes: number[] = []
    for (let i = 0; i < ICO_SIZES.length; i += 1) {
      const entry = 6 + i * 16
      const width = ico.readUInt8(entry)
      const height = ico.readUInt8(entry + 1)
      const length = ico.readUInt32LE(entry + 8)
      const dataOffset = ico.readUInt32LE(entry + 12)
      const size = width === 0 ? 256 : width
      expect(height === 0 ? 256 : height).toBe(size)
      expect(length).toBeGreaterThan(0)
      const embedded = decodePng(ico.subarray(dataOffset, dataOffset + length))
      expect(embedded.width).toBe(size)
      expect(embedded.height).toBe(size)
      sizes.push(size)
    }
    expect(sizes).toEqual(ICO_SIZES)
  })

  it('no longer ships the TIRI-era container', () => {
    expect(existsSync(join(RES, 'tiri.ico'))).toBe(false)
  })
})

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = 0xffffffff
  for (let i = 0; i < body.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ body[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  const trailer = Buffer.alloc(4)
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([length, body, trailer])
}

/** Builds a minimal RGBA8 test PNG around pre-filtered scanlines. */
function buildPng(width: number, height: number, filtered: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(filtered, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
