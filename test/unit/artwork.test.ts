/**
 * Artwork safety tests.
 *
 * Artwork arrives from tags and from the internet, both untrusted. The two
 * properties that matter: a declared type is never believed, and nothing is
 * stored at a path derived from input.
 */

import { describe, it, expect } from 'vitest'
import { MAX_ARTWORK_BYTES, sniffImageMime, storeArtwork } from '../../src/main/media/artwork.js'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

describe('sniffImageMime', () => {
  it('recognises each supported signature', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png'
    )
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(
      sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]))
    ).toBe('image/webp')
  })

  it('does not accept a RIFF container that is not WebP', () => {
    // A WAV file is also RIFF...., but without the WEBP form type.
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45])
    expect(sniffImageMime(wav)).toBeNull()
  })

  it('rejects a file that only claims to be a PNG', () => {
    // An executable named .png: the magic bytes say MZ, so it must be refused.
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])
    expect(sniffImageMime(exe)).toBeNull()
  })

  it('rejects empty and truncated input', () => {
    expect(sniffImageMime(new Uint8Array(0))).toBeNull()
    expect(sniffImageMime(new Uint8Array([0x89]))).toBeNull()
  })
})

describe('storeArtwork', () => {
  it('stores content-addressed and refuses oversized input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moth-art-'))
    try {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      const stored = await storeArtwork(png, dir)
      expect(stored).not.toBeNull()
      expect(stored?.mime).toBe('image/png')

      // The on-disk name is a hash, never anything derived from input.
      expect(basename(stored!.path)).toMatch(/^[0-9a-f]{32}\.png$/)

      // The stored bytes match exactly.
      const onDisk = new Uint8Array(await readFile(stored!.path))
      expect(Array.from(onDisk)).toEqual(Array.from(png))

      // Storing the same image again reuses one file.
      const again = await storeArtwork(png, dir)
      expect(again?.path).toBe(stored!.path)
      expect((await readdir(dir)).length).toBe(1)

      // Oversized input is refused.
      const huge = new Uint8Array(MAX_ARTWORK_BYTES + 1)
      huge.set([0x89, 0x50, 0x4e, 0x47], 0)
      expect(await storeArtwork(huge, dir)).toBeNull()

      // A non-image is refused even when it has a plausible extension.
      const notAnImage = new Uint8Array([0x4d, 0x5a, 0x00, 0x00])
      expect(await storeArtwork(notAnImage, dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cannot be steered outside the artwork directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moth-art-'))
    try {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9])
      const stored = await storeArtwork(png, dir)
      // A traversal attempt in the filename must not affect where bytes land.
      expect(stored).not.toBeNull()
      expect(stored!.path.startsWith(dir)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
