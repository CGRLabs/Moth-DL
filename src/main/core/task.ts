/**
 * A single download: probe, plan, transfer with N parallel range workers,
 * verify, and finalise.
 *
 * Durability contract (the reason this file is so careful):
 *
 *   A chunk is only marked `complete` in SQLite *after* its bytes have been
 *   fsync'd to disk. Because the database runs in WAL mode with
 *   `synchronous=FULL`, a committed `complete` therefore guarantees the bytes
 *   are really on the platter. That single ordering rule is what makes
 *   "resume never restarts from zero" true rather than merely likely.
 *
 *   For *in-progress* chunks we record a checkpoint only after an fsync too,
 *   and on resume we deliberately rewind `REWIND_SAFETY_BYTES` before
 *   restarting the range. Bytes past a checkpoint are therefore never trusted,
 *   which removes any possibility of a torn write leaving a hole in the middle
 *   of the file while still bounding re-downloaded data to ~1 MiB per chunk.
 */

import type { Chunk, Download, DownloadId } from '@shared/types.js'
import { getLogger } from '../util/logger.js'
import { EngineError, isCanceled, toEngineError } from '../util/errors.js'
import { withRetry } from '../util/backoff.js'
import { hashRange, verifyFile } from '../util/checksum.js'
import { estimateEta } from '../util/bytes.js'
import { SparseFileWriter } from './writer.js'
import { chooseChunkSize, chooseConnections, planChunks, toBitmap, validateChunkMap } from './planner.js'
import { SpeedMeter } from './speed.js'
import { openFile, openRange, probe, selectIfRangeValidator, type ClientOptions } from '../net/httpClient.js'
import type { Readable } from 'node:stream'
import type { Repositories } from '../db/repositories.js'
import type { CompositeRateLimiter } from '../util/rateLimiter.js'
import { filenameFromContentDisposition, filenameFromUrl, moveFile } from '../util/paths.js'
import type { SettingsStore } from './settingsStore.js'
import { resolveDownloadDestination } from '../util/destination.js'
import { emitActivity } from './activity.js'
import { routeTransfer } from './router.js'

const log = getLogger('core.task')

/** Bytes re-downloaded after a resume to guarantee a clean, verified boundary. */
const REWIND_SAFETY_BYTES = 1024 * 1024
/** How often in-flight chunk progress is flushed to the database. */
const CHECKPOINT_INTERVAL_MS = 1000
/** How often the speed meter is sampled for UI telemetry. */
const TELEMETRY_INTERVAL_MS = 500

export interface TaskContext {
  repos: Repositories
  rateLimiter: CompositeRateLimiter
  settings: SettingsStore
  /** Required media processing; returning false keeps the download non-complete. */
  beforeFinalize?: (id: DownloadId, partialPath: string) => Promise<boolean | void>
  /** Emitted with (id, finalPath) once the file is on disk. */
  onCompleted?: (id: DownloadId, finalPath: string) => Promise<void>

  /** Emits progress/finished/failed events to the engine. */
  emit: (event: TaskEvent) => void
}

/** Live progress for one active download. */
export interface TaskProgress {
  id: DownloadId
  downloadedBytes: number
  fileSize: number
  speed: number
  eta: number | null
  chunksComplete: number
  chunksTotal: number
  chunkBitmap: number[]
  activeConnections: number
}

export type TaskEvent =
  | { type: 'progress'; progress: TaskProgress }
  | { type: 'status'; id: DownloadId; status: Download['status'] }
  | { type: 'finished'; id: DownloadId; finalPath: string; size: number; durationMs: number; averageSpeed: number; checksum: { algorithm: string; value: string } | null }
  | { type: 'failed'; id: DownloadId; error: EngineError }
  | { type: 'removed'; id: DownloadId }

export class DownloadTask {
  private readonly id: DownloadId
  private download: Download
  private readonly abort = new AbortController()
  /** Aborted to pause; distinct from `abort` so a pause can be distinguished. */
  private paused = false
  private quotaReached = false
  private running = false
  private writer: SparseFileWriter | null = null
  private readonly meter: SpeedMeter
  private chunks: Chunk[] = []
  private downloadedBytes = 0
  private fileSize = 0
  private readonly startedAt = Date.now()
  private lastCheckpointAt = 0
  private activeConnections = 0
  private readonly pendingCheckpoints = new Map<string, number>()

  constructor(
    private readonly ctx: TaskContext,
    download: Download
  ) {
    this.id = download.id
    this.download = download
    this.fileSize = download.fileSize
    this.downloadedBytes = download.downloadedBytes
    this.meter = new SpeedMeter()
    this.meter.rebase(this.downloadedBytes)
  }

  get currentDownload(): Download {
    return this.download
  }

  get isRunning(): boolean {
    return this.running
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Graceful pause: workers stop, chunk state is checkpointed and kept. */
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.abort.abort()
  }

  /** Hard cancel: abort and mark for removal. */
  cancel(): void {
    this.paused = true
    this.abort.abort()
  }

  get signal(): AbortSignal {
    return this.abort.signal
  }

  /**
   * Runs the download to completion (or until paused/failed).
   * Re-throws on failure so the engine can apply retry policy.
   */
  async run(): Promise<void> {
    if (this.running) throw new Error('Task is already running')
    this.running = true
    const settings = this.ctx.settings.get()
    this.ctx.rateLimiter.setPerDownload(this.id, this.download.speedLimit)

    try {
      await this.prepare(settings)
      if (this.hasReachedQuota()) this.stopForQuota()
      else await this.transfer()
      if (this.isComplete()) {
        await this.finalise(settings)
      } else if (this.paused) {
        this.setStatus(
          'paused',
          this.quotaReached
            ? 'Download quota reached. Increase or clear the quota to continue.'
            : undefined
        )
      }
    } finally {
      const safelySynced = this.writer ? await this.writer.close() : true
      this.writer = null
      if (safelySynced) this.flushCheckpoints()
      else this.pendingCheckpoints.clear()
      this.running = false
    }
  }

  // --- preparation ---------------------------------------------------------

  /**
   * Resolves metadata, plans the chunk map, and opens the partial file.
   * On resume this reuses the persisted map so byte offsets are stable.
   */
  private async prepare(settings: ReturnType<SettingsStore['get']>): Promise<void> {
    let storedChunks = this.ctx.repos.chunks.listByDownload(this.id)
    const hasSavedProgress =
      this.download.downloadedBytes > 0 ||
      storedChunks.some((chunk) => chunk.status === 'complete' || chunk.bytesWritten > 0)
    const needsProbe = this.download.fileSize <= 0 || !this.download.acceptRanges || hasSavedProgress
    let metadata: Awaited<ReturnType<typeof probe>> | null = null

    if (needsProbe) {
      const previousSize = this.download.fileSize
      const previousAcceptRanges = this.download.acceptRanges
      const previousValidator = selectIfRangeValidator(this.download.etag, this.download.lastModified).value
      this.setStatus('connecting')
      metadata = await withRetry(
        () => probe(this.download.url, this.clientOptions()),
        {
          signal: this.abort.signal,
          maxAttempts: 3,
          onRetry: (err, attempt, delay) =>
            log.warn('Probe retrying', { id: this.id, attempt, delay, error: err.message })
        }
      )
      const route = routeTransfer(metadata)
      const nextAcceptRanges = route.strategy === 'parallel-ranges'
      const nextValidator = selectIfRangeValidator(metadata.etag, metadata.lastModified).value
      const sourceIdentityChanged =
        previousSize > 0 &&
        (metadata.size !== previousSize ||
          nextAcceptRanges !== previousAcceptRanges ||
          nextValidator !== previousValidator)
      log.info('Download router selected HTTP transfer strategy', {
        id: this.id,
        strategy: route.strategy,
        resumable: route.resumable,
        reason: route.reason
      })
      await this.applyMetadata({
        ...metadata,
        acceptRanges: nextAcceptRanges
      }, settings)
      if (sourceIdentityChanged) {
        log.warn('Remote file identity changed; discarding saved chunk progress', {
          id: this.id,
          previousSize,
          nextSize: metadata.size,
          previousAcceptRanges,
          nextAcceptRanges,
          validatorChanged: previousValidator !== nextValidator
        })
        emitActivity(
          this.ctx.repos,
          this.id,
          'warn',
          'The server reports a changed file version; saved progress was discarded and the new version will download from zero'
        )
        await this.replan(settings)
        storedChunks = this.ctx.repos.chunks.listByDownload(this.id)
      }
    } else if (this.download.fileSize > 0) {
      this.fileSize = this.download.fileSize
    }

    if (this.fileSize <= 0) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Server did not disclose the file size; cannot plan ranges',
        retryable: false
      })
    }

    // Load or build the chunk map.
    const stored = storedChunks
    if (stored.length > 0) {
      const validation = validateChunkMap(stored, this.fileSize)
      const singleStreamMap =
        this.download.acceptRanges ||
        (stored.length === 1 && stored[0]?.start === 0 && stored[0]?.end === this.fileSize - 1)
      const hasValidator =
        selectIfRangeValidator(this.download.etag, this.download.lastModified).value !== null
      const unverifiableProgress =
        this.download.acceptRanges &&
        !hasValidator &&
        stored.some((chunk) => chunk.status === 'complete' || chunk.bytesWritten > 0)
      if (validation.valid && singleStreamMap && !unverifiableProgress) {
        this.chunks = stored
        this.downloadedBytes = stored
          .filter((c) => c.status === 'complete')
          .reduce((sum, c) => sum + c.size, 0)
        log.info('Reusing chunk map on resume', {
          id: this.id,
          chunks: this.chunks.length,
          complete: this.chunks.filter((c) => c.status === 'complete').length
        })
      } else {
        log.warn('Discarding unsafe or invalid chunk map; re-planning', {
          id: this.id,
          reason: validation.reason ?? (unverifiableProgress ? 'remote content has no usable validator' : undefined)
        })
        await this.replan(settings)
      }
    } else {
      await this.replan(settings)
    }

    this.meter.rebase(this.downloadedBytes)

    // Open (or create) the partial file and preallocate it.
    const partial = this.download.tempPath
    this.writer = await SparseFileWriter.open(partial, this.fileSize)

    // Seed chunk cursors so a resumed chunk continues near where it stopped.
    let resumedBytes = 0
    for (const chunk of this.chunks) {
      if (chunk.status === 'complete' || chunk.bytesWritten <= 0) continue
      const resumeAt = Math.max(0, chunk.bytesWritten - REWIND_SAFETY_BYTES)
      this.writer.setCursor(chunk.id, resumeAt)
      resumedBytes += resumeAt
    }
    this.downloadedBytes += resumedBytes
    this.meter.rebase(this.downloadedBytes)

    this.setStatus('downloading')
    this.persistProgress()
  }

  /** Fills in metadata learned from the probe and persists it. */
  private async applyMetadata(
    metadata: Awaited<ReturnType<typeof probe>>,
    settings: ReturnType<SettingsStore['get']>
  ): Promise<void> {
    const size = metadata.size ?? 0

    // If ranges are unsupported we must fall back to a single sequential
    // stream. The planner handles this: one chunk covering the whole file.
    this.fileSize = size

    const patch: Partial<Download> = {
      finalUrl: metadata.finalUrl,
      fileSize: size,
      acceptRanges: metadata.acceptRanges,
      etag: metadata.etag,
      lastModified: metadata.lastModified,
      contentType: metadata.contentType
    }

    // Derive the filename and destination if not explicitly chosen. A name that
    // is only the URL's last path segment was never a real name:
    // `https://host/download/pc/` redirects to `installer.exe`, and saving that
    // as "pc" drops the extension the user's system needs. A name the caller
    // chose is left alone.
    const derivedFromUrl = filenameFromUrl(this.download.url)
    if (
      !this.download.filename ||
      this.download.filename === 'download' ||
      this.download.filename === derivedFromUrl
    ) {
      const probed = this.guessFilename(metadata.contentDisposition, metadata.finalUrl)
      if (probed !== '') patch.filename = probed
    }
    const downloadForDestination = { ...this.download, ...patch }
    const destination = await resolveDownloadDestination({
      download: downloadForDestination,
      url: metadata.finalUrl,
      contentType: metadata.contentType,
      settings
    })
    patch.tempPath = destination.tempPath
    patch.finalPath = destination.finalPath
    patch.category = destination.category

    this.download = { ...this.download, ...patch }
    this.ctx.repos.downloads.update(this.id, patch)
    log.info('Applied remote metadata', {
      id: this.id,
      size,
      acceptRanges: metadata.acceptRanges,
      filename: this.download.filename
    })
  }

  /**
   * The name the server implies: `Content-Disposition` first, otherwise the
   * last segment of the URL that actually served the bytes — the probed final
   * URL, since that is the one whose last segment is a filename.
   */
  private guessFilename(contentDisposition: string | null, finalUrl: string): string {
    return filenameFromContentDisposition(contentDisposition) ?? filenameFromUrl(finalUrl)
  }

  /** (Re)builds the chunk map and persists it. */
  private async replan(settings: ReturnType<SettingsStore['get']>): Promise<void> {
    const route = routeTransfer({
      size: this.fileSize,
      acceptRanges: this.download.acceptRanges,
      rangeUnsupported: !this.download.acceptRanges,
      etag: this.download.etag,
      lastModified: this.download.lastModified
    })
    const chunkSize = route.strategy === 'parallel-ranges'
      ? chooseChunkSize(this.fileSize, settings.chunkSize)
      : this.fileSize
    this.chunks = planChunks({
      downloadId: this.id,
      fileSize: this.fileSize,
      desiredChunkSize: chunkSize
    })
    this.ctx.repos.chunks.replaceAll(this.id, this.chunks)
    this.downloadedBytes = 0
    log.info('Planned chunk map', {
      id: this.id,
      strategy: route.strategy,
      resumable: route.resumable,
      reason: route.reason,
      fileSize: this.fileSize,
      chunkSize,
      chunks: this.chunks.length
    })
  }

  // --- transfer ------------------------------------------------------------

  private async transfer(): Promise<void> {
    const settings = this.ctx.settings.get()
    const maxConcurrent = this.download.connections ?? settings.defaultConnections

    // Chunk queue for this run. Anything already complete is skipped.
    const queue = this.chunks.filter((c) => c.status !== 'complete')
    if (queue.length === 0) return

    // Abort active workers when the queue drains or on pause/cancel.
    const queueIndex = { value: 0 }
    const quotaActive = this.download.quotaBytes !== null && this.download.quotaBytes < this.fileSize
    const workerCount = quotaActive
      ? 1
      : Math.min(
          queue.length,
          chooseConnections({
            fileSize: this.fileSize,
            desired: maxConcurrent,
            chunkSize: this.chunks[0]?.size ?? settings.chunkSize
          })
        )
    const workers: Promise<void>[] = []

    for (let i = 0; i < workerCount; i += 1) {
      workers.push(this.workerLoop(queue, queueIndex))
    }

    // A single telemetry timer drives speed sampling and progress persistence.
    const telemetry = setInterval(() => this.onTelemetry(), TELEMETRY_INTERVAL_MS)
    if (typeof telemetry.unref === 'function') telemetry.unref()

    try {
      // If any worker throws (network fatality), abort the rest.
      await Promise.all(workers)
    } finally {
      clearInterval(telemetry)
      this.onTelemetry()
    }
  }

  /** Pulls chunks off the shared queue until it is empty or the task aborts. */
  private async workerLoop(queue: Chunk[], cursor: { value: number }): Promise<void> {
    for (;;) {
      if (this.abort.signal.aborted) return
      const index = cursor.value
      if (index >= queue.length) return
      cursor.value = index + 1
      const chunk = queue[index] as Chunk

      this.activeConnections += 1
      try {
        await this.downloadChunk(chunk)
      } catch (err) {
        const error = toEngineError(err)
        if (isCanceled(error)) {
          this.activeConnections -= 1
          return
        }
        // A worker failure aborts the whole task; the engine decides whether
        // to retry the entire download.
        this.abort.abort()
        this.activeConnections -= 1
        throw error
      }
      this.activeConnections -= 1
    }
  }

  /** Downloads one chunk to completion, with its own retry policy. */
  private async downloadChunk(chunk: Chunk): Promise<void> {
    if (!this.download.acceptRanges && (chunk.bytesWritten > 0 || (this.writer?.getCursor(chunk.id) ?? 0) > 0)) {
      this.writer?.setCursor(chunk.id, 0)
      chunk.bytesWritten = 0
      this.ctx.repos.chunks.updateProgress(chunk.id, 0)
      this.downloadedBytes = 0
    }
    const resumeAt = this.writer?.getCursor(chunk.id) ?? 0
    const remaining = chunk.size - resumeAt
    if (remaining <= 0) {
      await this.completeChunk(chunk)
      return
    }

    this.ctx.repos.chunks.markActive(chunk.id, resumeAt)

    // Failed-open revalidation: this chunk has bytes on disk from an earlier
    // run, but the server gave us no usable If-Range validator (no ETag, a
    // weak ETag, and no Last-Modified), so a resumed range cannot prove the
    // remote file is unchanged — only a size check would guard the splice,
    // and a same-size content change would stitch silently into a
    // mixed-content file. Discard the affected progress and re-fetch the
    // whole chunk instead: re-downloading is always safe, trusting is not.
    if (
      resumeAt > 0 &&
      selectIfRangeValidator(this.download.etag, this.download.lastModified).value === null
    ) {
      log.warn('Discarding unverifiable chunk progress; no usable If-Range validator', {
        id: this.id,
        chunk: chunk.index,
        etag: this.download.etag,
        lastModified: this.download.lastModified
      })
      emitActivity(
        this.ctx.repos,
        this.id,
        'warn',
        `Chunk ${chunk.index + 1}: server sent no usable ETag/Last-Modified, so prior progress ` +
          `could not be revalidated and was discarded to avoid a mixed-content file`
      )
      this.writer?.setCursor(chunk.id, 0)
      chunk.bytesWritten = 0
      this.ctx.repos.chunks.updateProgress(chunk.id, 0)
    }

    const bodyComplete = await withRetry<boolean>(
      async (attempt) => {
        if (!this.download.acceptRanges && attempt > 1) {
          this.writer?.setCursor(chunk.id, 0)
          chunk.bytesWritten = 0
          this.ctx.repos.chunks.updateProgress(chunk.id, 0)
          this.pendingCheckpoints.delete(chunk.id)
          this.downloadedBytes = 0
        }
        const requestStart = chunk.start + (this.writer?.getCursor(chunk.id) ?? 0)
        const requestEnd = chunk.end
        const requestSize = requestEnd - requestStart + 1
        if (requestSize <= 0) return true

        const response = this.download.acceptRanges
          ? await openRange({
              url: this.download.url,
              start: requestStart,
              end: requestEnd,
              etag: this.download.etag,
              lastModified: this.download.lastModified,
              headers: this.download.headers,
              signal: this.abort.signal
            })
          : await openFile({
              url: this.download.finalUrl ?? this.download.url,
              headers: this.download.headers,
              signal: this.abort.signal
            })

        if (response.rangeNotSatisfiable) {
          throw new EngineError({
            code: 'PRECONDITION_FAILED',
            message: `Server returned 416 for bytes ${requestStart}-${requestEnd}; file likely changed`,
            retryable: false
          })
        }

        // Learn the true total if the server only disclosed it now.
        if (response.totalSize !== null && response.totalSize !== this.fileSize) {
          await this.onRemoteSizeChanged(response.totalSize)
          throw new EngineError({
            code: 'PRECONDITION_FAILED',
            message: `Remote size changed to ${response.totalSize}; chunk map must be rebuilt`,
            retryable: false
          })
        }

        return this.pumpBody(response.stream, chunk, requestStart, requestSize)
      },
      {
        signal: this.abort.signal,
        maxAttempts:
          this.download.acceptRanges &&
          selectIfRangeValidator(this.download.etag, this.download.lastModified).value === null
            ? 1
            : Math.max(1, this.download.maxRetries),
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        onRetry: (err, attempt, delay) => {
          log.warn('Chunk retry', { id: this.id, chunk: chunk.index, attempt, delay, error: err.message })
          this.ctx.repos.chunks.markFailed(chunk.id, err.message)
        }
      }
    )

    if (!bodyComplete) return
    await this.completeChunk(chunk)
  }

  /**
   * Streams a response body into the partial file, honouring the rate limiter
   * and recording checkpoints.
   */
  private async pumpBody(
    stream: Readable,
    chunk: Chunk,
    requestStart: number,
    requestSize: number
  ): Promise<boolean> {
    let positionInChunk = requestStart - chunk.start
    let received = 0

    for await (const raw of stream) {
      const buffer = raw as Buffer
      if (this.abort.signal.aborted) {
        stream.destroy()
        throw new EngineError({ code: 'PAUSED', message: 'Transfer paused' })
      }
      if (buffer.length > requestSize - received) {
        stream.destroy()
        throw new EngineError({
          code: 'NETWORK',
          message: `Server sent more bytes than requested for chunk ${chunk.index}`,
          retryable: true
        })
      }

      const remainingQuota = this.download.quotaBytes !== null && this.download.quotaBytes < this.fileSize
        ? this.download.quotaBytes - this.downloadedBytes
        : Number.POSITIVE_INFINITY
      if (remainingQuota <= 0) {
        stream.destroy()
        this.stopForQuota()
        return false
      }
      const acceptedBytes = Math.min(buffer.length, remainingQuota)
      const acceptedBuffer = acceptedBytes === buffer.length ? buffer : buffer.subarray(0, acceptedBytes)

      // Rate limiting: block until the global+per-download limiter allows these bytes.
      await this.ctx.rateLimiter.acquire(this.id, acceptedBytes, this.abort.signal)

      const result = await this.writer?.writeChunk(chunk.id, chunk.start, positionInChunk, acceptedBuffer)
      positionInChunk += acceptedBytes
      received += acceptedBytes
      this.downloadedBytes += acceptedBytes
      if (result) {
        this.pendingCheckpoints.set(chunk.id, result.bytesWritten)
      }

      // Periodic fsync + checkpoint so a crash loses at most ~1s of work.
      const now = Date.now()
      if (now - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
        await this.checkpoint()
        this.lastCheckpointAt = now
      }

      if (
        acceptedBytes < buffer.length ||
        (this.download.quotaBytes !== null &&
          this.download.quotaBytes < this.fileSize &&
          this.downloadedBytes >= this.download.quotaBytes)
      ) {
        stream.destroy()
        this.stopForQuota()
        return false
      }

      if (positionInChunk >= chunk.size) break
    }
    // Releasing the socket is essential: a half-read response would otherwise
    // keep the connection (and its pooled socket) occupied indefinitely.
    stream.destroy()

    // The planned range already ends at the file boundary, so every response
    // must contain exactly the requested bytes.
    if (received !== requestSize) {
      throw new EngineError({
        code: 'NETWORK',
        message: `Incomplete read for chunk ${chunk.index}: expected ${requestSize}, got ${received}`,
        retryable: true
      })
    }
    return true
  }

  private hasReachedQuota(): boolean {
    return this.download.quotaBytes !== null &&
      this.fileSize > 0 &&
      this.download.quotaBytes < this.fileSize &&
      this.downloadedBytes >= this.download.quotaBytes
  }

  private stopForQuota(): void {
    if (this.quotaReached) return
    this.quotaReached = true
    this.paused = true
    this.abort.abort()
  }

  /** Called when the server reveals a different total size mid-transfer. */
  private async onRemoteSizeChanged(newSize: number): Promise<void> {
    if (newSize === this.fileSize) return
    log.warn('Remote size changed during transfer', { id: this.id, from: this.fileSize, to: newSize })
    this.ctx.repos.downloads.update(this.id, { fileSize: newSize })
    this.ctx.repos.chunks.invalidateAll(this.id)
    throw new EngineError({
      code: 'PRECONDITION_FAILED',
      message: 'Remote file size changed; progress invalidated',
      retryable: false
    })
  }

  /** Marks a chunk complete: fsync bytes, then commit the DB row. */
  private async completeChunk(chunk: Chunk): Promise<void> {
    // Durability barrier: bytes hit the platter before the DB claims them.
    await this.writer?.sync()

    let checksum: string | null = null
    try {
      // A per-chunk digest makes later corruption detectable cheaply.
      checksum = await hashRange(this.download.tempPath, chunk.start, chunk.end, 'sha256')
    } catch (err) {
      log.warn('Chunk checksum failed (non-fatal)', { id: this.id, chunk: chunk.index, error: err })
    }

    this.ctx.repos.chunks.markComplete(chunk.id, checksum)
    chunk.status = 'complete'
    chunk.bytesWritten = chunk.size
    this.pendingCheckpoints.delete(chunk.id)
    this.writer?.clearCursor(chunk.id)
  }

  // --- finalisation --------------------------------------------------------

  private isComplete(): boolean {
    return this.chunks.length > 0 && this.chunks.every((c) => c.status === 'complete')
  }

  /** Verifies the full-file checksum, promotes the partial to final, emits done. */
  private async finalise(settings: ReturnType<SettingsStore['get']>): Promise<void> {
    const finalPath = this.download.finalPath ?? this.download.tempPath.replace(/\.mothpart$/, '')

    // If the whole-file digest is known, re-read and confirm before promoting.
    // Otherwise record a baseline digest so a later corruption is detectable.
    if (settings.verifyChecksums && this.download.expectedChecksum) {
      this.setStatus('verifying')
      const result = await verifyFile(this.download.tempPath, this.download.expectedChecksum)
      if (!result.ok) {
        // Terminal for automatic retries (retryable: false — the engine will
        // mark this failed, never loop): re-hashing the same poisoned bytes
        // can never succeed. Recovery is explicit: the engine discards the
        // corrupt partial and resets the chunk map, so a manual retry
        // re-downloads cleanly instead of re-verifying.
        throw new EngineError({
          code: 'CHECKSUM_MISMATCH',
          message:
            `Downloaded file failed checksum verification and was discarded: ` +
            `expected ${result.expected}, got ${result.actual}. ` +
            `Retry the download to fetch a fresh copy.`,
          retryable: false
        })
      }
      this.ctx.repos.downloads.update(this.id, { computedChecksum: result.actual })
    } else {
      try {
        const result = await hashRange(this.download.tempPath, 0, this.fileSize - 1, 'sha256')
        this.ctx.repos.downloads.update(this.id, { computedChecksum: result })
      } catch (err) {
        log.debug('Final digest failed (non-fatal)', { id: this.id, error: err })
      }
    }

    // Required media processing (audio mux/conversion) must finish before the
    // durable completed state or success event can be emitted. Otherwise a
    // failed conversion can be overwritten by a success-shaped completion.
    this.setStatus('verifying')
    await this.writer?.sync()
    await this.writer?.close()
    this.writer = null
    const canFinalize = await this.ctx.beforeFinalize?.(this.id, this.download.tempPath)
    if (canFinalize === false) return

    // Promote partial -> final.
    if (this.download.tempPath !== finalPath) {
      await moveFile(this.download.tempPath, finalPath)
    }

    // Durability commit BEFORE anything unbounded: the crash window between
    // the move above and this write is what used to orphan a fully-downloaded
    // final file (DB still said "downloading" with a nonexistent temp, so
    // recovery wiped it to 0% and the next move deleted the good file).
    // fsync-before-commit still holds — bytes were synced before the move,
    // and the DB runs WAL + synchronous=FULL, so a committed `completed`
    // guarantees the final file is really on the platter.
    const durationMs = Date.now() - this.startedAt
    const averageSpeed = durationMs > 0 ? (this.fileSize / durationMs) * 1000 : 0

    this.download = { ...this.download, finalPath, status: 'completed' }
    this.ctx.repos.downloads.update(this.id, {
      status: 'completed',
      finalPath,
      completedAt: Date.now(),
      downloadedBytes: this.fileSize,
      errorCode: null,
      errorMessage: null
    })
    this.ctx.emit({ type: 'status', id: this.id, status: 'completed' })
    emitActivity(this.ctx.repos, this.id, 'info', `Completed: ${this.download.filename}`)

    // Resolve metadata and write tags into the finished file. Injected rather
    // than imported so the transfer path does not grow a dependency on the media
    // layer, and so a metadata failure can never fail the download.
    // Deliberately AFTER the completed-commit: media resolution is unbounded
    // in time (disk scan, embedded-art fetch) and must never sit inside the
    // move-then-record durability window. It is already failure-proof — the
    // engine's handler swallows every error — so a crash here only loses tags,
    // never the download itself.
    await this.ctx.onCompleted?.(this.id, finalPath)

    this.ctx.emit({
      type: 'finished',
      id: this.id,
      finalPath,
      size: this.fileSize,
      durationMs,
      averageSpeed,
      checksum: this.download.expectedChecksum
        ? { algorithm: this.download.expectedChecksum.algorithm, value: this.download.expectedChecksum.value }
        : null
    })
  }

  // --- telemetry & persistence --------------------------------------------

  private onTelemetry(): void {
    this.meter.update(this.downloadedBytes)
    const speed = this.meter.bytesPerSecond
    const eta = estimateEta(this.fileSize - this.downloadedBytes, speed)

    this.ctx.emit({
      type: 'progress',
      progress: {
        id: this.id,
        downloadedBytes: this.downloadedBytes,
        fileSize: this.fileSize,
        speed,
        eta,
        chunksComplete: this.chunks.filter((c) => c.status === 'complete').length,
        chunksTotal: this.chunks.length,
        chunkBitmap: toBitmap(this.chunks),
        activeConnections: this.activeConnections
      }
    })
  }

  /** fsync + write all pending chunk cursors to the DB. */
  private async checkpoint(): Promise<void> {
    if (this.pendingCheckpoints.size === 0) return
    await this.writer?.sync()
    this.flushCheckpoints()
  }

  private flushCheckpoints(): void {
    if (this.pendingCheckpoints.size === 0) return
    const entries = [...this.pendingCheckpoints.entries()].map(([id, bytesWritten]) => ({ id, bytesWritten }))
    this.pendingCheckpoints.clear()
    try {
      this.ctx.repos.chunks.updateProgressBatch(entries)
    } catch (err) {
      log.warn('Failed to persist chunk progress', { id: this.id, error: err })
    }
  }

  private persistProgress(): void {
    this.ctx.repos.downloads.update(this.id, {
      status: 'downloading',
      fileSize: this.fileSize,
      downloadedBytes: this.downloadedBytes
    })
  }

  private setStatus(status: Download['status'], errorMessage?: string): void {
    const patch: Partial<Download> = { status }
    if (errorMessage !== undefined) {
      patch.errorCode = 'PAUSED'
      patch.errorMessage = errorMessage
    }
    this.download = { ...this.download, ...patch }
    try {
      this.ctx.repos.downloads.update(this.id, patch)
    } catch (err) {
      log.warn('Failed to persist status', { id: this.id, status, error: err })
    }
    this.ctx.emit({ type: 'status', id: this.id, status })
  }

  private clientOptions(): ClientOptions {
    return {
      headers: this.download.headers,
      userAgent: undefined
    }
  }

  /** Cancels all in-flight work; used by the engine on shutdown. */
  destroy(): void {
    this.abort.abort()
  }
}
