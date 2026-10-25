/**
 * Chunk planning.
 *
 * The chunk map is the persistence format for "what have we downloaded", so
 * its correctness is the foundation of crash recovery. These tests pin the
 * invariants that `validateChunkMap` exists to enforce.
 */

import { describe, it, expect } from 'vitest'
import {
  chooseChunkSize,
  chooseConnections,
  completedBytes,
  countComplete,
  parseContentRange,
  planChunks,
  rangeHeaderFor,
  revalidateChunks,
  toBitmap,
  totalSize,
  validateChunkMap
} from '../../src/main/core/planner.js'
import { MIN_CHUNK_SIZE } from '../../src/shared/constants.js'
import type { Chunk } from '../../src/shared/types.js'

describe('chooseChunkSize', () => {
  it('never exceeds the requested size for large files', () => {
    expect(chooseChunkSize(100 * 1024 * 1024, 2 * 1024 * 1024)).toBe(2 * 1024 * 1024)
  })

  it('collapses a small file to a single chunk', () => {
    const size = 1000
    expect(chooseChunkSize(size, 2 * 1024 * 1024)).toBe(size)
  })

  it('honours a deliberately small request', () => {
    // The planner does not impose a floor; `chunkSizeSchema` is what rejects a
    // sub-64 KiB user setting, so clamping here would only hide the request.
    expect(chooseChunkSize(10 * 1024 * 1024, 1)).toBe(1)
  })

  it('clamps a request above the maximum', () => {
    const huge = 1024 * 1024 * 1024 // 1 GiB request
    expect(chooseChunkSize(200 * 1024 * 1024, huge)).toBe(64 * 1024 * 1024)
  })

  it('never returns a non-positive size for a positive file', () => {
    for (const size of [1, 999, MIN_CHUNK_SIZE, 5 * 1024 * 1024]) {
      expect(chooseChunkSize(size)).toBeGreaterThan(0)
      expect(chooseChunkSize(size)).toBeLessThanOrEqual(size)
    }
  })
})

describe('planChunks', () => {
  // Sizes are kept at or above MIN_CHUNK_SIZE because `chooseChunkSize`
  // deliberately collapses anything smaller into a single chunk.
  const KB = 1024
  const MB = 1024 * 1024

  it('produces a contiguous, complete, non-overlapping map', () => {
    const size = 10 * 1024 + 500
    const chunkSize = 2 * 1024
    const chunks = planChunks({ downloadId: 'd1', fileSize: size, desiredChunkSize: chunkSize })

    expect(chunks.length).toBe(Math.ceil(size / chunkSize))
    expect(totalSize(chunks)).toBe(size)
    expect(chunks[0]?.start).toBe(0)
    expect(chunks[chunks.length - 1]?.end).toBe(size - 1)

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!
      expect(chunk.index).toBe(i)
      expect(chunk.size).toBe(chunk.end - chunk.start + 1)
      expect(chunk.status).toBe('pending')
      if (i > 0) expect(chunk.start).toBe(chunks[i - 1]!.end + 1)
    }
    expect(validateChunkMap(chunks, size).valid).toBe(true)
  })

  it('makes the last chunk absorb the remainder', () => {
    // 2 full 4 KiB chunks plus a 96-byte tail.
    const size = 2 * 4 * 1024 + 96
    const chunks = planChunks({ downloadId: 'd', fileSize: size, desiredChunkSize: 4 * 1024 })
    expect(chunks.length).toBe(3)
    expect(chunks[2]?.size).toBe(96)
    expect(chunks[2]?.end).toBe(size - 1)
  })

  it('creates exactly one chunk for a single-chunk file', () => {
    const chunks = planChunks({ downloadId: 'd', fileSize: 500, desiredChunkSize: 64 * 1024 })
    expect(chunks.length).toBe(1)
    expect(chunks[0]?.start).toBe(0)
    expect(chunks[0]?.end).toBe(499)
  })

  it('collapses a file below the minimum chunk size into one chunk', () => {
    // Deliberate: sub-chunk files are not worth splitting.
    const chunks = planChunks({ downloadId: 'd', fileSize: 4 * 1024, desiredChunkSize: 64 * 1024 })
    expect(chunks.length).toBe(1)
    expect(totalSize(chunks)).toBe(4 * 1024)
  })

  it('grows the chunk size to respect maxChunks', () => {
    const size = 10 * MB
    const chunks = planChunks({
      downloadId: 'd',
      fileSize: size,
      desiredChunkSize: 64 * KB,
      maxChunks: 10
    })
    expect(chunks.length).toBeLessThanOrEqual(10)
    expect(totalSize(chunks)).toBe(size)
    expect(validateChunkMap(chunks, size).valid).toBe(true)
  })

  it('rejects a non-positive file size', () => {
    expect(() => planChunks({ downloadId: 'd', fileSize: 0 })).toThrow(RangeError)
    expect(() => planChunks({ downloadId: 'd', fileSize: -1 })).toThrow(RangeError)
    expect(() => planChunks({ downloadId: 'd', fileSize: Number.NaN })).toThrow(RangeError)
  })
})

describe('validateChunkMap', () => {
  const size = 10 * 1024
  const good = planChunks({ downloadId: 'd', fileSize: size, desiredChunkSize: 2 * 1024 })

  it('accepts a well-formed map', () => {
    expect(validateChunkMap(good, size)).toEqual({ valid: true })
  })

  it('rejects an empty map', () => {
    expect(validateChunkMap([], size).valid).toBe(false)
  })

  it('rejects a map that does not start at zero', () => {
    // Shift the first chunk's whole range so its internal size stays consistent
    // and the start check is what trips.
    const broken = good.map((c, i) => (i === 0 ? { ...c, start: c.start + 2, end: c.end + 2 } : c))
    const result = validateChunkMap(broken, size)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/does not start at byte 0/)
  })

  it('rejects a map that does not reach the end', () => {
    const broken = good.slice(0, -1)
    const result = validateChunkMap(broken, size)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/does not reach the end/)
  })

  it('rejects a gap between two chunks', () => {
    const broken = good.map((c, i) => (i === 2 ? { ...c, start: c.start + 10, end: c.end + 10 } : c))
    const result = validateChunkMap(broken, size)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/gap or overlap/)
  })

  it('rejects a chunk extending past the end of the file', () => {
    const broken = good.map((c, i) => (i === 1 ? { ...c, end: c.end + 50 } : c))
    expect(validateChunkMap(broken, size).valid).toBe(false)
  })

  it('rejects a size that disagrees with the range', () => {
    const broken = good.map((c) => ({ ...c, size: c.size + 1 }))
    const result = validateChunkMap(broken, size)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/size does not match/)
  })

  it('rejects out-of-sequence indices', () => {
    const broken = good.map((c, i) => (i === 1 ? { ...c, index: 5 } : c))
    expect(validateChunkMap(broken, size).valid).toBe(false)
  })

  it('rejects an unknown file size', () => {
    expect(validateChunkMap(good, 0).valid).toBe(false)
  })
})

describe('revalidateChunks', () => {
  it('returns the same map when it is already valid', () => {
    const size = 10 * 1024
    const chunks = planChunks({ downloadId: 'd', fileSize: size, desiredChunkSize: 2 * 1024 })
    const result = revalidateChunks(chunks, 'd', size, 2 * 1024)
    expect(result).toHaveLength(chunks.length)
    expect(result[0]).toBe(chunks[0])
  })

  it('salvages completed ranges when the remote file grew', () => {
    // The map was built for an 8 KiB file and is now invalid for 12 KiB, so it
    // must be rebuilt. Progress that is still fully covered must be kept.
    const oldSize = 8 * 1024
    const old = planChunks({ downloadId: 'd', fileSize: oldSize, desiredChunkSize: 2 * 1024 }).map(
      (c, i) => (i < 2 ? { ...c, status: 'complete' as const, bytesWritten: c.size } : c)
    )
    const newSize = 12 * 1024

    const result = revalidateChunks(old, 'd', newSize, 2 * 1024)
    expect(validateChunkMap(result, newSize).valid).toBe(true)
    expect(result[result.length - 1]?.end).toBe(newSize - 1)

    // Bytes 0-4095 were downloaded and are still present, so the new chunks
    // covering that range stay complete.
    expect(result[0]?.status).toBe('complete')
    expect(result[1]?.status).toBe('complete')
    // Everything past the old file must be pending.
    expect(result[2]?.status).toBe('pending')
    expect(result.every((c) => c.index <= 1 || c.status === 'pending')).toBe(true)
  })

  it('does not salvage a chunk that is only partially covered', () => {
    // A single completed range must cover a whole new chunk, otherwise the new
    // chunk would be marked complete with a hole inside it.
    const oldSize = 6 * 1024
    const old = planChunks({ downloadId: 'd', fileSize: oldSize, desiredChunkSize: 2 * 1024 }).map(
      (c, i) => (i === 0 ? { ...c, status: 'complete' as const, bytesWritten: c.size } : c)
    )
    // Rebuild against a larger file with 4 KiB chunks: new chunk 0 (0-4095) is
    // only half covered by the old chunk 0 (0-2047).
    const result = revalidateChunks(old, 'd', 8 * 1024, 4 * 1024)
    expect(validateChunkMap(result, 8 * 1024).valid).toBe(true)
    expect(result.every((c) => c.status === 'pending')).toBe(true)
  })

  it('rebuilds from scratch when the old map is empty', () => {
    const size = 10 * 1024
    const result = revalidateChunks([], 'd', size, 2 * 1024)
    expect(validateChunkMap(result, size).valid).toBe(true)
    expect(result.every((c) => c.status === 'pending')).toBe(true)
  })
})

describe('progress helpers', () => {
  const chunks: Chunk[] = planChunks({
    downloadId: 'd',
    fileSize: 8 * 1024,
    desiredChunkSize: 2 * 1024
  }).map((c, i) =>
    i % 2 === 0
      ? { ...c, status: 'complete' as const, bytesWritten: c.size }
      : { ...c, status: 'pending' as const, bytesWritten: 0 }
  )

  it('counts completed chunks', () => {
    expect(countComplete(chunks)).toBe(2)
  })

  it('sums only completed bytes', () => {
    expect(completedBytes(chunks)).toBe(4 * 1024)
    expect(totalSize(chunks)).toBe(8 * 1024)
  })

  it('produces a bitmap matching the chunk order', () => {
    expect(toBitmap(chunks)).toEqual([1, 0, 1, 0])
  })
})

describe('HTTP range helpers', () => {
  it('builds an inclusive Range header', () => {
    expect(rangeHeaderFor({ start: 0, end: 1023 })).toBe('bytes=0-1023')
    expect(rangeHeaderFor({ start: 1024, end: 2047 })).toBe('bytes=1024-2047')
  })

  it('parses a Content-Range header with a known total', () => {
    expect(parseContentRange('bytes 0-1023/4096')).toEqual({
      start: 0,
      end: 1023,
      total: 4096
    })
  })

  it('parses a Content-Range header with an unknown total', () => {
    expect(parseContentRange('bytes 0-1023/*')).toEqual({
      start: 0,
      end: 1023,
      total: null
    })
  })

  it('returns null for malformed or missing headers', () => {
    expect(parseContentRange(null)).toBeNull()
    expect(parseContentRange('')).toBeNull()
    expect(parseContentRange('items 0-10/20')).toBeNull()
    expect(parseContentRange('bytes abc-def/20')).toBeNull()
  })
})

describe('chooseConnections', () => {
  it('uses a single connection for tiny files', () => {
    expect(chooseConnections({ fileSize: 1000, desired: 8, chunkSize: 64 * 1024 })).toBe(1)
  })

  it('never exceeds the number of available chunks', () => {
    // 640 KiB file, 128 KiB chunks -> 5 chunks available, but a file this
    // small is additionally capped at 2 connections.
    expect(
      chooseConnections({ fileSize: 10 * MIN_CHUNK_SIZE, desired: 16, chunkSize: 2 * MIN_CHUNK_SIZE })
    ).toBe(2)
    // Only one chunk exists, so one connection regardless of the request.
    expect(
      chooseConnections({ fileSize: MIN_CHUNK_SIZE, desired: 16, chunkSize: 4 * MIN_CHUNK_SIZE })
    ).toBe(1)
  })

  it('honours the configured value for a large file', () => {
    // A 500 MB file: the user's setting must be respected, not clamped to 4.
    expect(
      chooseConnections({ fileSize: 500 * 1024 * 1024, desired: 8, chunkSize: 1024 * 1024 })
    ).toBe(8)
  })

  it('honours the configured maximum', () => {
    expect(
      chooseConnections({
        fileSize: 500 * 1024 * 1024,
        desired: 64,
        chunkSize: 1024 * 1024,
        max: 8
      })
    ).toBe(8)
    expect(
      chooseConnections({
        fileSize: 500 * 1024 * 1024,
        desired: 64,
        chunkSize: 1024 * 1024,
        max: 3
      })
    ).toBe(3)
  })

  it('is always at least one', () => {
    expect(chooseConnections({ fileSize: 0, desired: 4, chunkSize: 1024 })).toBe(1)
    expect(chooseConnections({ fileSize: 10, desired: 0, chunkSize: 1024 })).toBe(1)
  })
})
