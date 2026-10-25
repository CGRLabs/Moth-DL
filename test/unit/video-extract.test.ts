/**
 * FFmpeg archive extraction: pure-JS zip fallback + traversal guards.
 * No network, no real vendor archives — zips are built in-memory.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'
import {
  extractBinaryFromZipBuffer,
  extractFfmpegArchive,
  parseZipCentralDirectory
} from '../../src/main/video/extract.js'

interface ZipInput {
  name: string
  data: Buffer
  method?: 0 | 8
  externalAttrs?: number
}

function buildZip(files: ZipInput[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8')
    const method = file.method ?? 8
    const compressed = method === 0 ? file.data : deflateRawSync(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(63, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(file.data.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt32LE(file.externalAttrs ?? 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, nameBuf)
    offset += local.length + nameBuf.length + compressed.length
  }
  const centralStart = offset
  const centralBlob = Buffer.concat(central)
  chunks.push(centralBlob)
  offset += centralBlob.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBlob.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  chunks.push(eocd)
  return Buffer.concat(chunks)
}

describe('parseZipCentralDirectory', () => {
  it('lists entries with symlink flags', () => {
    const zip = buildZip([
      { name: 'bin/ffmpeg', data: Buffer.from('elf'), externalAttrs: 0 },
      { name: 'link', data: Buffer.from('x'), externalAttrs: (0o120777 * 65536) >>> 0 }
    ])
    const entries = parseZipCentralDirectory(zip)
    expect(entries).toHaveLength(2)
    expect(entries[1]?.isSymlink).toBe(true)
  })

  it('rejects garbage', () => {
    expect(() => parseZipCentralDirectory(Buffer.from('not a zip'))).toThrow()
  })
})

describe('extractBinaryFromZipBuffer', () => {
  it('extracts a nested deflated binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moth-zip-'))
    const zip = buildZip([
      { name: 'notes.txt', data: Buffer.from('hi'), method: 0 },
      { name: 'ffmpeg-7.1-essentials/bin/ffmpeg.exe', data: Buffer.from('MZ-fake-binary') }
    ])
    const out = await extractBinaryFromZipBuffer(zip, 'ffmpeg.exe', dir)
    expect(out).toBe(join(dir, 'ffmpeg.exe'))
    expect(readFileSync(out, 'utf8')).toBe('MZ-fake-binary')
  })

  it('extracts stored (uncompressed) entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moth-zip-'))
    const zip = buildZip([{ name: 'ffmpeg', data: Buffer.from('elf-bytes'), method: 0 }])
    const out = await extractBinaryFromZipBuffer(zip, 'ffmpeg', dir)
    expect(readFileSync(out, 'utf8')).toBe('elf-bytes')
  })

  it('never writes outside the destination (zip-slip entry still lands inside)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moth-zip-'))
    const zip = buildZip([
      { name: '../../ffmpeg', data: Buffer.from('evil? no — contained') }
    ])
    const out = await extractBinaryFromZipBuffer(zip, 'ffmpeg', dir)
    expect(out).toBe(join(dir, 'ffmpeg'))
    expect(readFileSync(out, 'utf8')).toBe('evil? no — contained')
  })

  it('skips symlinks when looking for the binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moth-zip-'))
    const zip = buildZip([
      { name: 'ffmpeg', data: Buffer.from('/elsewhere'), externalAttrs: (0o120777 * 65536) >>> 0 },
      { name: 'real/ffmpeg', data: Buffer.from('real-binary') }
    ])
    const out = await extractBinaryFromZipBuffer(zip, 'ffmpeg', dir)
    expect(readFileSync(out, 'utf8')).toBe('real-binary')
  })

  it('throws when the binary is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moth-zip-'))
    const zip = buildZip([{ name: 'readme.txt', data: Buffer.from('nope') }])
    await expect(extractBinaryFromZipBuffer(zip, 'ffmpeg', dir)).rejects.toThrow(/does not contain/)
  })
})

describe('extractFfmpegArchive (tar fallback)', () => {
  it('falls back to the built-in zip reader when tar is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moth-ff-'))
    await mkdir(dir, { recursive: true })
    const zip = buildZip([
      { name: 'ffmpeg-7.1/bin/ffmpeg.exe', data: Buffer.from('MZ-fake') }
    ])
    const archivePath = join(dir, 'ffmpeg-release-essentials.zip')
    await writeFile(archivePath, zip)
    const out = await extractFfmpegArchive(archivePath, dir, 'ffmpeg.exe', {
      tarBinary: 'definitely-not-a-real-tar-binary-xyz'
    })
    expect(out).toBe(join(dir, 'ffmpeg.exe'))
    expect(readFileSync(out, 'utf8')).toBe('MZ-fake')
  })
})
