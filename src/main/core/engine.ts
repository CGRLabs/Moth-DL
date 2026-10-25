/**
 * The download engine.
 *
 * Owns the lifecycle of every download and is the only thing that decides what
 * runs. Responsibilities:
 *
 *  - maintain the active task set and the pending queue,
 *  - enforce `maxConcurrentDownloads` and the global rate limit,
 *  - honour priorities and scheduled start times,
 *  - apply the retry policy with backoff,
 *  - publish telemetry to the UI,
 *  - run crash recovery at startup.
 *
 * Concurrency model: one `DownloadTask` per active download, each of which
 * owns its own chunk workers. The engine itself is single-threaded and
 * communicates through the repository and an event callback, which keeps the
 * "who may mutate a download" question answerable: only the task for that
 * download, or the engine, ever writes its state.
 */

import { createHash } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  AddDownloadRequest,
  AddDownloadResult,
  AppSettings,
  ChecksumAlgorithm,
  Download,
  DownloadId,
  DownloadSnapshot,
  DownloadStatus,
  CreateQueuePlanRequest,
  QueuePlan,
  DuplicateMediaResult,
  EngineStats,
  MediaPlaylistPreview,
  VideoQuality
} from '@shared/types.js'
import type { DiskRescanDetail, RefreshDownloadUrlResult } from '@shared/ipc.js'
import type { MediaHint } from '@shared/media.js'
import { TELEMETRY_INTERVAL_MS, SPEED_SAMPLE_WINDOW_MS, VIDEO_MAX_HEIGHT } from '@shared/constants.js'
import { getLogger, sanitizeLogText } from '../util/logger.js'
import { EngineError, isCanceled, toEngineError } from '../util/errors.js'
import { withRetry } from '../util/backoff.js'
import { CompositeRateLimiter } from '../util/rateLimiter.js'
import {
  deleteFile,
  ensureDir,
  filenameFromContentDisposition,
  filenameFromUrl,
  pathExists,
  resolveWithin,
  sanitizeFilename
} from '../util/paths.js'
import { estimateEta } from '../util/bytes.js'
import { parseChecksumInput } from '../util/checksum.js'
import { resolveDownloadDestination } from '../util/destination.js'
import { probe } from '../net/httpClient.js'
import { AggregateSpeed } from './speed.js'
import { DownloadTask, type TaskEvent } from './task.js'
import { classifyProbedResponse, routeSource, routeTransfer } from './router.js'
import { getEnabledSiteAdapterForUrl, resolveSiteAdapterCandidate } from './siteAdapters.js'
import { runRecovery, verifyAgainstDisk, type RecoveryReport } from './recovery.js'
import { MediaService } from '../media/service.js'
import { emitActivity } from './activity.js'
import { newId } from './events.js'
import {
  ensureHelpers,
  ensureFfmpegHelper,
  ensureYtDlpHelper,
  getVideoCaptureUserDataDir,
  isVideoResolverStubbed
} from '../video/index.js'
import {
  headersForResolvedAudio,
  resolvePlaylist,
  resolveVideo,
  type ResolvedVideo
} from '../video/resolve.js'
import { muxAudioIntoVideo, transcodeToMp3, withMp3Extension, withVideoExtension } from '../video/transcode.js'
import {
  clearYtDlpWorkDirectory,
  YtDlpDownloadTask
} from '../video/download.js'
import { isYouTubePage } from './router.js'
import { classifyUrl } from './preview.js'
import type { PendingMediaResolution, Repositories } from '../db/repositories.js'
import type { SettingsStore } from './settingsStore.js'
import type { Database } from '../db/driver.js'
import {
  isImportedTorrentFileUri,
  isTorrentFileUrl,
  isTorrentSource,
  parseMagnetUri
} from '@shared/torrent.js'
import {
  getBundledTransmissionExecutable,
  getTorrentMetainfoPath,
  parseTransmissionFiles,
  parseTransmissionTorrents,
  transmissionLimit,
  TransmissionManager,
  type TransmissionRpc,
  type TransmissionTorrent
} from '../torrent/transmission.js'
import { TorrentDownloadTask } from '../torrent/task.js'

const log = getLogger('core.engine')

/** Last path segment of a path, used when honouring an explicit destination. */
function basename(target: string): string {
  const parts = target.split(/[\\/]/)
  return parts[parts.length - 1] ?? 'download'
}

function hasUnsupportedTorrentOptions(request: AddDownloadRequest): boolean {
  return request.format !== undefined ||
    request.expectedChecksum !== undefined ||
    request.checksumAlgorithm !== undefined ||
    request.destination !== undefined ||
    request.connections !== undefined ||
    request.videoQuality !== undefined ||
    request.audioFormat !== undefined ||
    (request.subtitleLanguages?.length ?? 0) > 0 ||
    request.namingTemplate !== undefined ||
    request.embedMetadata !== undefined ||
    Object.keys(request.headers ?? {}).length > 0
}

function isTorrentRequest(request: AddDownloadRequest): boolean {
  return isTorrentSource(request.url) ||
    (isImportedTorrentFileUri(request.url) && request.torrentMetainfo !== undefined)
}

function normalizedPageUrl(raw: string): string {
  const url = new URL(raw)
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|feature|si)$/i.test(key)) url.searchParams.delete(key)
  }
  return url.href
}

function withSourceAudioExtension(filename: string, resolvedFilename: string | undefined): string {
  const dot = resolvedFilename?.lastIndexOf('.') ?? -1
  if (dot <= 0 || !resolvedFilename) return filename
  const extension = resolvedFilename.slice(dot + 1)
  const filenameDot = filename.lastIndexOf('.')
  return `${filenameDot > 0 ? filename.slice(0, filenameDot) : filename}.${extension}`
}

function renderMediaFilename(template: string, resolved: ResolvedVideo, pageUrl: string): string {
  const filename = resolved.filename ?? 'download.bin'
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 ? filename.slice(dot + 1) : 'bin'
  const title = resolved.mediaHint?.title ?? (dot > 0 ? filename.slice(0, dot) : filename)
  const id = resolved.sourceKey?.split(':').at(-1) ?? ''
  const host = new URL(pageUrl).hostname
  let output = template
    .replace(/\{title\}/g, title)
    .replace(/\{id\}/g, id)
    .replace(/\{host\}/g, host)
    .replace(/\{ext\}/g, extension)
  if (!template.includes('{ext}') && !output.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
    output += `.${extension}`
  }
  return sanitizeFilename(output)
}

/**
 * Builds the expected-checksum spec from user input, inferring the algorithm
 * from the digest length when the user did not state one. Unparseable input is
 * ignored rather than fatal: a bad hash should not block the download.
 */
function buildChecksumSpec(
  expected: string | undefined,
  algorithm: ChecksumAlgorithm | undefined
): Download['expectedChecksum'] {
  if (!expected) return null
  const parsed = parseChecksumInput(expected)
  if (!parsed) {
    log.warn('Ignoring unparseable checksum', { expected })
    return null
  }

  return { algorithm: algorithm ?? parsed.algorithm, value: parsed.value }
}

function isStrongETag(value: string | null | undefined): boolean {
  const etag = value?.trim() ?? ''
  return /^"(?:[\x21\x23-\x7E\x80-\xFF])*"$/.test(etag)
}

function sameMediaResolution(
  left: PendingMediaResolution | null,
  right: PendingMediaResolution | null
): boolean {
  return left !== null &&
    right !== null &&
    left.format === right.format &&
    left.audioFormat === right.audioFormat &&
    left.videoQuality === right.videoQuality &&
    left.requestedFilename === right.requestedFilename &&
    left.requestedDestination === right.requestedDestination &&
    left.sourcePageUrl === right.sourcePageUrl &&
    left.namingTemplate === right.namingTemplate &&
    left.embedMetadata === right.embedMetadata &&
    JSON.stringify(left.subtitleLanguages) === JSON.stringify(right.subtitleLanguages)
}

export interface EngineEvents {
  /** Any field of a download changed; the renderer re-reads or patches. */
  upserted: Download
  removed: { ids: DownloadId[] }
  mediaUpdated: { id: DownloadId }
  finished: {
    id: DownloadId
    filename: string
    finalPath: string
    size: number
    durationMs: number
    averageSpeed: number
    checksum: { algorithm: string; value: string } | null
  }
  failed: { id: DownloadId; code: string; message: string; retryable: boolean }
  progress: {
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
  stats: EngineStats
  speedHistory: { samples: { t: number; bytesPerSecond: number }[] }
  recovery: RecoveryReport
  scheduled: { id: DownloadId; at: number }
  queuePlansChanged: QueuePlan[]
}

export type EngineEventName = keyof EngineEvents

export class DownloadEngine {
  private readonly tasks = new Map<DownloadId, Pick<DownloadTask | TorrentDownloadTask, 'pause' | 'cancel' | 'destroy'>>()
  private readonly taskRuns = new Map<DownloadId, Promise<void>>()
  /** Ids waiting for a free concurrency slot, in priority order. */
  private readonly queue: DownloadId[] = []
  private readonly speeds = new AggregateSpeed()
  private readonly listeners = new Map<EngineEventName, Set<(payload: never) => void>>()
  private readonly rateLimiter: CompositeRateLimiter
  private media: MediaService | null = null
  private readonly pendingMediaHints = new Map<DownloadId, MediaHint>()
  private readonly pendingPageArtwork = new Map<DownloadId, Promise<void>>()
  private readonly mediaPreparations = new Set<DownloadId>()
  /** In-flight "which kind of source is this?" lookups for staged rows. */
  private readonly reviewLookups = new Map<DownloadId, Promise<void>>()
  private transmission: TransmissionManager | null = null

  /**
   * Attaches the media service.
   *
   * The engine is constructed before the media service exists, so this is a
   * setter rather than a constructor argument. Until it is called, metadata is
   * simply not resolved — which is a safe default, not a failure.
   */
  setMediaService(service: MediaService): void {
    this.media = service
  }
  private telemetryTimer: NodeJS.Timeout | null = null
  private schedulerTimer: NodeJS.Timeout | null = null
  private speedSamples: { t: number; bytesPerSecond: number }[] = []
  private sessionBytes = 0
  private readonly lastProgressBytes = new Map<DownloadId, number>()
  private readonly startedAt = Date.now()
  private shuttingDown = false

  constructor(
    private readonly repos: Repositories,
    private readonly settings: SettingsStore,
    private readonly db: Database,
    private readonly userDataDir = '',
    private readonly resourcesDir = ''
  ) {
    this.rateLimiter = new CompositeRateLimiter({
      globalBytesPerSecond: settings.get().globalSpeedLimit ?? 0
    })
  }

  // --- event plumbing ------------------------------------------------------

  on<K extends EngineEventName>(event: K, listener: (payload: EngineEvents[K]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const wrapped = listener as (payload: never) => void
    set.add(wrapped)
    return () => {
      set?.delete(wrapped)
    }
  }

  private emit<K extends EngineEventName>(event: K, payload: EngineEvents[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of [...set]) {
      try {
        ;(listener as (value: EngineEvents[K]) => void)(payload)
      } catch (err) {
        log.error('Engine listener threw', { event, error: err })
      }
    }
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Boots the engine: runs crash recovery, then starts the scheduler and
   * telemetry loops. Recovery must complete before anything is started so a
   * resumed download never races its own reconciliation.
   */
  async start(): Promise<RecoveryReport> {
    log.info('Engine starting', { downloads: this.repos.downloads.list().length })
    // The chunk size must match the task's, otherwise a rebuilt map uses a
    // different layout and every salvaged chunk is invalidated.
    const report = await runRecovery(this.repos, {
      verify: 'all',
      desiredChunkSize: this.settings.get().chunkSize
    })
    for (const download of this.repos.downloads.list()) {
      if (
        isTorrentSource(download.url) &&
        (download.status === 'connecting' || download.status === 'downloading' || download.status === 'verifying')
      ) {
        this.patch(download.id, { status: 'paused' })
      }
    }
    this.emit('recovery', report)
    await this.recoverPendingVideoMerges()
    for (const download of this.repos.downloads.listByStatus(['review'])) {
      if (!this.repos.mediaResolutions.get(download.id)) void this.runReviewLookup(download.id, true)
    }
    this.resumePendingMediaPages()
    this.restoreRunningQueuePlans()

    this.startTelemetry()
    this.startScheduler()
    this.pumpQueue()

    return report
  }

  /** Stops every task cleanly and flushes state to disk. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.telemetryTimer) clearInterval(this.telemetryTimer)
    if (this.schedulerTimer) clearInterval(this.schedulerTimer)
    this.telemetryTimer = null
    this.schedulerTimer = null
    for (const task of this.tasks.values()) {
      task.pause()
    }
    // Downloads pause promptly; any completion callback already doing an
    // essential conversion/mux must finish before the database is closed.
    await Promise.allSettled([
      ...this.taskRuns.values(),
      ...this.pendingPageArtwork.values()
    ])
    for (const task of this.tasks.values()) task.destroy()
    this.tasks.clear()
    this.taskRuns.clear()
    await this.transmission?.shutdown()
    this.transmission = null
    this.db.checkpoint()
    log.info('Engine stopped')
  }

  // --- commands ------------------------------------------------------------

  /**
   * Adds a new download.
   *
   * The URL is probed synchronously so the UI can immediately show the real
   * filename and size, and so a bad URL fails at the point of adding rather
   * than silently queueing forever. The record is persisted *before* it is
   * queued, which is what lets a crash between the two be recovered.
   */
  async add(request: AddDownloadRequest): Promise<AddDownloadResult> {
    const route = routeSource(request.url, request.format)
    log.info('Download router selected source path', {
      transport: route.transport,
      kind: route.kind,
      reason: route.reason
    })
    if (route.kind === 'torrent' || isTorrentRequest(request)) return this.addTorrent(request, false)
    if (route.kind !== 'direct-file') return this.addMediaPage(request)

    const settings = this.settings.get()
    const url = new URL(request.url)
    const id = newId()

    const headers = { ...(request.headers ?? {}) }

    const metadata = await withRetry(
      () => probe(request.url, { headers, signal: undefined }),
      {
        maxAttempts: 2,
        baseDelayMs: 400,
        onRetry: (err, attempt, delay) =>
          log.warn('Probe failed, retrying', { url: request.url, attempt, delay, error: err.message })
      }
    )

    if (metadata.rangeUnsupported && metadata.acceptRanges === false) {
      log.warn('Server does not support ranges; falling back to a single stream', { url })
    }

    const probedFilename =
      request.filename ??
      filenameFromContentDisposition(metadata.contentDisposition) ??
      filenameFromUrl(metadata.finalUrl)

    const filename = probedFilename

    const size = metadata.size ?? 0

    const download: Download = {
      id,
      url: request.url,
      finalUrl: metadata.finalUrl,
      filename,
      tempPath: '',
      finalPath: request.destination ? resolveWithin(settings.downloadDirectory, '') : null,
      fileSize: size,
      acceptRanges: metadata.acceptRanges,
      etag: metadata.etag,
      lastModified: metadata.lastModified,
      contentType: metadata.contentType,
      category: request.category ?? 'other',
      status: 'queued',
      downloadedBytes: 0,
      expectedChecksum: buildChecksumSpec(request.expectedChecksum, request.checksumAlgorithm),
      computedChecksum: null,
      priority: this.nextPriority(),
      retryCount: 0,
      maxRetries: settings.maxRetries,
      errorCode: null,
      errorMessage: null,
      speedLimit: request.speedLimit ?? null,
      quotaBytes: null,
      scheduledStartAt: request.scheduledStartAt ?? null,
      connections: request.connections ?? settings.defaultConnections,
      headers,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null
    }

    // Route the file to its category folder and create the directory.
    const destination = await resolveDownloadDestination({
      download,
      url: metadata.finalUrl,
      contentType: metadata.contentType,
      settings
    })
    download.tempPath = destination.tempPath
    download.finalPath = request.destination
      ? resolveWithin(settings.downloadDirectory, sanitizeFilename(basename(request.destination)))
      : destination.finalPath
    download.category = request.category ?? destination.category
    await ensureDir(dirname(download.tempPath))

    if (download.scheduledStartAt !== null) {
      download.status = 'scheduled'
    }

    this.repos.downloads.insert(download)
    emitActivity(this.repos, id, 'info', `Added: ${download.filename}`)
    this.emit('upserted', download)

    if (download.status === 'queued' && settings.autoStartDownloads) {
      this.enqueue(id)
      this.pumpQueue()
    }

    return {
      id,
      filename: download.filename,
      fileSize: download.fileSize,
      acceptRanges: download.acceptRanges
    }
  }

  /**
   * Adds a download that waits for review before any bytes move.
   *
   * An explicit choice is never second-guessed: a requested `format` or a
   * `sourceKind` recorded by the dialog (including its "send as a direct file
   * instead" escape) goes straight to the matching path. A request that
   * carries neither is staged as a file and routed from the server's own
   * response in `lookupReviewDownload`, because an extension-less link such as
   * `https://host/download/pc/` can only be told apart from a media page by
   * asking it.
   */
  async stage(request: AddDownloadRequest): Promise<AddDownloadResult> {
    if (isTorrentRequest(request)) return this.addTorrent(request, true)
    if (request.format !== undefined || request.sourceKind === 'page') {
      return this.addMediaPage(request, true)
    }
    return this.stageFileReview(request)
  }

  private async stageFileReview(request: AddDownloadRequest): Promise<AddDownloadResult> {
    const settings = this.settings.get()
    const id = newId()
    const now = Date.now()
    const headers = { ...(request.headers ?? {}) }
    const filename = request.filename ?? filenameFromUrl(request.url)
    const provisional: Download = {
      id,
      url: request.url,
      finalUrl: null,
      filename,
      tempPath: '',
      finalPath: null,
      fileSize: 0,
      acceptRanges: false,
      etag: null,
      lastModified: null,
      contentType: null,
      category: request.category ?? 'other',
      status: 'review',
      downloadedBytes: 0,
      expectedChecksum: buildChecksumSpec(request.expectedChecksum, request.checksumAlgorithm),
      computedChecksum: null,
      priority: this.nextPriority(),
      retryCount: 0,
      maxRetries: settings.maxRetries,
      errorCode: null,
      errorMessage: null,
      speedLimit: request.speedLimit ?? null,
      quotaBytes: null,
      scheduledStartAt: request.scheduledStartAt ?? null,
      connections: request.connections ?? settings.defaultConnections,
      headers,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    }
    const destination = await resolveDownloadDestination({
      download: provisional,
      url: request.url,
      settings
    })
    provisional.tempPath = destination.tempPath
    provisional.finalPath = destination.finalPath
    provisional.category = request.category ?? destination.category
    await ensureDir(dirname(provisional.tempPath))
    this.repos.downloads.insert(provisional)
    emitActivity(this.repos, id, 'info', 'Added for review')
    this.emit('upserted', provisional)
    void this.runReviewLookup(id, request.sourceKind === undefined)
    return { id, filename, fileSize: 0, acceptRanges: false }
  }

  private async addTorrent(request: AddDownloadRequest, review: boolean): Promise<AddDownloadResult> {
    const magnet = parseMagnetUri(request.url)
    const importedFile = isImportedTorrentFileUri(request.url)
    if (!magnet && !isTorrentFileUrl(request.url) && !importedFile) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Enter a valid BitTorrent v1/v2 magnet link, .torrent URL, or choose a .torrent file',
        retryable: false
      })
    }
    if (hasUnsupportedTorrentOptions(request)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Destinations, media options, custom headers, checksums, and connection counts are not supported for torrents',
        retryable: false
      })
    }
    if (importedFile && !request.torrentMetainfo) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'The selected .torrent file data is missing; choose the file again',
        retryable: false
      })
    }
    let metainfoBytes: Buffer | null = null
    if (importedFile) {
      const metainfo = request.torrentMetainfo
      if (!metainfo || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(metainfo)) {
        throw new EngineError({
          code: 'PRECONDITION_FAILED',
          message: 'The selected .torrent file data is malformed',
          retryable: false
        })
      }
      metainfoBytes = Buffer.from(metainfo, 'base64')
      const expectedDigest = request.url.slice('moth-torrent-file:'.length).toLowerCase()
      const actualDigest = createHash('sha256').update(metainfoBytes).digest('hex')
      if (
        metainfoBytes.length === 0 ||
        metainfoBytes.length > 8 * 1024 * 1024 ||
        metainfoBytes.toString('base64') !== metainfo ||
        actualDigest !== expectedDigest
      ) {
        throw new EngineError({
          code: 'PRECONDITION_FAILED',
          message: 'The selected .torrent file failed its integrity check; choose it again',
          retryable: false
        })
      }
    }

    const downloadLimit = transmissionLimit(request.speedLimit, 'download')
    const uploadLimit = transmissionLimit(request.uploadSpeedLimit, 'upload')

    const settings = this.settings.get()
    const id = newId()
    const now = Date.now()
    const torrentRoot = resolveWithin(settings.downloadDirectory, '.moth-torrents')
    const tempPath = resolveWithin(torrentRoot, id)
    await ensureDir(tempPath)
    if (metainfoBytes) await writeFile(getTorrentMetainfoPath(id, tempPath), metainfoBytes, { flag: 'wx' })

    const canonicalUri = request.url
    const filename = sanitizeFilename(
      request.filename ??
        magnet?.displayName ??
        (importedFile
          ? `Torrent ${request.url.slice(-8)}`
          : filenameFromUrl(request.url)),
      'torrent'
    )
    const download: Download = {
      id,
      url: canonicalUri,
      finalUrl: null,
      filename,
      tempPath,
      finalPath: null,
      fileSize: 0,
      acceptRanges: false,
      etag: null,
      lastModified: null,
      contentType: 'application/x-bittorrent',
      category: request.category ?? 'other',
      status: review ? 'review' : 'queued',
      downloadedBytes: 0,
      expectedChecksum: null,
      computedChecksum: null,
      priority: this.nextPriority(),
      retryCount: 0,
      maxRetries: settings.maxRetries,
      errorCode: null,
      errorMessage: null,
      speedLimit: downloadLimit.bytesPerSecond,
      uploadSpeedLimit: uploadLimit.bytesPerSecond,
      torrentFiles: request.torrentFiles ?? null,
      quotaBytes: null,
      scheduledStartAt: request.scheduledStartAt ?? null,
      connections: null,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    }
    if (download.scheduledStartAt !== null && download.scheduledStartAt > now && !review) {
      download.status = 'scheduled'
    }
    this.repos.downloads.insert(download)
    emitActivity(this.repos, id, 'info', 'Added to the Transmission torrent engine')
    this.emit('upserted', download)
    if (download.status === 'queued' && settings.autoStartDownloads) {
      this.enqueue(id)
      this.pumpQueue()
    }
    return { id, filename, fileSize: 0, acceptRanges: false }
  }

  getReviewRequest(id: DownloadId): AddDownloadRequest {
    const download = this.requireDownload(id)
    if (download.status !== 'review') {
      throw new EngineError({ code: 'PRECONDITION_FAILED', message: 'This download is no longer awaiting review', retryable: false })
    }
    const pending = this.repos.mediaResolutions.get(id)
    const request: AddDownloadRequest = {
      url: download.url,
      category: download.category,
      headers: download.headers,
      ...(isTorrentSource(download.url)
        ? {}
        : { connections: download.connections ?? this.settings.get().defaultConnections }),
      ...(download.speedLimit !== null ? { speedLimit: download.speedLimit } : {}),
      ...(download.uploadSpeedLimit !== null ? { uploadSpeedLimit: download.uploadSpeedLimit } : {}),
      ...(download.torrentFiles !== null ? { torrentFiles: download.torrentFiles } : {}),
      ...(download.expectedChecksum ? {
        expectedChecksum: download.expectedChecksum.value,
        checksumAlgorithm: download.expectedChecksum.algorithm
      } : {}),
      ...(download.scheduledStartAt !== null ? { scheduledStartAt: download.scheduledStartAt } : {})
    }
    if (pending) {
      request.format = pending.format
      request.audioFormat = pending.audioFormat
      request.videoQuality = pending.videoQuality
      request.embedMetadata = pending.embedMetadata
      if (pending.subtitleLanguages.length > 0) request.subtitleLanguages = pending.subtitleLanguages
      if (pending.namingTemplate) request.namingTemplate = pending.namingTemplate
    }
    return request
  }

  async configureReview(id: DownloadId, request: AddDownloadRequest): Promise<Download> {
    const current = this.requireDownload(id)
    if (current.status !== 'review' || request.url !== current.url) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Only a download awaiting review can be configured, and its source link cannot be changed here',
        retryable: false
      })
    }
    const torrent = isTorrentSource(current.url)
    if (torrent && hasUnsupportedTorrentOptions(request)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Destinations, media options, custom headers, checksums, connection counts, and per-download speed limits are not supported for torrents yet',
        retryable: false
      })
    }
    const previousPending = this.repos.mediaResolutions.get(id)
    const mediaRequest = request.format !== undefined
    const nextPending: PendingMediaResolution | null = mediaRequest
      ? {
          downloadId: id,
          format: request.format!,
          audioFormat: request.audioFormat ?? previousPending?.audioFormat ?? 'mp3',
          videoQuality: request.videoQuality ?? previousPending?.videoQuality ?? (VIDEO_MAX_HEIGHT as VideoQuality),
          requestedFilename: request.filename ?? previousPending?.requestedFilename ?? null,
          requestedDestination: previousPending?.requestedDestination ?? null,
          sourcePageUrl: normalizedPageUrl(current.url),
          resolved: false,
          mediaId: null,
          mediaTitle: null,
          subtitleLanguages: request.subtitleLanguages ?? previousPending?.subtitleLanguages ?? [],
          namingTemplate: request.namingTemplate ?? previousPending?.namingTemplate ?? null,
          embedMetadata: request.embedMetadata ?? previousPending?.embedMetadata ?? true
        }
      : null

    if (nextPending) this.repos.mediaResolutions.set(nextPending)
    else if (previousPending) {
      this.repos.mediaResolutions.remove(id)
      this.repos.audioTranscodes.remove(id)
      this.repos.videoMerges.remove(id)
    }

    const updated = this.patch(id, {
      ...(request.filename ? { filename: request.filename } : {}),
      category: request.category ?? current.category,
      expectedChecksum: buildChecksumSpec(request.expectedChecksum, request.checksumAlgorithm),
      speedLimit: torrent
        ? transmissionLimit(request.speedLimit ?? null, 'download').bytesPerSecond
        : request.speedLimit ?? null,
      uploadSpeedLimit: torrent
        ? transmissionLimit(request.uploadSpeedLimit ?? null, 'upload').bytesPerSecond
        : request.uploadSpeedLimit ?? null,
      torrentFiles: request.torrentFiles !== undefined
        ? request.torrentFiles
        : current.torrentFiles,
      scheduledStartAt: request.scheduledStartAt ?? null,
      connections: torrent ? null : request.connections ?? this.settings.get().defaultConnections,
      headers: { ...current.headers, ...(request.headers ?? {}) },
      finalUrl: nextPending ? null : current.finalUrl,
      fileSize: nextPending ? 0 : current.fileSize,
      acceptRanges: nextPending ? false : current.acceptRanges,
      etag: nextPending ? null : current.etag,
      lastModified: nextPending ? null : current.lastModified,
      contentType: nextPending ? null : current.contentType,
      status: 'review',
      errorCode: null,
      errorMessage: null
    })

    if (nextPending) {
      const mediaRequestForPrepare: AddDownloadRequest = {
        ...request,
        url: current.url,
        format: nextPending.format,
        audioFormat: nextPending.audioFormat,
        videoQuality: nextPending.videoQuality,
        subtitleLanguages: nextPending.subtitleLanguages,
        namingTemplate: nextPending.namingTemplate ?? undefined,
        embedMetadata: nextPending.embedMetadata
      }
      this.launchMediaPreparation(id, mediaRequestForPrepare)
      return updated
    }

    if (isTorrentSource(current.url)) {
      return this.patch(id, {
        tempPath: current.tempPath,
        finalPath: null,
        category: request.category ?? current.category
      })
    }

    const destination = await resolveDownloadDestination({
      download: { ...updated, finalPath: null, tempPath: '' },
      url: updated.url,
      settings: this.settings.get()
    })
    await ensureDir(dirname(destination.tempPath))
    return this.patch(id, {
      tempPath: destination.tempPath,
      finalPath: destination.finalPath,
      category: request.category ?? destination.category
    })
  }

  /**
   * Runs the link lookup for a staged row at most once.
   *
   * The returned promise is what `startReviewDownload` waits on, so a redirect
   * that only reveals its real filename through its response is always
   * identified before the file is created.
   */
  private runReviewLookup(id: DownloadId, routeFromProbe: boolean): Promise<void> {
    const running = this.reviewLookups.get(id)
    if (running) return running
    const lookup = this.lookupReviewDownload(id, routeFromProbe).finally(() => {
      this.reviewLookups.delete(id)
    })
    this.reviewLookups.set(id, lookup)
    return lookup
  }

  async startReviewDownload(id: DownloadId): Promise<Download> {
    const download = this.requireDownload(id)
    if (download.status !== 'review') {
      throw new EngineError({ code: 'PRECONDITION_FAILED', message: 'This download is no longer awaiting review', retryable: false })
    }
    // A staged link can still be unidentified. `https://host/download/pc/`
    // only reveals its real filename, size and extension through its response,
    // so starting before the lookup lands would save the file as "pc". Let the
    // lookup the engine already began settle first — the row deliberately stays
    // in review until then, which is also the state the lookup requires.
    const lookup = this.reviewLookups.get(id)
    if (lookup) await lookup
    if (this.shuttingDown) return this.requireDownload(id)
    const latest = this.repos.downloads.get(id)
    if (!latest || latest.status !== 'review') return latest ?? this.requireDownload(id)

    const pending = this.repos.mediaResolutions.get(id)
    if (pending && !pending.resolved) {
      const request = this.getReviewRequest(id)
      const updated = this.patch(id, { status: 'queued', errorCode: null, errorMessage: null })
      if (!this.mediaPreparations.has(id)) {
        this.launchMediaPreparation(id, request)
      }
      return updated
    }
    if (latest.scheduledStartAt !== null && latest.scheduledStartAt > Date.now()) {
      return this.patch(id, { status: 'scheduled', errorCode: null, errorMessage: null })
    }
    const updated = this.patch(id, { status: 'queued', errorCode: null, errorMessage: null })
    this.enqueue(id)
    this.pumpQueue()
    return updated
  }

  /**
   * Fills in a staged row from the server's response.
   *
   * `routeFromProbe` is false only when the caller already stated what the
   * source is (the dialog's explicit direct-file choice). Then a document in
   * the response is recorded as-is instead of being rerouted to media
   * resolution, because that choice is the user's, not the engine's.
   */
  private async lookupReviewDownload(id: DownloadId, routeFromProbe = true): Promise<void> {
    const initial = this.repos.downloads.get(id)
    if (!initial || initial.status !== 'review') return
    try {
      const metadata = await withRetry(() => probe(initial.url, { headers: initial.headers }), {
        maxAttempts: 2,
        baseDelayMs: 400,
        onRetry: (err, attempt, delay) =>
          log.warn('Review lookup retrying', { id, attempt, delay, error: err.message })
      })
      if (this.shuttingDown) return
      const current = this.repos.downloads.get(id)
      if (!current || current.status !== 'review') return

      // The URL text said nothing (no extension, unknown host) and the server
      // answered with a document, so this is a media page after all. Turn the
      // staged file into a page grab through the same path the dialog uses,
      // instead of queueing an HTML file for download. A URL that already named
      // a file extension is never rerouted: the response cannot outvote the URL.
      if (
        routeFromProbe &&
        classifyUrl(initial.url) === 'page' &&
        classifyProbedResponse(metadata) === 'media-page' &&
        !this.repos.mediaResolutions.get(id)
      ) {
        log.info('Review lookup found a media page; resolving it instead', {
          id,
          url: metadata.finalUrl
        })
        emitActivity(this.repos, id, 'info', 'Link is a media page; preparing the grab')
        await this.configureReview(id, { ...this.getReviewRequest(id), format: 'video' })
        return
      }

      const urlDerivedName = filenameFromUrl(current.url)
      // A staged row starts with the URL's last path segment, which is not a
      // name. Replace that with the one the response implies; keep a name the
      // user chose.
      const probedName =
        filenameFromContentDisposition(metadata.contentDisposition) ?? filenameFromUrl(metadata.finalUrl)
      const filename =
        !current.filename || current.filename === urlDerivedName ? probedName : current.filename
      const next: Download = {
        ...current,
        finalUrl: metadata.finalUrl,
        filename,
        fileSize: metadata.size ?? 0,
        acceptRanges: metadata.acceptRanges,
        etag: metadata.etag,
        lastModified: metadata.lastModified,
        contentType: metadata.contentType
      }
      const destination = await resolveDownloadDestination({
        download: { ...next, tempPath: '', finalPath: null },
        url: metadata.finalUrl,
        contentType: metadata.contentType,
        settings: this.settings.get()
      })
      next.tempPath = destination.tempPath
      next.finalPath = destination.finalPath
      if (current.category === 'other') next.category = destination.category
      await ensureDir(dirname(next.tempPath))
      this.repos.downloads.upsert(next)
      this.emit('upserted', next)
      emitActivity(this.repos, id, 'info', 'Link lookup complete; ready for review')
    } catch (err) {
      if (this.shuttingDown) return
      const error = toEngineError(err)
      const current = this.repos.downloads.get(id)
      if (!current || current.status !== 'review') return
      this.patch(id, { errorCode: error.code, errorMessage: error.message })
      emitActivity(this.repos, id, 'warn', `Link lookup failed: ${error.message}`)
    }
  }

  private launchMediaPreparation(id: DownloadId, request: AddDownloadRequest): void {
    this.mediaPreparations.add(id)
    void this.prepareMediaPage(id, request)
      .catch((err: unknown) => {
        if (this.shuttingDown) return
        log.error('Unexpected media preparation failure', { id, error: err })
        this.failMediaPreparation(id, err)
      })
      .finally(() => this.mediaPreparations.delete(id))
  }

  private async addMediaPage(request: AddDownloadRequest, review = false): Promise<AddDownloadResult> {
    const settings = this.settings.get()
    const pageUrl = new URL(request.url)
    const id = newId()
    const now = Date.now()
    const format = request.format ?? 'video'
    const filename = request.filename ?? `Preparing ${format} from ${pageUrl.hostname}`
    const headers = { ...(request.headers ?? {}) }
    const placeholder: Download = {
      id,
      url: request.url,
      finalUrl: null,
      filename,
      tempPath: '',
      finalPath: null,
      fileSize: 0,
      acceptRanges: false,
      etag: null,
      lastModified: null,
      contentType: null,
      category: request.category ?? (format === 'audio' ? 'audio' : 'video'),
      status: review ? 'review' : 'connecting',
      downloadedBytes: 0,
      expectedChecksum: buildChecksumSpec(request.expectedChecksum, request.checksumAlgorithm),
      computedChecksum: null,
      priority: this.nextPriority(),
      retryCount: 0,
      maxRetries: settings.maxRetries,
      errorCode: null,
      errorMessage: null,
      speedLimit: request.speedLimit ?? null,
      quotaBytes: null,
      scheduledStartAt: request.scheduledStartAt ?? null,
      connections: request.connections ?? settings.defaultConnections,
      headers,
      createdAt: now,
      updatedAt: now,
      startedAt: review ? null : now,
      completedAt: null
    }
    const destinationDownload = request.destination
      ? {
          ...placeholder,
          finalPath: resolveWithin(settings.downloadDirectory, sanitizeFilename(basename(request.destination)))
        }
      : placeholder
    const destination = await resolveDownloadDestination({
      download: destinationDownload,
      url: request.url,
      settings
    })
    placeholder.finalPath = request.destination
      ? resolveWithin(settings.downloadDirectory, sanitizeFilename(basename(request.destination)))
      : destination.finalPath
    placeholder.tempPath = destination.tempPath
    placeholder.category = request.category ?? destination.category
    await ensureDir(dirname(placeholder.tempPath))

    this.repos.downloads.insert(placeholder)
    this.repos.mediaResolutions.set({
      downloadId: id,
      format,
      audioFormat: request.audioFormat ?? 'mp3',
      videoQuality: request.videoQuality ?? (VIDEO_MAX_HEIGHT as VideoQuality),
      requestedFilename: request.filename ?? null,
      requestedDestination: request.destination ?? null,
      sourcePageUrl: normalizedPageUrl(request.url),
      resolved: false,
      mediaId: null,
      mediaTitle: null,
      subtitleLanguages: request.subtitleLanguages ?? [],
      namingTemplate: request.namingTemplate ?? null,
      embedMetadata: request.embedMetadata ?? true
    })
    log.info('Media page queued for resolution', {
      id,
      url: request.url,
      format,
      videoQuality: request.videoQuality ?? VIDEO_MAX_HEIGHT
    })
    emitActivity(this.repos, id, 'info', 'Preparing media page')
    this.emit('upserted', placeholder)
    this.launchMediaPreparation(id, request)

    return { id, filename, fileSize: 0, acceptRanges: false }
  }

  private async prepareMediaPage(id: DownloadId, request: AddDownloadRequest): Promise<void> {
    const pending = this.repos.mediaResolutions.get(id)
    const initial = this.repos.downloads.get(id)
    if (!pending || !initial || initial.status === 'canceled') return

    log.info('Preparing media page', {
      id,
      url: request.url,
      format: pending.format,
      videoQuality: pending.videoQuality
    })
    try {
      const sourceRoute = routeSource(request.url, pending.format)
      log.info('Download router selected media-page path', {
        id,
        transport: sourceRoute.transport,
        kind: sourceRoute.kind,
        reason: sourceRoute.reason
      })

      const resolvedVideo = sourceRoute.kind === 'site-adapter'
        ? await this.resolveSiteAdapterMedia(request, initial.headers)
        : await this.resolvePageUrl(request, initial.headers)
      if (this.shuttingDown) return
      if (!sameMediaResolution(pending, this.repos.mediaResolutions.get(id))) return
      if (sourceRoute.kind === 'youtube-page') {
        await this.prepareYtDlpMediaPage(id, request, pending, resolvedVideo)
        return
      }
      log.info('Media streams resolved', {
        id,
        url: resolvedVideo.url,
        audioUrl: resolvedVideo.audioUrl,
        filename: resolvedVideo.filename,
        mergeContainer: resolvedVideo.mergeContainer,
        hint: resolvedVideo.hint
      })
      const live = this.repos.downloads.get(id)
      if (!sameMediaResolution(pending, this.repos.mediaResolutions.get(id)) || !live || live.status === 'canceled') return
      const headers = { ...live.headers, ...resolvedVideo.headers }
      const metadata = await withRetry(
        () => probe(resolvedVideo.url, { headers, signal: undefined }),
        {
          maxAttempts: 2,
          baseDelayMs: 400,
          onRetry: (err, attempt, delay) =>
            log.warn('Resolved media probe failed, retrying', { id, attempt, delay, error: err.message })
        }

      )
      const transferRoute = routeTransfer({
        ...metadata,
        etag: metadata.etag,
        lastModified: metadata.lastModified
      })
      log.info('Download router selected resolved-stream transfer strategy', {
        id,
        strategy: transferRoute.strategy,
        resumable: transferRoute.resumable,
        reason: transferRoute.reason
      })
      if (this.shuttingDown) return
      const afterProbe = this.repos.downloads.get(id)
      if (!sameMediaResolution(pending, this.repos.mediaResolutions.get(id)) || !afterProbe || afterProbe.status === 'canceled') return

      let filename = pending.requestedFilename ?? resolvedVideo.filename ??
        filenameFromContentDisposition(metadata.contentDisposition) ??
        filenameFromUrl(metadata.finalUrl)
      if (pending.format === 'audio' && pending.audioFormat === 'mp3') filename = withMp3Extension(filename)
      if (pending.format === 'audio' && pending.audioFormat === 'source') {
        filename = withSourceAudioExtension(filename, resolvedVideo.filename)
      }
      if (!pending.requestedFilename && pending.namingTemplate) {
        filename = renderMediaFilename(pending.namingTemplate, resolvedVideo, request.url)
      }
      if (pending.format === 'video' && resolvedVideo.mergeContainer) {
        filename = withVideoExtension(filename, resolvedVideo.mergeContainer)
      }

      const next: Download = {
        ...afterProbe,
        url: resolvedVideo.url,
        finalUrl: metadata.finalUrl,
        filename,
        fileSize: metadata.size ?? 0,
        acceptRanges: metadata.acceptRanges,
        etag: metadata.etag,
        lastModified: metadata.lastModified,
        contentType: metadata.contentType
      }
      const destination = await resolveDownloadDestination({
        download: pending.requestedDestination
          ? {
              ...next,
              finalPath: resolveWithin(
                this.settings.get().downloadDirectory,
                sanitizeFilename(basename(pending.requestedDestination))
              ),
              tempPath: ''
            }
          : { ...next, finalPath: null, tempPath: '' },
        url: metadata.finalUrl,
        contentType: metadata.contentType,
        settings: this.settings.get()
      })
      next.tempPath = destination.tempPath
      next.finalPath = pending.requestedDestination
        ? resolveWithin(this.settings.get().downloadDirectory, sanitizeFilename(basename(pending.requestedDestination)))
        : destination.finalPath
      next.category = request.category ?? destination.category
      await ensureDir(dirname(next.tempPath))

      if (this.shuttingDown) return
      const latest = this.repos.downloads.get(id)
      if (!sameMediaResolution(pending, this.repos.mediaResolutions.get(id)) || !latest || latest.status === 'canceled') return
      const explicitlyStarted = latest.status === 'queued'
      next.status =
        latest.status === 'review'
          ? 'review'
          : latest.status === 'paused'
            ? 'paused'
            : latest.scheduledStartAt !== null
              ? 'scheduled'
              : 'queued'
        next.startedAt = null

        this.repos.downloads.upsert(next)
        if (
        pending.format === 'audio' &&
        pending.audioFormat === 'mp3' &&
        (resolvedVideo.hint?.needsTranscode ?? true)
      ) {
        this.repos.audioTranscodes.set(id)
      }
      if (pending.format === 'video' && resolvedVideo.audioUrl && resolvedVideo.mergeContainer) {
        this.repos.videoMerges.set({
          downloadId: id,
          audioUrl: resolvedVideo.audioUrl,
          container: resolvedVideo.mergeContainer,
          headers: headersForResolvedAudio(headers, request.url, resolvedVideo.audioUrl, resolvedVideo.audioHeaders)
        })
      }
      this.repos.mediaResolutions.markResolved(id, resolvedVideo.sourceKey ?? null, resolvedVideo.mediaHint?.title ?? null)
      if (resolvedVideo.mediaHint && this.media) {
        this.pendingMediaHints.set(id, resolvedVideo.mediaHint)
        const mediaService = this.media
        let artworkTask: Promise<void>
        artworkTask = mediaService
          .resolvePageHint(id, resolvedVideo.mediaHint)
          .then((metadata) => {
            if (!metadata) return
            const current = this.repos.downloads.get(id)
            if (current) this.emit('upserted', current)
            this.emit('mediaUpdated', { id })
          })
          .catch((err: unknown) => {
            log.warn('Could not load page artwork while download is active', { id, error: err })
          })
          .finally(() => {
            if (this.pendingPageArtwork.get(id) === artworkTask) {
              this.pendingPageArtwork.delete(id)
            }
          })
        this.pendingPageArtwork.set(id, artworkTask)
      }
      emitActivity(this.repos, id, 'info', `Added: ${next.filename}`)
      this.emit('upserted', next)
      if (next.status === 'queued' && (explicitlyStarted || this.settings.get().autoStartDownloads)) {
        this.enqueue(id)
        this.pumpQueue()
      }
      if (request.subtitleLanguages?.length) {
        this.queueSubtitleSidecars(id, next.filename, resolvedVideo.subtitleTracks ?? [])
      }
    } catch (err) {
      if (this.shuttingDown) return
      this.failMediaPreparation(id, err)
    }
  }

  private async prepareYtDlpMediaPage(
    id: DownloadId,
    request: AddDownloadRequest,
    pending: NonNullable<ReturnType<Repositories['mediaResolutions']['get']>>,
    resolvedVideo: ResolvedVideo
  ): Promise<void> {
    const current = this.repos.downloads.get(id)
    if (!current || current.status === 'canceled' || !this.repos.mediaResolutions.get(id)) return
    let filename = pending.requestedFilename ?? resolvedVideo.filename ?? `YouTube ${pending.format}`
    if (pending.format === 'audio' && pending.audioFormat === 'mp3') filename = withMp3Extension(filename)
    if (pending.format === 'audio' && pending.audioFormat === 'source') {
      filename = withSourceAudioExtension(filename, resolvedVideo.filename)
    }
    if (!pending.requestedFilename && pending.namingTemplate) {
      filename = renderMediaFilename(pending.namingTemplate, resolvedVideo, request.url)
    }
    const initialDownload: Download = {
      ...current,
      url: pending.sourcePageUrl,
      finalUrl: pending.sourcePageUrl,
      filename,
      fileSize: 0,
      acceptRanges: false,
      etag: null,
      lastModified: null,
      contentType: pending.format === 'audio' ? 'audio/mpeg' : 'video/mp4',
      finalPath: null,
      tempPath: ''
    }
    const settings = this.settings.get()
    const destination = await resolveDownloadDestination({
      download: initialDownload,
      url: pending.sourcePageUrl,
      contentType: initialDownload.contentType,
      settings
    })
    const latest = this.repos.downloads.get(id)
    if (!latest || latest.status === 'canceled' || !sameMediaResolution(pending, this.repos.mediaResolutions.get(id))) return
    const explicitlyStarted = latest.status === 'queued'
    const next: Download = {
      ...initialDownload,
      tempPath: destination.tempPath,
      finalPath: pending.requestedDestination
        ? resolveWithin(settings.downloadDirectory, sanitizeFilename(basename(pending.requestedDestination)))
        : destination.finalPath,
      category: request.category ?? destination.category,
      status: latest.status === 'review'
        ? 'review'
        : latest.status === 'paused'
          ? 'paused'
          : latest.scheduledStartAt !== null
            ? 'scheduled'
            : 'queued',
      startedAt: null
    }
    await ensureDir(dirname(next.tempPath))
    if (this.shuttingDown || !sameMediaResolution(pending, this.repos.mediaResolutions.get(id))) return
    this.repos.downloads.upsert(next)
    this.repos.videoMerges.remove(id)
    this.repos.audioTranscodes.remove(id)
    this.repos.mediaResolutions.markResolved(
      id,
      resolvedVideo.sourceKey ?? null,
      resolvedVideo.mediaHint?.title ?? null
    )
    if (resolvedVideo.mediaHint && this.media) {
      this.pendingMediaHints.set(id, resolvedVideo.mediaHint)
      const mediaService = this.media
      let artworkTask: Promise<void>
      artworkTask = mediaService
        .resolvePageHint(id, resolvedVideo.mediaHint)
        .then((metadata) => {
          if (!metadata) return
          const updated = this.repos.downloads.get(id)
          if (updated) this.emit('upserted', updated)
          this.emit('mediaUpdated', { id })
        })
        .catch((err: unknown) => {
          log.warn('Could not load page artwork while download is active', { id, error: err })
        })
        .finally(() => {
          if (this.pendingPageArtwork.get(id) === artworkTask) this.pendingPageArtwork.delete(id)
        })
      this.pendingPageArtwork.set(id, artworkTask)
    }
    emitActivity(this.repos, id, 'info', `Added: ${next.filename}`)
    this.emit('upserted', next)
    await this.pendingPageArtwork.get(id)
    if (next.status === 'queued' && (explicitlyStarted || settings.autoStartDownloads)) {
      this.enqueue(id)
      this.pumpQueue()
    }
    if (request.subtitleLanguages?.length) {
      this.queueSubtitleSidecars(id, next.filename, resolvedVideo.subtitleTracks ?? [])
    }
  }

  private failMediaPreparation(id: DownloadId, cause: unknown): void {
    const current = this.repos.downloads.get(id)
    if (!current || current.status === 'canceled') return
    const error = toEngineError(cause)
    log.error('Media page preparation failed', {
      id,
      url: current.url,
      format: this.repos.mediaResolutions.get(id)?.format,
      error
    })
    const message = `Could not prepare media: ${error.message}`
    const reviewing = current.status === 'review'
    this.patch(id, { status: reviewing ? 'review' : 'failed', errorCode: error.code, errorMessage: message })
    emitActivity(this.repos, id, 'error', `Failed: ${message}`)
    if (!reviewing) this.emit('failed', { id, code: error.code, message, retryable: false })
  }

  private queueSubtitleSidecars(
    parentId: DownloadId,
    mediaFilename: string,
    tracks: NonNullable<ResolvedVideo['subtitleTracks']>
  ): void {
    if (tracks.length === 0) {
      emitActivity(
        this.repos,
        parentId,
        'warn',
        'No downloadable subtitle tracks matched the requested languages'
      )
      return
    }
    const dot = mediaFilename.lastIndexOf('.')
    const stem = dot > 0 ? mediaFilename.slice(0, dot) : mediaFilename
    for (const track of tracks) {
      const language = track.language.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 35)
      const automatic = track.automatic ? '.auto' : ''
      const filename = sanitizeFilename(`${stem}.${language}${automatic}.${track.extension}`)
      if (this.repos.downloads.list().some((download) => download.filename === filename)) continue
      void this.add({
        url: track.url,
        filename,
        headers: track.headers,
        category: 'other'
      }).catch((err: unknown) => {
        const error = toEngineError(err)
        log.warn('Could not queue subtitle sidecar', { id: parentId, language, code: error.code })
        emitActivity(this.repos, parentId, 'warn', `Could not queue ${language} subtitle: ${error.message}`)
      })
    }
  }

  private async refreshMediaPage(
    id: DownloadId,
    mediaResolution: NonNullable<ReturnType<Repositories['mediaResolutions']['get']>>,
    download: Download
  ): Promise<void> {
    try {
      if (isYouTubePage(mediaResolution.sourcePageUrl)) {
        await clearYtDlpWorkDirectory(download.tempPath)
      }
      await deleteFile(download.tempPath)
      this.repos.chunks.invalidateAll(id)
      this.repos.downloads.update(id, { downloadedBytes: 0, computedChecksum: null })
      this.repos.mediaResolutions.markUnresolved(id)
      const request: AddDownloadRequest = {
        url: mediaResolution.sourcePageUrl,
        format: mediaResolution.format,
        audioFormat: mediaResolution.audioFormat,
        videoQuality: mediaResolution.videoQuality,
        subtitleLanguages: mediaResolution.subtitleLanguages,
        ...(mediaResolution.namingTemplate ? { namingTemplate: mediaResolution.namingTemplate } : {}),
        embedMetadata: mediaResolution.embedMetadata,
        headers: download.headers,
        ...(mediaResolution.requestedFilename ? { filename: mediaResolution.requestedFilename } : {}),
        ...(mediaResolution.requestedDestination ? { destination: mediaResolution.requestedDestination } : {}),
        ...(download.category !== 'other' ? { category: download.category } : {}),
        ...(download.expectedChecksum ? { expectedChecksum: download.expectedChecksum.value } : {}),
        speedLimit: download.speedLimit,
        scheduledStartAt: download.scheduledStartAt,
        ...(download.connections !== null ? { connections: download.connections } : {})
      }
      await this.prepareMediaPage(id, request)
    } catch (err) {
      this.failMediaPreparation(id, err)
    }
  }

  private resumePendingMediaPages(): void {
    for (const pending of this.repos.mediaResolutions.list()) {
      const download = this.repos.downloads.get(pending.downloadId)
      if (!download || pending.resolved || download.status === 'canceled' || download.status === 'completed') continue
      const request: AddDownloadRequest = {
        url: pending.sourcePageUrl || download.url,
        format: pending.format,
        videoQuality: pending.videoQuality,
        audioFormat: pending.audioFormat,
        subtitleLanguages: pending.subtitleLanguages,
        ...(pending.namingTemplate ? { namingTemplate: pending.namingTemplate } : {}),
        embedMetadata: pending.embedMetadata,
        headers: download.headers,
        ...(pending.requestedFilename ? { filename: pending.requestedFilename } : {}),
        ...(pending.requestedDestination ? { destination: pending.requestedDestination } : {}),
        ...(download.category !== 'other' ? { category: download.category } : {}),
        ...(download.expectedChecksum ? { expectedChecksum: download.expectedChecksum.value } : {}),
        speedLimit: download.speedLimit,
        scheduledStartAt: download.scheduledStartAt,
        ...(download.connections !== null ? { connections: download.connections } : {})
      }
      if (download.status !== 'review' && download.status !== 'queued') {
        this.patch(pending.downloadId, {
          status: 'connecting',
          errorCode: null,
          errorMessage: null
        })
      }
      this.launchMediaPreparation(pending.downloadId, request)
    }
  }

  /**
   * Resolves page metadata and stream information via the pinned resolver.
   *
   * Extension-forwarded auth travels as plain headers; the resolver never
   * touches a browser profile. A resolver failure throws a clear,
   * non-retryable error for this download — never anything app-fatal.
   */
  private async resolveSiteAdapterMedia(
    request: AddDownloadRequest,
    headers: Record<string, string>
  ): Promise<ResolvedVideo> {
    const adapter = getEnabledSiteAdapterForUrl(request.url)
    if (!adapter) {
      throw new EngineError({
        code: 'HTTP_CLIENT_ERROR',
        message: `No enabled site adapter exists for ${request.url}`,
        retryable: false
      })
    }

    const userAgent = headers['user-agent'] ?? headers['User-Agent'] ?? 'Mozilla/5.0 (compatible; Moth/1.0)'
    const referer = headers['referer'] ?? headers['Referer']
    const cookie = headers['cookie'] ?? headers['Cookie']

    const pageResponse = await fetch(normalizedPageUrl(request.url), {
      headers: {
        ...(userAgent ? { 'User-Agent': userAgent } : {}),
        ...(referer ? { Referer: referer } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    })

    if (!pageResponse.ok) {
      throw new EngineError({
        code: 'HTTP_CLIENT_ERROR',
        message: `The experimental adapter could not read ${request.url}: HTTP ${pageResponse.status}`,
        retryable: false
      })
    }

    const pageHtml = await pageResponse.text()
    const candidate = await resolveSiteAdapterCandidate(request.url, {
      pageHtml,
      headers: { ...headers }
    })

    if (!candidate) {
      throw new EngineError({
        code: 'HTTP_CLIENT_ERROR',
        message: `The page did not expose a usable media candidate for ${adapter.name}`,
        retryable: false
      })
    }

    return {
      url: candidate.url,
      filename: candidate.filename ?? filenameFromUrl(candidate.url),
      headers: {
        ...headers,
        ...(candidate.headers ?? {})
      },
      hint: {
        needsTranscode: candidate.kind === 'audio',
        acodec: candidate.kind === 'audio' ? 'mp3' : null,
        vcodec: candidate.kind === 'video' ? 'h264' : null,
        height: null
      }
    }
  }

  private async resolvePageUrl(
    request: AddDownloadRequest,
    headers: Record<string, string>
  ): Promise<ResolvedVideo> {
    const settings = this.settings.get()
    const cookies = headers['cookie'] ?? headers['Cookie']
    const userAgent = headers['user-agent'] ?? headers['User-Agent']
    const referer = headers['referer'] ?? headers['Referer']

    let ytDlpPath: string | undefined
    if (!isVideoResolverStubbed()) {
      const userDataDir = getVideoCaptureUserDataDir()
      if (!userDataDir) {
        throw new EngineError({
          code: 'INTERNAL',
          message: 'Media capture is not ready yet — restart the app and try again',
          retryable: false
        })
      }

      const helpers = await ensureYtDlpHelper({
        userDataDir,
        ...(settings.helperDir !== '' ? { helperDir: settings.helperDir } : {}),
        ytDlpVersion: settings.ytDlpVersion,
        ffmpegVersion: settings.ffmpegVersion
      })
      ytDlpPath = helpers.ytDlpPath
    }

    try {
      return await resolveVideo(request.url, request.format ?? 'video', {
        ...(cookies !== undefined ? { cookies } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
        ...(referer !== undefined ? { referer } : {}),
        ...(request.videoQuality !== undefined ? { videoQuality: request.videoQuality } : {}),
        ...(request.audioFormat !== undefined ? { audioFormat: request.audioFormat } : {}),
        ...(request.subtitleLanguages !== undefined ? { subtitleLanguages: request.subtitleLanguages } : {}),
        ...(routeSource(request.url, request.format).kind === 'youtube-page' ? { transferWithYtDlp: true } : {}),
        ...(ytDlpPath !== undefined ? { ytDlpPath } : {})
      })
    } catch (err) {
      const error = toEngineError(err)
      throw new EngineError({
        code: error.code,
        message: `Could not grab media from this page: ${error.message}`,
        retryable: false,
        cause: err
      })
    }
  }

  async previewMediaPlaylist(pageUrl: string): Promise<MediaPlaylistPreview> {
    let ytDlpPath: string | undefined
    if (!isVideoResolverStubbed()) {
      const userDataDir = getVideoCaptureUserDataDir()
      if (!userDataDir) {
        throw new EngineError({
          code: 'INTERNAL',
          message: 'Media capture is not ready yet — restart the app and try again',
          retryable: false
        })
      }
      const settings = this.settings.get()
      const helpers = await ensureYtDlpHelper({
        userDataDir,
        ...(settings.helperDir !== '' ? { helperDir: settings.helperDir } : {}),
        ytDlpVersion: settings.ytDlpVersion,
        ffmpegVersion: settings.ffmpegVersion
      })
      ytDlpPath = helpers.ytDlpPath
    }
    const playlist = await resolvePlaylist(pageUrl, { ...(ytDlpPath ? { ytDlpPath } : {}) })
    return {
      ...playlist,
      entries: playlist.entries.map((entry) => ({
        ...entry,
        alreadyDownloaded:
          (entry.sourceKey !== null && this.repos.mediaHistory.hasSourceKey(entry.sourceKey)) ||
          this.repos.mediaHistory.findByPageUrl(normalizedPageUrl(entry.url)) !== null
      }))
    }
  }

  checkMediaDuplicate(pageUrl: string): DuplicateMediaResult {
    const entry = this.repos.mediaHistory.findByPageUrl(normalizedPageUrl(pageUrl))
    return entry
      ? { duplicate: true, title: entry.title, filename: entry.filename }
      : { duplicate: false, title: null, filename: null }
  }

  /** Resumes (or starts) a download. */
  async resume(id: DownloadId): Promise<Download> {
    const download = this.requireDownload(id)
    if (download.status === 'downloading' || download.status === 'connecting') return download
    if (download.status === 'completed') return download

    const mediaResolution = this.repos.mediaResolutions.get(id)
    if (mediaResolution && !mediaResolution.resolved) {
      const updated = this.patch(id, { status: 'connecting', errorCode: null, errorMessage: null })
      if (download.status === 'failed') {
        const request: AddDownloadRequest = {
          url: mediaResolution.sourcePageUrl || download.url,
          format: mediaResolution.format,
          videoQuality: mediaResolution.videoQuality,
          audioFormat: mediaResolution.audioFormat,
          subtitleLanguages: mediaResolution.subtitleLanguages,
          ...(mediaResolution.namingTemplate ? { namingTemplate: mediaResolution.namingTemplate } : {}),
          embedMetadata: mediaResolution.embedMetadata,
          headers: download.headers,
          ...(mediaResolution.requestedFilename ? { filename: mediaResolution.requestedFilename } : {}),
          ...(mediaResolution.requestedDestination ? { destination: mediaResolution.requestedDestination } : {}),
          ...(download.category !== 'other' ? { category: download.category } : {}),
          ...(download.expectedChecksum ? { expectedChecksum: download.expectedChecksum.value } : {}),
          speedLimit: download.speedLimit,
          scheduledStartAt: download.scheduledStartAt,
          ...(download.connections !== null ? { connections: download.connections } : {})
        }
        void this.prepareMediaPage(id, request)
      }
      return updated
    }

    // A poisoned row (failed checksum before cleanup ran, e.g. crash or an
    // older version) must never resume onto corrupt bytes: reset first so the
    // run re-downloads instead of re-verifying.
    if (download.status === 'failed' && download.errorCode === 'CHECKSUM_MISMATCH') {
      await this.discardPoisonedDownload(id)
    }
    const updated = this.patch(id, { status: 'queued', errorCode: null, errorMessage: null })
    this.enqueue(id)
    this.pumpQueue()
    return updated
  }

  /**
   * Replaces an expired direct-download URL. Existing bytes survive only when
   * the server reports the same size and strong ETag and supports ranges.
   */
  async refreshDownloadUrl(id: DownloadId, rawUrl: string): Promise<RefreshDownloadUrlResult> {
    const download = this.requireDownload(id)
    if (isTorrentSource(download.url)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Torrent downloads must be retried from their original magnet link',
        retryable: false
      })
    }
    if (download.status !== 'failed' && download.status !== 'paused') {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'A download link can only be replaced while the download is paused or failed',
        retryable: false
      })
    }
    if (
      this.repos.mediaResolutions.get(id) !== null ||
      this.repos.audioTranscodes.has(id) ||
      this.repos.videoMerges.get(id) !== null
    ) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Media-page downloads refresh from their source page using Retry',
        retryable: false
      })
    }

    let nextUrl: URL
    try {
      nextUrl = new URL(rawUrl)
    } catch {
      throw new EngineError({ code: 'PRECONDITION_FAILED', message: 'Replacement URL is invalid', retryable: false })
    }
    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Replacement URL must use http or https',
        retryable: false
      })
    }
    nextUrl.hash = ''

    const headers = { ...download.headers }
    let sameOrigin = false
    try {
      sameOrigin = new URL(download.url).origin === nextUrl.origin
    } catch {
      // Treat malformed stored URLs as cross-origin and drop credentials.
    }
    if (!sameOrigin) {
      for (const name of Object.keys(headers)) {
        if (/^(authorization|cookie|proxy-authorization|referer|origin)$/i.test(name)) {
          delete headers[name]
        }
      }
    }

    const metadata = await withRetry(() => probe(nextUrl.toString(), { headers }), {
      maxAttempts: 2,
      baseDelayMs: 400,
      onRetry: (err, attempt, delay) =>
        log.warn('Replacement URL probe failed, retrying', { id, attempt, delay, error: err.message })
    })

    const oldTag = download.etag?.trim() ?? ''
    const newTag = metadata.etag?.trim() ?? ''
    const keptProgress =
      download.fileSize > 0 &&
      metadata.size === download.fileSize &&
      metadata.acceptRanges &&
      isStrongETag(oldTag) &&
      isStrongETag(newTag) &&
      oldTag === newTag

    if (!keptProgress) {
      await deleteFile(download.tempPath)
      this.repos.chunks.invalidateAll(id)
    }

    this.patch(id, {
      url: nextUrl.toString(),
      finalUrl: metadata.finalUrl,
      fileSize: metadata.size ?? 0,
      acceptRanges: metadata.acceptRanges,
      etag: metadata.etag,
      lastModified: metadata.lastModified,
      contentType: metadata.contentType,
      headers,
      downloadedBytes: keptProgress ? download.downloadedBytes : 0,
      computedChecksum: keptProgress ? download.computedChecksum : null,
      status: 'paused',
      retryCount: 0,
      errorCode: null,
      errorMessage: null
    })

    const updated = this.retry(id)
    return { download: updated, keptProgress }
  }

  /** Pauses a download, keeping its partial file for a later resume. */
  pause(id: DownloadId): Download {
    const task = this.tasks.get(id)
    if (task) {
      task.pause()
      // The task's own cleanup flips the persisted status.
      return this.requireDownload(id)
    }
    const download = this.requireDownload(id)
    if (download.status === 'completed' || download.status === 'canceled') return download
    return this.patch(id, { status: 'paused' })
  }

  /** Cancels a download and deletes its partial file. */
  async cancel(id: DownloadId): Promise<Download> {
    const task = this.tasks.get(id)
    task?.cancel()
    this.removeFromQueue(id)
    this.rateLimiter.remove(id)
    this.speeds.remove(id)

    await this.taskRuns.get(id)
    this.removeFromQueue(id)
    const download = this.requireDownload(id)
    if (task && isTorrentSource(download.url) && download.status === 'failed') return download
    this.repos.mediaResolutions.remove(id)
    this.repos.audioTranscodes.remove(id)
    await this.deletePartialFiles(download)
    return this.patch(id, { status: 'canceled' })
  }

  /** Clears the error and re-queues a failed download from scratch or resume. */
  retry(id: DownloadId): Download {
    const download = this.requireDownload(id)
    if (download.status === 'completed') return download
    const mediaResolution = this.repos.mediaResolutions.get(id)
    if (mediaResolution && !mediaResolution.resolved) {
      const updated = this.patch(id, {
        status: 'connecting',
        retryCount: 0,
        errorCode: null,
        errorMessage: null
      })
      const request: AddDownloadRequest = {
        url: mediaResolution.sourcePageUrl || download.url,
        format: mediaResolution.format,
        videoQuality: mediaResolution.videoQuality,
        audioFormat: mediaResolution.audioFormat,
        subtitleLanguages: mediaResolution.subtitleLanguages,
        ...(mediaResolution.namingTemplate ? { namingTemplate: mediaResolution.namingTemplate } : {}),
        embedMetadata: mediaResolution.embedMetadata,
        headers: download.headers,
        ...(mediaResolution.requestedFilename ? { filename: mediaResolution.requestedFilename } : {}),
        ...(mediaResolution.requestedDestination ? { destination: mediaResolution.requestedDestination } : {}),
        ...(download.category !== 'other' ? { category: download.category } : {}),
        ...(download.expectedChecksum ? { expectedChecksum: download.expectedChecksum.value } : {}),
        speedLimit: download.speedLimit,
        scheduledStartAt: download.scheduledStartAt,
        ...(download.connections !== null ? { connections: download.connections } : {})
      }
      void this.prepareMediaPage(id, request)
      return updated
    }
    if (mediaResolution?.resolved && download.status === 'failed') {
      const failedInPostProcessing =
        download.errorMessage?.startsWith('Grabbed but could not convert to MP3:') ||
        download.errorMessage?.startsWith('Downloaded video track but could not merge audio:')
      if (failedInPostProcessing && (this.repos.audioTranscodes.has(id) || this.repos.videoMerges.get(id))) {
        // Required post-processing can be retried against the already-fetched
        // bytes; refreshing here would needlessly redownload the media.
      } else {
        const updated = this.patch(id, { status: 'connecting', errorCode: null, errorMessage: null })
        void this.refreshMediaPage(id, mediaResolution, download)
        return updated
      }
    }

    // Explicit user retry on a checksum failure starts from zero: the corrupt
    // bytes are gone (or going — delete is best-effort here) and the chunk
    // map is reset, so the run re-downloads cleanly. See discardPoisonedDownload
    // for why deletion is the correct disposition.
    // The delete is awaited before enqueueing: firing it off while the new
    // task opens the same path could otherwise let the rm land second and
    // wipe the fresh partial on Windows.
    const poisoned = download.errorCode === 'CHECKSUM_MISMATCH'
    if (poisoned) {
      this.repos.chunks.invalidateAll(id)
      this.repos.downloads.update(id, { downloadedBytes: 0 })
    }
    const updated = this.patch(id, {
      status: 'queued',
      retryCount: 0,
      errorCode: null,
      errorMessage: null
    })
    if (poisoned && download.tempPath) {
      const tempPath = download.tempPath
      void deleteFile(tempPath)
        .catch((err: unknown) => {
          log.warn('Could not delete poisoned partial on retry', { id, error: err })
        })
        .finally(() => {
          this.enqueue(id)
          this.pumpQueue()
        })
    } else {
      this.enqueue(id)
      this.pumpQueue()
    }
    return updated
  }

  /** Removes the record entirely, optionally deleting files. */
  async remove(id: DownloadId, deleteFiles: boolean): Promise<void> {
    this.tasks.get(id)?.cancel()
    this.removeFromQueue(id)
    this.rateLimiter.remove(id)
    this.speeds.remove(id)

    await this.taskRuns.get(id)
    this.repos.mediaResolutions.remove(id)
    const download = this.repos.downloads.get(id)
    if (download) {
      await this.deletePartialFiles(download)
      if (isTorrentSource(download.url)) await this.deleteTorrentMetainfoFile(download)
      if (deleteFiles && download.finalPath) {
        if (isTorrentSource(download.url)) await this.deleteTorrentDirectory(download, download.finalPath)
        else await deleteFile(download.finalPath)
      }
    }
    this.repos.downloads.remove(id)
    this.emit('removed', { ids: [id] })
  }

  pauseAll(): void {
    for (const id of this.tasks.keys()) this.pause(id)
    for (const download of this.repos.downloads.list()) {
      if (
        download.status === 'queued' ||
        download.status === 'scheduled' ||
        this.repos.mediaResolutions.get(download.id) !== null
      ) {
        this.patch(download.id, { status: 'paused' })
      }
    }
    this.queue.length = 0
  }

  resumeAll(): void {
    for (const download of this.repos.downloads.list()) {
      if (download.status === 'paused' || download.status === 'failed') {
        void this.resume(download.id)
      }
    }
    this.pumpQueue()
  }

  clearCompleted(): DownloadId[] {
    const completed = this.repos.downloads.listByStatus(['completed'])
    for (const download of completed) {
      this.repos.downloads.remove(download.id)
    }
    if (completed.length > 0) {
      this.emit('removed', { ids: completed.map((d) => d.id) })
    }
    return completed.map((d) => d.id)
  }

  setPriority(id: DownloadId, priority: number): Download {
    const updated = this.patch(id, { priority })
    this.sortQueue()
    this.pumpQueue()
    return updated
  }

  /**
   * Sets or clears a per-download throttle.
   * Applied to the live limiter as well as the record, so the change applies
   * mid-transfer rather than only on the next resume.
   */
  async setSpeedLimit(id: DownloadId, bytesPerSecond: number | null): Promise<Download> {
    const download = this.requireDownload(id)
    if (isTorrentSource(download.url)) {
      const limit = transmissionLimit(bytesPerSecond, 'download')
      if (this.tasks.has(id)) {
        const client = await this.getTransmissionManager().start()
        const torrent = await this.findTransmissionTorrent(client, download)
        await client.call('torrent-set', {
          ids: [torrent.id],
          downloadLimited: limit.limited,
          downloadLimit: limit.kilobytesPerSecond
        })
      }
      return this.patch(id, { speedLimit: limit.bytesPerSecond })
    }
    this.rateLimiter.setPerDownload(id, bytesPerSecond)
    return this.patch(id, { speedLimit: bytesPerSecond })
  }

  async setUploadSpeedLimit(id: DownloadId, bytesPerSecond: number | null): Promise<Download> {
    const download = this.requireDownload(id)
    if (!isTorrentSource(download.url)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Upload speed limits are only available for torrents',
        retryable: false
      })
    }
    const limit = transmissionLimit(bytesPerSecond, 'upload')
    if (this.tasks.has(id)) {
      const client = await this.getTransmissionManager().start()
      const torrent = await this.findTransmissionTorrent(client, download)
      await client.call('torrent-set', {
        ids: [torrent.id],
        uploadLimited: limit.limited,
        uploadLimit: limit.kilobytesPerSecond
      })
    }
    return this.patch(id, { uploadSpeedLimit: limit.bytesPerSecond })
  }

  async getTorrentFiles(id: DownloadId): Promise<ReturnType<typeof parseTransmissionFiles> | null> {
    const download = this.requireDownload(id)
    if (!isTorrentSource(download.url)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'This download is not a torrent',
        retryable: false
      })
    }
    if (!this.tasks.has(id)) return null
    const client = await this.getTransmissionManager().start()
    const torrent = await this.findTransmissionTorrent(client, download)
    const files = parseTransmissionFiles(await client.call('torrent-get', {
      ids: [torrent.id],
      fields: ['files', 'fileStats']
    }))
    return files.length > 0 ? files : null
  }

  async setTorrentFiles(id: DownloadId, indexes: number[]): Promise<Download> {
    const download = this.requireDownload(id)
    if (!isTorrentSource(download.url)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'This download is not a torrent',
        retryable: false
      })
    }
    if (this.tasks.has(id)) {
      const client = await this.getTransmissionManager().start()
      const torrent = await this.findTransmissionTorrent(client, download)
      await this.applyTorrentFileSelection(client, torrent.id, indexes)
    }
    return this.patch(id, { torrentFiles: [...indexes] })
  }

  async setDownloadQuota(id: DownloadId, quotaBytes: number | null): Promise<Download> {
    const download = this.requireDownload(id)
    if (isTorrentSource(download.url)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Download quotas are not supported for torrents yet',
        retryable: false
      })
    }
    if (isYouTubePage(download.url)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Download quotas are not supported for yt-dlp media transfers',
        retryable: false
      })
    }

    const shouldResume = this.tasks.has(id) &&
      ['queued', 'connecting', 'downloading'].includes(download.status)
    const taskRun = shouldResume ? this.taskRuns.get(id) : undefined
    if (shouldResume) this.pause(id)
    if (taskRun) await taskRun

    const current = this.requireDownload(id)
    const quotaReached = current.status !== 'completed' &&
      current.status !== 'canceled' &&
      current.status !== 'failed' &&
      quotaBytes !== null &&
      current.fileSize > 0 &&
      quotaBytes < current.fileSize &&
      current.downloadedBytes >= quotaBytes
    const updated = this.patch(id, {
      quotaBytes,
      ...(quotaReached
        ? {
            status: 'paused',
            errorCode: 'PAUSED',
            errorMessage: 'Download quota reached. Increase or clear the quota to continue.'
          }
        : {})
    })
    if (shouldResume && updated.status === 'paused' && !quotaReached) await this.resume(id)
    return this.requireDownload(id)
  }

  /** Reorders the queue from a renderer drag-and-drop. */
  reorder(orderedIds: DownloadId[]): void {
    this.repos.downloads.applyOrder(orderedIds)
    this.queue.length = 0
    this.queue.push(...orderedIds)
    this.sortQueue()
    this.pumpQueue()
  }

  setStatus(id: DownloadId, status: DownloadStatus): Download {
    return this.patch(id, { status })
  }

  /** Re-runs the disk reconciliation for one download (or all of them). */
  async rescan(id?: DownloadId): Promise<{
    repaired: DownloadId[]
    invalidated: DownloadId[]
    failed: DownloadId[]
    details: DiskRescanDetail[]
    durationMs: number
  }> {
    const startedAt = Date.now()
    const repaired: DownloadId[] = []
    const invalidated: DownloadId[] = []
    const failed: DownloadId[] = []
    const details: DiskRescanDetail[] = []

    const targets = id
      ? [this.requireDownload(id)]
      : this.repos.downloads.list().filter((d) => d.status !== 'completed' && d.status !== 'canceled')

    for (const download of targets) {
      if (download.status === 'downloading' || download.status === 'connecting') {
        details.push({
          id: download.id,
          action: 'skipped',
          bytesKept: download.downloadedBytes,
          chunksKept: 0,
          chunksReset: 0,
          note: 'Pause this active download before rescanning its files'
        })
        continue
      }
      try {
        const report = await verifyAgainstDisk(this.repos, download.id)
        for (const detail of report.details) {
          details.push(detail)
          if (detail.action === 'repaired' || detail.action === 'replanned') repaired.push(detail.id)
          if (detail.action === 'reset') invalidated.push(detail.id)
          if (detail.action === 'skipped') failed.push(detail.id)
        }
      } catch (error) {
        const message = sanitizeLogText(error instanceof Error ? error.message : String(error))
        log.error('Manual disk rescan failed for download', { id: download.id, error })
        failed.push(download.id)
        details.push({
          id: download.id,
          action: 'skipped',
          bytesKept: download.downloadedBytes,
          chunksKept: 0,
          chunksReset: 0,
          note: `Rescan failed without changing files: ${message}`
        })
      }
      const refreshed = this.repos.downloads.get(download.id)
      if (refreshed) this.emit('upserted', refreshed)
    }

    return { repaired, invalidated, failed, details, durationMs: Date.now() - startedAt }
  }

  /** Changes the global cap; takes effect immediately. */
  setGlobalSpeedLimit(bytesPerSecond: number | null): void {
    this.rateLimiter.setGlobalRate(bytesPerSecond ?? 0)
  }

  listQueuePlans(): QueuePlan[] {
    return this.repos.queuePlans.list()
  }

  createQueuePlan(request: CreateQueuePlanRequest): QueuePlan[] {
    const start = request.startsAt
    const end = start + request.durationMinutes * 60_000
    if (!Number.isSafeInteger(end)) {
      throw new EngineError({ code: 'PRECONDITION_FAILED', message: 'Plan end time is out of range', retryable: false })
    }
    const existingPlans = this.repos.queuePlans.list()
    for (const id of request.downloadIds) {
      const download = this.repos.downloads.get(id)
      if (!download) {
        throw new EngineError({ code: 'PRECONDITION_FAILED', message: 'A selected download no longer exists', retryable: false })
      }
      if (download.status !== 'queued' && download.status !== 'paused') {
        throw new EngineError({
          code: 'PRECONDITION_FAILED',
          message: `${download.filename} must be queued or paused to add it to a plan`,
          retryable: false
        })
      }
      if (existingPlans.some((plan) =>
        (plan.status === 'scheduled' || plan.status === 'running') && plan.downloadIds.includes(id)
      )) {
        throw new EngineError({
          code: 'PRECONDITION_FAILED',
          message: `${download.filename} is already reserved by another plan`,
          retryable: false
        })
      }
    }
    for (const plan of existingPlans) {
      if (plan.status !== 'scheduled' && plan.status !== 'running') continue
      const otherStart = plan.startsAt
      const otherEnd = otherStart + plan.durationMinutes * 60_000
      if (start < otherEnd && otherStart < end) {
        throw new EngineError({
          code: 'PRECONDITION_FAILED',
          message: `This plan overlaps "${plan.name}". Choose a non-overlapping time window.`,
          retryable: false
        })
      }
    }

    const plan: QueuePlan = {
      ...request,
      id: newId(),
      status: 'scheduled',
      createdAt: Date.now(),
      endedAt: null
    }
    this.repos.queuePlans.insert(plan)
    this.sortQueue()
    this.emitQueuePlansChanged()
    this.pumpQueue()
    return this.listQueuePlans()
  }

  cancelQueuePlan(id: string): QueuePlan[] {
    const plan = this.requireQueuePlan(id)
    if (plan.status === 'scheduled' || plan.status === 'running') {
      this.repos.queuePlans.updateStatus(id, 'canceled', Date.now())
      this.sortQueue()
      this.emitQueuePlansChanged()
      this.pumpQueue()
    }
    return this.listQueuePlans()
  }

  removeQueuePlan(id: string): QueuePlan[] {
    const plan = this.requireQueuePlan(id)
    if (plan.status === 'scheduled' || plan.status === 'running') {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Cancel a scheduled or running plan before removing it',
        retryable: false
      })
    }
    this.repos.queuePlans.remove(id)
    this.emitQueuePlansChanged()
    return this.listQueuePlans()
  }

  private requireQueuePlan(id: string): QueuePlan {
    const plan = this.repos.queuePlans.get(id)
    if (!plan) {
      throw new EngineError({ code: 'PRECONDITION_FAILED', message: 'Queue plan not found', retryable: false })
    }
    return plan
  }

  private emitQueuePlansChanged(): void {
    this.emit('queuePlansChanged', this.listQueuePlans())
  }

  private restoreRunningQueuePlans(): void {
    for (const plan of this.repos.queuePlans.list()) {
      if (plan.status !== 'running') continue
      for (const id of plan.downloadIds) {
        const download = this.repos.downloads.get(id)
        if (download?.status === 'paused') {
          // Recovery pauses interrupted tasks; an active persisted plan owns those selected items.
          this.patch(id, { status: 'queued', errorCode: null, errorMessage: null })
        }
      }
    }
  }

  private finishQueuePlan(plan: QueuePlan, pauseRemaining: boolean): void {
    if (pauseRemaining) {
      for (const id of plan.downloadIds) {
        const download = this.repos.downloads.get(id)
        if (!download || ['completed', 'failed', 'canceled'].includes(download.status)) continue
        if (download.status === 'downloading' || download.status === 'connecting') {
          this.pause(id)
        } else if (download.status === 'queued') {
          this.removeFromQueue(id)
          this.patch(id, { status: 'paused' })
        }
      }
    }
    this.repos.queuePlans.updateStatus(plan.id, 'completed', Date.now())
    this.sortQueue()
    this.emitQueuePlansChanged()
    this.pumpQueue()
  }

  // --- scheduling ----------------------------------------------------------

  private enqueue(id: DownloadId): void {
    if (!this.queue.includes(id)) this.queue.push(id)
    this.sortQueue()
  }

  private removeFromQueue(id: DownloadId): void {
    const index = this.queue.indexOf(id)
    if (index !== -1) this.queue.splice(index, 1)
  }

  /** Orders the queue by priority, then by age. */
  private sortQueue(): void {
    const activePlan = this.repos.queuePlans.list().find((plan) => plan.status === 'running')
    const activeIds = new Set(activePlan?.downloadIds ?? [])
    const activeOrder = new Map(
      (activePlan?.downloadIds ?? []).map((id, index) => [id, index])
    )
    this.queue.sort((a, b) => {
      const left = this.repos.downloads.get(a)
      const right = this.repos.downloads.get(b)
      if (!left || !right) return 0
      if (activeIds.has(a) !== activeIds.has(b)) return activeIds.has(a) ? -1 : 1
      if (activeIds.has(a) && activeIds.has(b) && activePlan?.strategy === 'smallest-first') {
        const leftSize = left.fileSize > 0 ? left.fileSize : Number.MAX_SAFE_INTEGER
        const rightSize = right.fileSize > 0 ? right.fileSize : Number.MAX_SAFE_INTEGER
        if (leftSize !== rightSize) return leftSize - rightSize
      }
      if (left.priority !== right.priority) return left.priority - right.priority
      if (activeIds.has(a) && activeIds.has(b)) {
        return (activeOrder.get(a) ?? 0) - (activeOrder.get(b) ?? 0)
      }
      return left.createdAt - right.createdAt
    })
  }

  /**
   * Starts as many queued downloads as the concurrency limit allows.
   * Re-entrancy is guarded because `pumpQueue` is called from many places.
   */
  private pumping = false

  private pumpQueue(): void {
    if (this.pumping || this.shuttingDown) return
    this.pumping = true
    try {
      const limit = this.settings.get().maxConcurrentDownloads
      while (this.tasks.size < limit) {
        const plans = this.repos.queuePlans.list()
        const reservedIds = new Set(
          plans
            .filter((plan) => plan.status === 'scheduled')
            .flatMap((plan) => plan.downloadIds)
        )
        const next = this.queue.find((id) => !this.tasks.has(id) && !reservedIds.has(id))
        if (!next) break
        const download = this.repos.downloads.get(next)
        if (!download) {
          this.removeFromQueue(next)
          continue
        }
        if (download.status === 'scheduled') break
        this.removeFromQueue(next)
        this.startTask(download)
      }
    } finally {
      this.pumping = false
    }
  }

  /** Spawns a task and wires its events. */
  private startTask(download: Download): void {
    const context = {
      repos: this.repos,
      rateLimiter: this.rateLimiter,
      settings: this.settings,
      beforeFinalize: (id: DownloadId, partialPath: string) => this.beforeDownloadFinalized(id, partialPath),
      onCompleted: (id: DownloadId, finalPath: string) => this.onDownloadCompleted(id, finalPath),
      emit: (event: TaskEvent) => this.onTaskEvent(event)
    }
    const pending = this.repos.mediaResolutions.get(download.id)
    if (isTorrentSource(download.url)) {
      const task = new TorrentDownloadTask({
        id: download.id,
        download,
        manager: this.getTransmissionManager(),
        repos: this.repos,
        emit: context.emit
      })
      this.launchTask(download, task)
      return
    }
    if (pending?.resolved && isYouTubePage(pending.sourcePageUrl)) {
      const task = new YtDlpDownloadTask(context, download, pending, async () => {
        const settings = this.settings.get()
        if (isVideoResolverStubbed()) {
          return { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', ytDlpVersion: settings.ytDlpVersion }
        }
        const userDataDir = getVideoCaptureUserDataDir()
        if (!userDataDir) {
          throw new EngineError({
            code: 'INTERNAL',
            message: 'Media capture is not ready yet — restart the app and try again',
            retryable: false
          })
        }
        const helpers = await ensureHelpers({
          userDataDir,
          ...(settings.helperDir !== '' ? { helperDir: settings.helperDir } : {}),
          ytDlpVersion: settings.ytDlpVersion,
          ffmpegVersion: settings.ffmpegVersion
        })
        return {
          ytDlpPath: helpers.ytDlpPath,
          ffmpegPath: helpers.ffmpegPath,
          ytDlpVersion: settings.ytDlpVersion
        }
      })
      this.launchTask(download, task)
      return
    }
    const task = new DownloadTask(context, download)
    this.launchTask(download, task)
  }

  private getTransmissionManager(): TransmissionManager {
    if (this.transmission) return this.transmission
    const settings = this.settings.get()
    this.transmission = new TransmissionManager({
      executablePath: getBundledTransmissionExecutable(this.resourcesDir) ?? '',
      configDirectory: resolve(
        this.userDataDir || settings.downloadDirectory,
        '.moth',
        'transmission'
      ),
      downloadDirectory: settings.downloadDirectory
    })
    return this.transmission
  }

  private async findTransmissionTorrent(
    client: TransmissionRpc,
    download: Download
  ): Promise<TransmissionTorrent> {
    const magnet = parseMagnetUri(download.url)
    if (!magnet && !isTorrentSource(download.url)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'This download does not have a supported torrent identity',
        retryable: false
      })
    }
    const hashes = magnet
      ? [magnet.v1InfoHash, magnet.v2InfoHash]
      .filter((hash): hash is string => hash !== null)
      : []
    const torrents = parseTransmissionTorrents(await client.call('torrent-get', {
      fields: [
        'id', 'hashString', 'name', 'status', 'percentDone', 'totalSize', 'sizeWhenDone', 'haveValid',
        'rateDownload', 'leftUntilDone', 'downloadDir', 'peersConnected', 'isFinished'
      ]
    }))
    const torrent = torrents.find((item) => hashes.includes(item.hashString.toLowerCase())) ??
      (!magnet
        ? torrents.find((item) => resolve(item.downloadDir) === resolve(download.tempPath))
        : undefined)
    if (!torrent) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Transmission no longer has this torrent; retry it from its original source',
        retryable: false
      })
    }
    if (resolve(torrent.downloadDir) !== resolve(download.tempPath)) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'This torrent is already active in a different Moth download',
        retryable: false
      })
    }
    return torrent
  }

  private async applyTorrentFileSelection(
    client: TransmissionRpc,
    torrentId: number,
    selectedIndexes: number[]
  ): Promise<void> {
    const files = parseTransmissionFiles(await client.call('torrent-get', {
      ids: [torrentId],
      fields: ['files', 'fileStats']
    }))
    if (files.length === 0) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Torrent metadata is not available yet; wait for the file list before selecting files',
        retryable: true
      })
    }
    if (
      selectedIndexes.length === 0 ||
      new Set(selectedIndexes).size !== selectedIndexes.length ||
      selectedIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= files.length)
    ) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Select at least one valid file from this torrent',
        retryable: false
      })
    }
    const selected = new Set(selectedIndexes)
    await client.call('torrent-set', {
      ids: [torrentId],
      'files-wanted': selectedIndexes,
      'files-unwanted': files.filter((file) => !selected.has(file.index)).map((file) => file.index)
    })
  }

  private launchTask(
    download: Download,
    task: Pick<DownloadTask, 'run' | 'pause' | 'cancel' | 'destroy'>
  ): void {
    this.tasks.set(download.id, task)

    const run = task
      .run()
      .then(() => {
        this.speeds.remove(download.id)
        this.rateLimiter.remove(download.id)
      })
      .catch(async (err: unknown) => {
        await this.onTaskError(download.id, err).catch((fatal: unknown) => {
          log.error('Failed to record task error', { id: download.id, error: fatal })
        })
      })
      .finally(() => {
        if (this.taskRuns.get(download.id) === run) this.taskRuns.delete(download.id)
        if (this.tasks.get(download.id) === task) this.tasks.delete(download.id)
        this.pumpQueue()
      })
    this.taskRuns.set(download.id, run)
  }

  private onTaskEvent(event: TaskEvent): void {
    switch (event.type) {
      case 'progress': {
        const progress = event.progress
        this.speeds.update(progress.id, progress.downloadedBytes)
        // Session total is accumulated from deltas, so a resumed download
        // does not re-count bytes that were already on disk.
        const previous = this.lastProgressBytes.get(progress.id) ?? 0
        if (progress.downloadedBytes > previous) {
          this.sessionBytes += progress.downloadedBytes - previous
          this.lastProgressBytes.set(progress.id, progress.downloadedBytes)
        }
        this.emit('progress', progress)
        // Keep the persisted byte counter fresh for recovery after a crash.
        if (!this.db.isClosed) {
          this.repos.downloads.update(progress.id, { downloadedBytes: progress.downloadedBytes })
        }
        break
      }
      case 'status': {
        const download = this.repos.downloads.get(event.id)
        if (download) this.emit('upserted', download)
        break
      }
      case 'finished': {
        const download = this.repos.downloads.get(event.id)
        if (download) this.emit('upserted', download)
        this.emit('finished', {
          id: event.id,
          filename: download?.filename ?? '',
          finalPath: event.finalPath,
          size: event.size,
          durationMs: event.durationMs,
          averageSpeed: event.averageSpeed,
          checksum: event.checksum
        })
        break
      }
      case 'failed': {
        this.emit('failed', {
          id: event.id,
          code: event.error.code,
          message: event.error.message,
          retryable: event.error.retryable
        })
        break
      }
      case 'removed': {
        this.emit('removed', { ids: [event.id] })
        break
      }
    }
  }

  /**
   * Converts a finished audio grab to MP3, then resolves metadata.
   *
   * A transcode failure fails that download with a clear message, never the
   * app. The grabbed bytes stay on disk under the failed record.
   */
  private async beforeDownloadFinalized(id: DownloadId, partialPath: string): Promise<boolean> {
    const pendingMerge = this.repos.videoMerges.get(id)
    if (pendingMerge !== null) {
      const merged = await this.mergeGrab(id, partialPath, pendingMerge)
      if (!merged) return false
      this.repos.videoMerges.remove(id)
    }

    if (this.repos.audioTranscodes.has(id)) {
      const converted = await this.transcodeGrab(id, partialPath)
      if (!converted) return false
      this.repos.audioTranscodes.remove(id)
    }
    return true
  }

  private async onDownloadCompleted(id: DownloadId, finalPath: string): Promise<void> {
    const pending = this.repos.mediaResolutions.get(id)
    const embedMetadata = pending?.embedMetadata ?? true
    if (pending) {
      const pageUrl = normalizedPageUrl(pending.sourcePageUrl)
      const sourceKey = pending.mediaId ?? `page:${pageUrl}`
      this.repos.mediaHistory.record({
        sourceKey,
        sourcePageUrl: pageUrl,
        title: pending.mediaTitle ?? this.requireDownload(id).filename.replace(/\.[^.]+$/, ''),
        filename: this.requireDownload(id).filename,
        completedAt: Date.now()
      })
      this.repos.mediaResolutions.remove(id)
    }
    if (!this.media) return
    try {
      await this.pendingPageArtwork.get(id)
      await this.media.resolveAfterDownload(id, finalPath, this.pendingMediaHints.get(id), {
        writeTags: embedMetadata,
        fetchArtwork: embedMetadata
      })
      this.pendingMediaHints.delete(id)
      const current = this.repos.downloads.get(id)
      if (current) this.emit('upserted', current)
    } catch (err) {
      log.warn('Metadata resolution failed; download is unaffected', { id, error: err })
    }
  }

  private async recoverPendingVideoMerges(): Promise<void> {
    for (const merge of this.repos.videoMerges.list()) {
      const download = this.repos.downloads.get(merge.downloadId)
      if (!download || download.status !== 'completed' || !download.finalPath) continue
      log.info('Resuming a pending video audio merge after restart', { id: merge.downloadId })
      const merged = await this.mergeGrab(merge.downloadId, download.finalPath, merge)
      if (merged) this.repos.videoMerges.remove(merge.downloadId)
    }
  }

  /** Muxes a resolved separate audio track into the downloaded video file. */
  private async mergeGrab(
    id: DownloadId,
    mediaPath: string,
    pending: { audioUrl: string; container: 'mp4' | 'webm' | 'mkv'; headers: Record<string, string> }
  ): Promise<boolean> {
    try {
      const userDataDir = getVideoCaptureUserDataDir()
      if (!userDataDir) {
        throw new EngineError({
          code: 'INTERNAL',
          message: 'Media capture is not ready yet — restart the app and try again',
          retryable: false
        })
      }
      const settings = this.settings.get()
      const helpers = await ensureFfmpegHelper({
        userDataDir,
        ...(settings.helperDir !== '' ? { helperDir: settings.helperDir } : {}),
        ytDlpVersion: settings.ytDlpVersion,
        ffmpegVersion: settings.ffmpegVersion
      })
      await muxAudioIntoVideo(mediaPath, mediaPath, {
        ffmpegPath: helpers.ffmpegPath,
        audioUrl: pending.audioUrl,
        container: pending.container,
        headers: pending.headers
      })
      return true
    } catch (err) {
      const error = toEngineError(err)
      const message = `Downloaded video track but could not merge audio: ${error.message}`
      log.warn('Audio merge failed; preserving the downloaded video track', { id, code: error.code })
      try {
        this.patch(id, { status: 'failed', errorCode: error.code, errorMessage: message })
      } catch (patchErr) {
        log.warn('Could not record the audio merge failure', { id, error: patchErr })
        return false
      }
      emitActivity(this.repos, id, 'error', `Failed: ${message}`)
      this.emit('failed', { id, code: error.code, message, retryable: false })
      return false
    }
  }

  /** Single-pass MP3 conversion for one finished grab. Returns `false` on failure. */
  private async transcodeGrab(id: DownloadId, mediaPath: string): Promise<boolean> {
    try {
      const userDataDir = getVideoCaptureUserDataDir()
      if (!userDataDir) {
        throw new EngineError({
          code: 'INTERNAL',
          message: 'Media capture is not ready yet — restart the app and try again',
          retryable: false
        })
      }
      const settings = this.settings.get()
      const helpers = await ensureFfmpegHelper({
        userDataDir,
        ...(settings.helperDir !== '' ? { helperDir: settings.helperDir } : {}),
        ytDlpVersion: settings.ytDlpVersion,
        ffmpegVersion: settings.ffmpegVersion
      })
      await transcodeToMp3(mediaPath, mediaPath, { ffmpegPath: helpers.ffmpegPath })
      return true
    } catch (err) {
      const error = toEngineError(err)
      const message = `Grabbed but could not convert to MP3: ${error.message}`
      log.warn('Transcode failed; marking the download failed', { id, code: error.code })
      try {
        this.patch(id, { status: 'failed', errorCode: error.code, errorMessage: message })
      } catch (patchErr) {
        log.warn('Could not record the transcode failure', { id, error: patchErr })
        return false
      }
      emitActivity(this.repos, id, 'error', `Failed: ${message}`)
      this.emit('failed', { id, code: error.code, message, retryable: false })
      return false
    }
  }

  /**
   * Discards a checksum-poisoned download so an explicit user retry starts
   * clean instead of re-verifying the same bad bytes forever.
   *
   * Disposition is deliberately DELETE, not keep: the bytes are re-fetchable
   * from the network, while a corrupt multi-GB file left next to good ones
   * wastes disk and invites the user to keep a bad file. Safe to delete here
   * because `DownloadTask.run()` always closes the writer in its `finally`
   * before this handler runs — no open handle, no Windows delete lock.
   */
  private async discardPoisonedDownload(id: DownloadId): Promise<void> {
    const download = this.repos.downloads.get(id)
    if (!download) return
    this.repos.chunks.invalidateAll(id)
    this.repos.downloads.update(id, { downloadedBytes: 0 })
    if (download.tempPath) {
      try {
        await deleteFile(download.tempPath)
      } catch (err) {
        log.warn('Could not delete poisoned partial after checksum mismatch', {
          id,
          path: download.tempPath,
          error: err
        })
      }
    }
    emitActivity(
      this.repos,
      id,
      'warn',
      'Checksum verification failed; the corrupt file was deleted and progress reset — retry to download a fresh copy'
    )
  }

  /** Applies the retry policy and final failure handling for a task. */
  private async onTaskError(id: DownloadId, err: unknown): Promise<void> {
    this.speeds.remove(id)
    this.rateLimiter.remove(id)

    // A task can fail while the app is tearing down, after the database has
    // already been closed. Persisting then would throw inside a rejection
    // handler, which is exactly how an app ends up with an unhandled rejection.
    if (this.shuttingDown || this.db.isClosed) {
      log.debug('Ignoring task error during shutdown', { id })
      return
    }
    if (isCanceled(err) || this.shuttingDown) {
      const download = this.repos.downloads.get(id)
      if (download && (download.status === 'connecting' || download.status === 'downloading')) {
        this.patch(id, { status: 'paused' })
      }
      return
    }

    const error = toEngineError(err)
    const download = this.repos.downloads.get(id)
    const maxRetries = download?.maxRetries ?? 5
    const retryCount = (download?.retryCount ?? 0) + 1

    if (error.retryable && retryCount <= maxRetries) {
      log.warn('Retrying download after failure', {
        id,
        url: download?.url,
        filename: download?.filename,
        attempt: retryCount,
        maxRetries,
        code: error.code,
        error
      })
      this.patch(id, { status: 'queued', retryCount, errorCode: error.code, errorMessage: error.message })
      emitActivity(
        this.repos,
        id,
        'warn',
        `Attempt ${retryCount} of ${maxRetries} failed (${error.code}); retrying`
      )
      this.enqueue(id)
      return
    }

    log.error('Download failed permanently', {
      id,
      url: download?.url,
      filename: download?.filename,
      code: error.code,
      error
    })
    // A checksum mismatch leaves poisoned bytes on disk under a fully-complete
    // chunk map; without intervention every manual retry would re-verify the
    // same bytes and fail identically forever. Discard now so an explicit
    // user retry re-downloads cleanly. The failure itself stays terminal for
    // automatic retries (CHECKSUM_MISMATCH is non-retryable above).
    if (error.code === 'CHECKSUM_MISMATCH') {
      await this.discardPoisonedDownload(id)
    }
    this.patch(id, {
      status: 'failed',
      retryCount,
      errorCode: error.code,
      errorMessage: error.message
    })
    emitActivity(this.repos, id, 'error', `Failed: ${error.message}`)
    this.emit('failed', {
      id,
      code: error.code,
      message: error.message,
      retryable: false
    })
  }

  // --- background loops ----------------------------------------------------

  /**
   * Checks for scheduled downloads whose time has come.
   * A dedicated timer (rather than piggy-backing on telemetry) keeps start
   * times accurate even when no transfers are active.
   */
  private startScheduler(): void {
    const tick = (): void => {
      if (this.shuttingDown) return
      const now = Date.now()
      this.tickQueuePlans(now)
      const due = this.repos.downloads
        .listByStatus(['scheduled'])
        .filter((download) => download.scheduledStartAt !== null && download.scheduledStartAt <= now)

      for (const download of due) {
        log.info('Scheduled download starting', { id: download.id, at: download.scheduledStartAt })
        emitActivity(this.repos, download.id, 'info', 'Scheduled start time reached')
        this.patch(download.id, { status: 'queued', scheduledStartAt: null })
        this.emit('scheduled', { id: download.id, at: now })
        this.enqueue(download.id)
      }
      if (due.length > 0) this.pumpQueue()
    }

    // A 1s tick is fine: start times are user-facing, not real-time critical.
    this.schedulerTimer = setInterval(tick, 1000)
    if (typeof this.schedulerTimer.unref === 'function') this.schedulerTimer.unref()
    tick()
  }

  private tickQueuePlans(now: number): void {
    let shouldPump = false
    for (const plan of this.repos.queuePlans.list()) {
      if (plan.status === 'scheduled' && plan.startsAt <= now) {
        this.repos.queuePlans.updateStatus(plan.id, 'running', null)
        for (const id of plan.downloadIds) {
          const download = this.repos.downloads.get(id)
          if (download?.status === 'paused') {
            this.patch(id, { status: 'queued', errorCode: null, errorMessage: null })
            this.enqueue(id)
            shouldPump = true
          } else if (download?.status === 'queued') {
            this.enqueue(id)
            shouldPump = true
          }
        }
        log.info('Queue plan started', { id: plan.id, strategy: plan.strategy })
        this.emitQueuePlansChanged()
        this.sortQueue()
      }
    }

    for (const plan of this.repos.queuePlans.list()) {
      if (plan.status !== 'running') continue
      for (const id of plan.downloadIds) {
        const download = this.repos.downloads.get(id)
        if (download?.status === 'queued' && !this.queue.includes(id)) {
          this.enqueue(id)
          shouldPump = true
        }
      }
      const allFinished = plan.downloadIds.every((id) => {
        const status = this.repos.downloads.get(id)?.status
        return status === undefined || status === 'completed' || status === 'failed' || status === 'canceled'
      })
      if (allFinished) {
        this.finishQueuePlan(plan, false)
      } else if (plan.startsAt + plan.durationMinutes * 60_000 <= now) {
        this.finishQueuePlan(plan, plan.endAction === 'pause')
      }
    }
    if (shouldPump) this.pumpQueue()
  }

  /** Publishes engine stats and the speed history graph. */
  private startTelemetry(): void {
    this.telemetryTimer = setInterval(() => {
      if (this.shuttingDown) return
      const totalSpeed = this.speeds.bytesPerSecond
      this.pushSpeedSample(totalSpeed)
      this.emit('stats', this.getStats())
    }, TELEMETRY_INTERVAL_MS)
    if (typeof this.telemetryTimer.unref === 'function') this.telemetryTimer.unref()
  }

  private pushSpeedSample(bytesPerSecond: number): void {
    const now = Date.now()
    this.speedSamples.push({ t: now, bytesPerSecond })
    const cutoff = now - SPEED_SAMPLE_WINDOW_MS
    while (this.speedSamples.length > 0 && (this.speedSamples[0] as { t: number }).t < cutoff) {
      this.speedSamples.shift()
    }
    this.emit('speedHistory', { samples: [...this.speedSamples] })
  }

  // --- queries -------------------------------------------------------------

  getStats(): EngineStats {
    const settings = this.settings.get()
    return {
      activeDownloads: this.tasks.size,
      queuedDownloads: this.queue.length,
      completedDownloads: this.repos.downloads.countByStatus(['completed']),
      failedDownloads: this.repos.downloads.countByStatus(['failed']),
      totalSpeed: this.speeds.bytesPerSecond,
      sessionBytes: this.sessionBytes,
      globalSpeedLimit: settings.globalSpeedLimit,
      uptimeMs: Date.now() - this.startedAt
    }
  }

  /** Full UI view of one download, with live speed and chunk bitmap. */
  getSnapshot(download: Download): DownloadSnapshot {
    const stats = this.repos.chunks.stats(download.id)
    const speed = this.speeds.meterFor(download.id).bytesPerSecond
    const eta = estimateEta(download.fileSize - download.downloadedBytes, speed)
    const mediaRequest = this.repos.mediaResolutions.get(download.id)
    return {
      ...download,
      speed,
      eta,
      chunksComplete: stats.complete,
      chunksTotal: stats.total,
      chunkBitmap: this.repos.chunks
        .listByDownload(download.id)
        .map((c) => (c.status === 'complete' ? 1 : 0)),
      metadata: this.media?.getView(download.id) ?? undefined,
      mediaRequest: mediaRequest
        ? {
            format: mediaRequest.format,
            videoQuality: mediaRequest.videoQuality,
            audioFormat: mediaRequest.audioFormat
          }
        : undefined,
      youtubeVideoOutput: this.repos.youtubeVideoOutputs.get(download.id) ?? undefined
    }
  }

  getSnapshots(): DownloadSnapshot[] {
    return this.repos.downloads.list().map((download) => this.getSnapshot(download))
  }

  isActive(id: DownloadId): boolean {
    return this.tasks.has(id)
  }

  getSettings(): AppSettings {
    return this.settings.get()
  }

  // --- helpers -------------------------------------------------------------

  private requireDownload(id: DownloadId): Download {
    const download = this.repos.downloads.get(id)
    if (!download) throw new EngineError({ code: 'INTERNAL', message: `No download with id ${id}` })
    return download
  }

  /** New downloads go to the back of the queue, preserving user ordering. */
  private nextPriority(): number {
    const rows = this.repos.downloads.list()
    return rows.length === 0 ? 0 : Math.max(...rows.map((d) => d.priority)) + 1
  }

  private patch(id: DownloadId, changes: Partial<Download>): Download {
    if (this.db.isClosed) {
      throw new EngineError({
        code: 'INTERNAL',
        message: 'Cannot modify a download after shutdown',
        retryable: false
      })
    }
    this.repos.downloads.update(id, changes)
    const updated = this.repos.downloads.get(id)
    if (updated) this.emit('upserted', updated)
    return updated ?? this.requireDownload(id)
  }

  /** Removes the partial and final artefacts for a download. */
  private async deletePartialFiles(download: Download): Promise<void> {
    if (isTorrentSource(download.url)) {
      if (download.tempPath && download.tempPath !== download.finalPath) {
        await this.deleteTorrentDirectory(download, download.tempPath)
      }
      return
    }
    if (isYouTubePage(download.url)) {
      await clearYtDlpWorkDirectory(download.tempPath)
    }
    if (
      download.tempPath &&
      download.tempPath !== download.finalPath &&
      (await pathExists(download.tempPath))
    ) {
      await deleteFile(download.tempPath)
    }
  }

  private async deleteTorrentDirectory(download: Download, path: string): Promise<void> {
    const target = resolve(path)
    if (
      target !== resolve(download.tempPath) ||
      basename(target) !== download.id ||
      basename(dirname(target)) !== '.moth-torrents'
    ) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Refusing to remove a torrent directory outside its managed download path',
        retryable: false
      })
    }
    await rm(target, { recursive: true, force: true })
    await this.deleteTorrentMetainfoFile(download)
  }

  private async deleteTorrentMetainfoFile(download: Download): Promise<void> {
    const target = resolve(download.tempPath)
    if (basename(target) !== download.id || basename(dirname(target)) !== '.moth-torrents') {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Refusing to remove torrent metainfo outside its managed download path',
        retryable: false
      })
    }
    await rm(getTorrentMetainfoPath(download.id, target), { force: true })
  }
}
