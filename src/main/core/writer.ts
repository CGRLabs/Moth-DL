/**
 * Sparse-capable positional file writer.
 *
 * Because chunks arrive out of order and are written at absolute offsets, the
 * writer must never rely on a file cursor. Every write is a positional
 * `FileHandle.write(buffer, offset, length, position)`, which is atomic with
 * respect to other writers and immune to a stale cursor after a crash.
 *
 * The file is preallocated to the final size so that:
 *  - the filesystem can reserve contiguous space (no fragmentation mid-write),
 *  - a short file is detectable, which the recovery pass relies on,
 *  - sparse regions read back as zeroes and are recognised as "not downloaded".
 */

import { open, type FileHandle } from 'node:fs/promises'
import { EngineError, fromFileSystemError } from '../util/errors.js'
import { getLogger } from '../util/logger.js'

const log = getLogger('core.writer')
type SyncOperation = (handle: FileHandle) => Promise<void>
let syncOperationForTests: SyncOperation | null = null

export function setWriterSyncOperationForTests(operation: SyncOperation | null): void {
  syncOperationForTests = operation
}

export interface WriteResult {
  bytesWritten: number
  /** Total bytes for this chunk once complete. */
  expected: number
}

export class SparseFileWriter {
  private handle: FileHandle | null = null
  private path: string | null = null
  /** Per-chunk write cursor, so a resumed chunk continues where it stopped. */
  private readonly cursors = new Map<string, number>()

  private constructor(private readonly log2 = log) {}

  static async open(targetPath: string, expectedSize: number): Promise<SparseFileWriter> {
    const writer = new SparseFileWriter()
    try {
      const handle = await open(targetPath, 'r+').catch(async (err: unknown) => {
        // ENOENT: the partial file is gone (deleted, or never created).
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return open(targetPath, 'w+')
        }
        throw err
      })
      writer.handle = handle
      writer.path = targetPath

      if (expectedSize > 0) {
        const info = await handle.stat()
        if (info.size < expectedSize) {
          // Extend with a hole. Windows and Linux both allocate lazily.
          await handle.truncate(expectedSize)
          writer.log2.debug('Preallocated partial file', { path: targetPath, size: expectedSize })
        } else if (info.size > expectedSize) {
          // The remote file shrank; trim so recovery sees the true length.
          await handle.truncate(expectedSize)
          writer.log2.warn('Trimmed oversized partial file', {
            path: targetPath,
            from: info.size,
            to: expectedSize
          })
        }
      }
    } catch (err) {
      throw fromFileSystemError(err, targetPath)
    }
    return writer
  }

  /**
   * Writes `buffer` into the range belonging to `chunkId`.
   *
   * `positionWithinChunk` is the offset of this buffer relative to the start
   * of the chunk, so a retried or resumed chunk resumes exactly where it
   * stopped instead of restarting the range.
   */
  async writeChunk(
    chunkId: string,
    chunkStart: number,
    positionWithinChunk: number,
    buffer: Uint8Array
  ): Promise<WriteResult> {
    if (!this.handle) throw new EngineError({ code: 'INTERNAL', message: 'Writer is closed' })
    if (buffer.length === 0) {
      return { bytesWritten: this.cursors.get(chunkId) ?? 0, expected: 0 }
    }

    const absolute = chunkStart + positionWithinChunk
    try {
      let written = 0
      while (written < buffer.length) {
        const result = await this.handle.write(
          buffer,
          written,
          buffer.length - written,
          absolute + written
        )
        if (result.bytesWritten === 0) {
          throw new Error('File write made no progress')
        }
        written += result.bytesWritten
      }
      const cursor = positionWithinChunk + written
      this.cursors.set(chunkId, cursor)
      return { bytesWritten: cursor, expected: 0 }
    } catch (err) {
      throw fromFileSystemError(err, this.path ?? chunkId)
    }
  }

  /** Seeds the cursor so a resumed chunk does not rewrite bytes already present. */
  setCursor(chunkId: string, position: number): void {
    this.cursors.set(chunkId, position)
  }

  getCursor(chunkId: string): number {
    return this.cursors.get(chunkId) ?? 0
  }

  clearCursor(chunkId: string): void {
    this.cursors.delete(chunkId)
  }

  /**
   * Flushes the OS buffers to stable storage.
   * Called before a chunk is marked complete in the database — without this a
   * power loss could leave the database claiming bytes that never reached disk.
   */
  async sync(): Promise<void> {
    if (!this.handle) return
    try {
      await (syncOperationForTests ?? ((handle) => handle.sync()))(this.handle)
    } catch (err) {
      const failure = fromFileSystemError(err, this.path ?? 'partial download')
      this.log2.error('fsync failed; refusing to commit unflushed bytes', { error: failure })
      throw failure
    }
  }

  async size(): Promise<number> {
    if (!this.handle) return 0
    const info = await this.handle.stat()
    return info.size
  }

  async close(): Promise<boolean> {
    if (!this.handle) return true
    let synced = true
    try {
      await (syncOperationForTests ?? ((handle) => handle.sync()))(this.handle)
    } catch (err) {
      synced = false
      this.log2.warn('Failed to sync partial file during close', { error: err })
    }
    try {
      await this.handle.close()
    } catch (err) {
      this.log2.warn('Failed to close partial file', { error: err })
    } finally {
      this.handle = null
    }
    return synced
  }

  get isOpen(): boolean {
    return this.handle !== null
  }
}

/**
 * Reads a byte range from a closed file. Used by recovery to inspect a partial
 * file without keeping a handle open for the lifetime of the app.
 */
export async function readRange(
  filePath: string,
  start: number,
  length: number
): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0)
  let handle: FileHandle | null = null
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset === length ? buffer : buffer.subarray(0, offset)
  } catch (err) {
    throw fromFileSystemError(err, filePath)
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Reports how many bytes of the file are actually present on disk.
 * A partial file shorter than `fileSize` is a hard signal that chunks were
 * lost, and recovery uses this to shrink the map before re-planning.
 */
export async function inspectPartialFile(
  filePath: string,
  fileSize: number
): Promise<{ size: number; complete: boolean }> {
  try {
    const handle = await open(filePath, 'r')
    try {
      const info = await handle.stat()
      return { size: info.size, complete: info.size >= fileSize }
    } finally {
      await handle.close()
    }
  } catch {
    return { size: 0, complete: false }
  }
}
