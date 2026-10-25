/**
 * Chunk (piece) planning.
 *
 * Splitting a file into fixed-size logical ranges is what makes Moth
 * resumable: progress is a bitmap of completed ranges, not a byte counter, so
 * a resume after a crash re-requests exactly the missing ranges regardless of
 * how out-of-order they were written.
 *
 * Everything here is pure and deterministic, which makes the layout trivially
 * unit-testable and keeps the on-disk map stable across restarts.
 */

import type { Chunk, DownloadId } from '@shared/types.js'
import { DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE, MIN_CHUNK_SIZE } from '@shared/constants.js'
import { newId } from './events.js'

export interface PlanOptions {
  downloadId: DownloadId
  /** Total file size in bytes. Must be > 0. */
  fileSize: number
  desiredChunkSize?: number
  /** Upper bound on the number of chunks; the size is grown to fit. */
  maxChunks?: number
  now?: number
}

/**
 * Chooses a chunk size.
 *
 * A file smaller than one chunk is not worth splitting, so it collapses to a
 * single chunk. Note that the requested size is honoured verbatim (bounded by
 * `MAX_CHUNK_SIZE`): the `MIN_CHUNK_SIZE` floor is enforced at the settings
 * boundary in `shared/schemas.ts`, and re-applying it here would silently
 * discard a deliberately small request and collapse mid-size files to one
 * chunk.
 */
export function chooseChunkSize(fileSize: number, desired?: number): number {
  const requested = desired ?? DEFAULT_CHUNK_SIZE
  const size = Math.min(MAX_CHUNK_SIZE, Math.max(1, Math.trunc(requested)))
  if (fileSize <= size) return Math.max(1, fileSize)
  return size
}

/**
 * Builds the full chunk map for a file of `fileSize` bytes.
 * Offsets are inclusive on both ends, matching HTTP `Range: bytes=a-b`.
 */
export function planChunks(options: PlanOptions): Chunk[] {
  const { downloadId, fileSize } = options
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new RangeError(`Cannot plan chunks for file size ${fileSize}`)
  }
  const now = options.now ?? Date.now()

  let chunkSize = chooseChunkSize(fileSize, options.desiredChunkSize)

  // Never create more chunks than the ceiling allows; grow the piece instead.
  if (options.maxChunks && options.maxChunks > 0) {
    const required = Math.ceil(fileSize / chunkSize)
    if (required > options.maxChunks) {
      chunkSize = Math.ceil(fileSize / options.maxChunks)
    }
  }

  const total = Math.ceil(fileSize / chunkSize)
  const chunks: Chunk[] = new Array<Chunk>(total)

  for (let index = 0; index < total; index += 1) {
    const start = index * chunkSize
    // The final chunk absorbs the remainder so the ranges are contiguous and
    // the last byte of the file is always covered.
    const end = Math.min(fileSize - 1, start + chunkSize - 1)
    chunks[index] = {
      id: newId(),
      downloadId,
      index,
      start,
      end,
      size: end - start + 1,
      status: 'pending',
      bytesWritten: 0,
      attempts: 0,
      lastError: null,
      checksum: null,
      updatedAt: now
    } as Chunk
  }

  return chunks
}

/** Total bytes covered by a chunk map. Used to validate a recovered map. */
export function totalSize(chunks: readonly Chunk[]): number {
  let total = 0
  for (const chunk of chunks) total += chunk.size
  return total
}

/** Number of chunks marked complete. */
export function countComplete(chunks: readonly Chunk[]): number {
  let count = 0
  for (const chunk of chunks) if (chunk.status === 'complete') count += 1
  return count
}

/** Sum of the sizes of complete chunks. */
export function completedBytes(chunks: readonly Chunk[]): number {
  let total = 0
  for (const chunk of chunks) if (chunk.status === 'complete') total += chunk.size
  return total
}

export interface ChunkMapValidation {
  valid: boolean
  /** Why the map is unusable. */
  reason?: string
  /** Index of the offending chunk. */
  index?: number
}

/**
 * Verifies a chunk map recovered from the database describes exactly
 * `[0, fileSize)` with no gaps, no overlaps and consistent sizes.
 *
 * This is the gate that stops a corrupted database from producing a file with
 * a hole in the middle: an invalid map is discarded and rebuilt from scratch.
 */
export function validateChunkMap(chunks: readonly Chunk[], fileSize: number): ChunkMapValidation {
  if (chunks.length === 0) {
    return { valid: false, reason: 'chunk map is empty' }
  }
  if (fileSize <= 0) {
    return { valid: false, reason: 'file size is unknown' }
  }

  const sorted = [...chunks].sort((a, b) => a.index - b.index)

  for (let i = 0; i < sorted.length; i += 1) {
    const chunk = sorted[i] as Chunk
    if (chunk.index !== i) {
      return { valid: false, reason: `chunk index ${chunk.index} out of sequence at position ${i}`, index: i }
    }
    if (chunk.start < 0 || chunk.end < chunk.start) {
      return { valid: false, reason: `chunk ${i} has an invalid range`, index: i }
    }
    if (chunk.size !== chunk.end - chunk.start + 1) {
      return { valid: false, reason: `chunk ${i} size does not match its range`, index: i }
    }
    if (chunk.end >= fileSize) {
      return { valid: false, reason: `chunk ${i} extends past the end of the file`, index: i }
    }
  }

  const first = sorted[0] as Chunk
  if (first.start !== 0) {
    return { valid: false, reason: 'chunk map does not start at byte 0', index: 0 }
  }

  const last = sorted[sorted.length - 1] as Chunk
  if (last.end !== fileSize - 1) {
    return { valid: false, reason: 'chunk map does not reach the end of the file', index: sorted.length - 1 }
  }

  // Contiguity: every chunk must begin exactly where the previous one ended.
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1] as Chunk
    const current = sorted[i] as Chunk
    if (current.start !== previous.end + 1) {
      return {
        valid: false,
        reason: `gap or overlap between chunk ${i - 1} and ${i}`,
        index: i
      }
    }
  }

  return { valid: true }
}

/**
 * Rebuilds a chunk map that fits the current `fileSize` while preserving
 * progress. Used when the remote file grew or shrank between sessions: any
 * chunk whose bytes are still valid in the new layout keeps its completion.
 */
export function revalidateChunks(
  existing: readonly Chunk[],
  downloadId: DownloadId,
  fileSize: number,
  desiredChunkSize?: number,
  now = Date.now()
): Chunk[] {
  const validation = validateChunkMap(existing, fileSize)
  if (validation.valid) return [...existing]

  // The old layout is unusable. Build a fresh one, then salvage progress by
  // byte range: a new chunk is complete if the old map had every byte it needs.
  const fresh = planChunks({ downloadId, fileSize, desiredChunkSize, now })
  if (existing.length === 0) return fresh

  const completedRanges = existing
    .filter((chunk) => chunk.status === 'complete')
    .map((chunk) => [chunk.start, chunk.end] as const)
    .sort((a, b) => a[0] - b[0])

  const isCovered = (start: number, end: number): boolean => {
    for (const [rangeStart, rangeEnd] of completedRanges) {
      if (rangeStart <= start && rangeEnd >= end) return true
      if (rangeStart > end) break
    }
    return false
  }

  for (const chunk of fresh) {
    if (isCovered(chunk.start, chunk.end)) {
      chunk.status = 'complete'
      chunk.bytesWritten = chunk.size
    } else {
      chunk.status = 'pending'
      chunk.bytesWritten = 0
    }
  }
  return fresh
}

/** Packs the chunk statuses into a compact bitmap for the UI heat map. */
export function toBitmap(chunks: readonly Chunk[]): number[] {
  return chunks.map((chunk) => (chunk.status === 'complete' ? 1 : 0))
}

/** Builds the `Range` header value for a chunk. */
export function rangeHeaderFor(chunk: Pick<Chunk, 'start' | 'end'>): string {
  return `bytes=${chunk.start}-${chunk.end}`
}

/** Parses a `Content-Range: bytes 0-1023/2048` response header. */
export function parseContentRange(
  header: string | null | undefined
): { start: number; end: number; total: number | null } | null {
  if (!header) return null
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim())
  if (!match) return null
  const total = match[3] === '*' ? null : Number.parseInt(match[3] as string, 10)
  return {
    start: Number.parseInt(match[1] as string, 10),
    end: Number.parseInt(match[2] as string, 10),
    total
  }
}

/**
 * Chooses how many connections to use for a given file.
 *
 * Small files use fewer connections: 16 ranges on a 40 KB file is pure
 * overhead, and most servers cap or penalise excessive parallelism. The
 * heuristic only restricts genuinely small files — for anything substantial the
 * user's configured value is honoured, bounded by the number of available
 * chunks and the hard maximum.
 */
export function chooseConnections(options: {
  fileSize: number
  desired: number
  chunkSize: number
  max?: number
}): number {
  const { fileSize, desired, chunkSize } = options
  const max = options.max ?? 32
  if (fileSize <= 0) return 1

  const available = Math.max(1, Math.ceil(fileSize / Math.max(1, chunkSize)))

  let allowed = desired
  if (fileSize < 4 * MIN_CHUNK_SIZE) {
    // A sub-256 KiB file is not worth splitting.
    allowed = 1
  } else if (fileSize < 32 * MIN_CHUNK_SIZE) {
    // Under ~2 MiB, extra connections cost more than they save.
    allowed = Math.min(allowed, 2)
  }

  return Math.max(1, Math.min(allowed, available, max))
}
