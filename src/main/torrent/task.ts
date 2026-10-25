import type { Download, DownloadId } from '@shared/types.js'
import {
  isImportedTorrentFileUri,
  isTorrentFileUrl,
  parseMagnetUri
} from '@shared/torrent.js'
import {
  parseTransmissionAddedTorrent,
  getTorrentMetainfoPath,
  parseTransmissionFiles,
  parseTransmissionTorrents,
  transmissionLimit,
  type TransmissionClientProvider,
  type TransmissionRpc,
  type TransmissionTorrent,
} from './transmission.js'
import type { TaskEvent } from '../core/task.js'
import type { Repositories } from '../db/repositories.js'
import { EngineError } from '../util/errors.js'
import { ensureDir, resolveWithin, sanitizeFilename } from '../util/paths.js'
import { getLogger } from '../util/logger.js'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openFile } from '../net/httpClient.js'

const log = getLogger('torrent.task')
const POLL_INTERVAL_MS = 1000
const MAX_TORRENT_METAINFO_BYTES = 8 * 1024 * 1024
const TORRENT_FIELDS = [
  'id',
  'hashString',
  'name',
  'status',
  'percentDone',
  'totalSize',
  'sizeWhenDone',
  'haveValid',
  'rateDownload',
  'leftUntilDone',
  'downloadDir',
  'peersConnected',
  'isFinished'
]

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function loadTorrentMetainfo(download: Download, signal: AbortSignal): Promise<Buffer> {
  const path = getTorrentMetainfoPath(download.id, download.tempPath)
  let metainfo: Buffer
  try {
    metainfo = await readFile(path)
  } catch (error) {
    if (!isTorrentFileUrl(download.url) || !hasErrorCode(error, 'ENOENT')) throw error

    const response = await openFile({ url: download.url, signal })
    if (response.contentLength > MAX_TORRENT_METAINFO_BYTES) {
      response.stream.destroy()
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'The remote .torrent file exceeds the 8 MiB size limit',
        retryable: false
      })
    }

    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response.stream) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_TORRENT_METAINFO_BYTES) {
        response.stream.destroy()
        throw new EngineError({
          code: 'PRECONDITION_FAILED',
          message: 'The remote .torrent file exceeds the 8 MiB size limit',
          retryable: false
        })
      }
      chunks.push(bytes)
    }
    if (size === 0 || (response.contentLength > 0 && size !== response.contentLength)) {
      throw new EngineError({
        code: 'NETWORK',
        message: 'The remote .torrent file was empty or incomplete',
        retryable: true
      })
    }
    metainfo = Buffer.concat(chunks, size)
    try {
      await writeFile(path, metainfo, { flag: 'wx' })
    } catch (writeError) {
      if (!hasErrorCode(writeError, 'EEXIST')) throw writeError
      metainfo = await readFile(path)
    }
  }

  if (metainfo.length === 0 || metainfo.length > MAX_TORRENT_METAINFO_BYTES) {
    throw new EngineError({
      code: 'PRECONDITION_FAILED',
      message: 'The staged .torrent file is empty or exceeds the 8 MiB size limit',
      retryable: false
    })
  }
  return metainfo
}

interface TorrentTaskOptions {
  id: DownloadId
  download: Download
  manager: TransmissionClientProvider
  repos: Repositories
  emit: (event: TaskEvent) => void
}

export class TorrentDownloadTask {
  private readonly abort = new AbortController()
  private running = false
  private completed = false
  private intent: 'pause' | 'cancel' | null = null
  private torrentId: number | null = null

  constructor(private readonly options: TorrentTaskOptions) {}

  get isRunning(): boolean {
    return this.running
  }

  pause(): void {
    this.intent = 'pause'
    this.abort.abort()
  }

  cancel(): void {
    this.intent = 'cancel'
    this.abort.abort()
  }

  destroy(): void {
    if (!this.abort.signal.aborted) this.abort.abort()
  }

  async run(): Promise<void> {
    if (this.running) throw new Error('Torrent task is already running')
    this.running = true
    const { download, manager, repos, emit } = this.options
    const magnet = parseMagnetUri(download.url)
    const torrentFileUrl = isTorrentFileUrl(download.url)
    const importedFile = isImportedTorrentFileUri(download.url)
    const selectedTorrentFiles = download.torrentFiles ?? null
    if (!magnet && !torrentFileUrl && !importedFile) {
      this.running = false
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Invalid BitTorrent magnet or .torrent source',
        retryable: false
      })
    }

    let client: TransmissionRpc | null = null
    let taskError: unknown
    let failed = false
    let cleanupError: unknown
    try {
      await ensureDir(download.tempPath)
      const remoteMetainfo = torrentFileUrl
        ? await loadTorrentMetainfo(download, this.abort.signal)
        : null
      client = await manager.start()
      const torrents = parseTransmissionTorrents(await client.call('torrent-get', {
        fields: TORRENT_FIELDS
      }))
      const expectedHashes = magnet
        ? [magnet.v1InfoHash, magnet.v2InfoHash]
        .filter((hash): hash is string => hash !== null)
        : []
      let torrent = torrents.find((item) => expectedHashes.includes(item.hashString.toLowerCase())) ??
        (!magnet
          ? torrents.find((item) => resolve(item.downloadDir) === resolve(download.tempPath))
          : undefined)
      if (torrent && resolve(torrent.downloadDir) !== resolve(download.tempPath)) {
        throw new EngineError({
          code: 'PRECONDITION_FAILED',
          message: 'This torrent is already active in a different Moth download',
          retryable: false
        })
      }
      if (!torrent) {
        const addArgs: Record<string, unknown> = {
          'download-dir': resolve(download.tempPath),
          paused: true,
          seedRatioMode: 1,
          seedRatioLimit: 0
        }
        if (magnet) {
          addArgs.filename = magnet.uri
        } else if (torrentFileUrl || importedFile) {
          const metainfo = remoteMetainfo ?? await loadTorrentMetainfo(download, this.abort.signal)
          addArgs.metainfo = metainfo.toString('base64')
        }
        const added = await client.call('torrent-add', addArgs)
        const result = parseTransmissionAddedTorrent(added)
        if (magnet && !expectedHashes.includes(result.hashString.toLowerCase())) {
          throw new EngineError({
            code: 'PRECONDITION_FAILED',
            message: 'Transmission returned a different torrent than the submitted magnet link',
            retryable: false
          })
        }
        this.torrentId = result.id
      } else {
        this.torrentId = torrent.id
      }

      if (this.abort.signal.aborted) return
      const downloadLimit = transmissionLimit(download.speedLimit, 'download')
      const uploadLimit = transmissionLimit(download.uploadSpeedLimit, 'upload')
      await client.call('torrent-set', {
        ids: [this.torrentId],
        downloadLimited: downloadLimit.limited,
        downloadLimit: downloadLimit.kilobytesPerSecond,
        uploadLimited: uploadLimit.limited,
        uploadLimit: uploadLimit.kilobytesPerSecond
      })
      let fileSelectionApplied = selectedTorrentFiles === null
      if (selectedTorrentFiles !== null) {
        fileSelectionApplied = await this.applySavedFileSelection(client, selectedTorrentFiles)
      }
      await client.call('torrent-start', { ids: [this.torrentId] })
      repos.downloads.update(this.options.id, {
        status: 'connecting',
        errorCode: null,
        errorMessage: null,
        startedAt: download.startedAt ?? Date.now()
      })
      emit({ type: 'status', id: this.options.id, status: 'connecting' })

      while (!this.abort.signal.aborted) {
        if (!fileSelectionApplied && selectedTorrentFiles !== null) {
          fileSelectionApplied = await this.applySavedFileSelection(client, selectedTorrentFiles)
        }
        const response = parseTransmissionTorrents(await client.call('torrent-get', {
          ids: [this.torrentId],
          fields: TORRENT_FIELDS
        }))
        torrent = response[0]
        if (!torrent) {
          throw new EngineError({
            code: 'INTERNAL',
            message: 'Transmission no longer has this torrent in its queue',
            retryable: false
          })
        }
        if (torrent.status === 0) {
          throw new EngineError({
            code: 'PRECONDITION_FAILED',
            message: 'Transmission stopped this torrent before it completed',
            retryable: false
          })
        }

        if (
          torrent.sizeWhenDone > 0 &&
          torrent.leftUntilDone === 0
        ) {
          await client.call('torrent-stop', { ids: [this.torrentId] })
          if (this.abort.signal.aborted) return
          await this.complete(torrent)
          this.completed = true
          return
        }

        const status = torrent.status === 1 || torrent.status === 2 || torrent.status === 3
          ? 'connecting'
          : 'downloading'
        const total = Math.max(0, torrent.sizeWhenDone)
        const downloaded = Math.min(total, Math.max(0, total - torrent.leftUntilDone))
        repos.downloads.update(this.options.id, {
          status,
          fileSize: total,
          downloadedBytes: downloaded,
          filename: sanitizeFilename(torrent.name, download.filename)
        })
        emit({ type: 'status', id: this.options.id, status })
        emit({
          type: 'progress',
          progress: {
            id: this.options.id,
            downloadedBytes: downloaded,
            fileSize: total,
            speed: Math.max(0, torrent.rateDownload),
            eta: null,
            chunksComplete: 0,
            chunksTotal: 0,
            chunkBitmap: [],
            activeConnections: Math.max(0, torrent.peersConnected)
          }
        })
        await delay(POLL_INTERVAL_MS, this.abort.signal)
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        taskError = error
        failed = true
      }
    } finally {
      if (client && this.torrentId !== null) {
        try {
          if (this.intent === 'cancel' && !this.completed) {
            await client.call('torrent-remove', {
              ids: [this.torrentId],
              'delete-local-data': true
            })
          } else if (!this.completed) {
            await client.call('torrent-stop', { ids: [this.torrentId] })
          }
        } catch (error) {
          cleanupError = error
          log.error('Could not stop torrent cleanly', {
            id: this.options.id,
            intent: this.intent ?? 'task-finished',
            error: error instanceof Error ? error.message : String(error)
          })
          if (this.intent === 'cancel' && !this.completed) {
            try {
              await client.call('torrent-stop', { ids: [this.torrentId] })
              cleanupError = undefined
            } catch (stopError) {
              cleanupError = stopError
              log.error('Could not stop torrent after removal failed', {
                id: this.options.id,
                error: stopError instanceof Error ? stopError.message : String(stopError)
              })
            }
          }
        }
      }

      if (
        this.intent === 'pause' &&
        cleanupError === undefined &&
        !this.completed &&
        repos.downloads.get(this.options.id)?.status !== 'completed'
      ) {
        repos.downloads.update(this.options.id, { status: 'paused' })
        emit({ type: 'status', id: this.options.id, status: 'paused' })
      }
      this.running = false
    }
    if (cleanupError !== undefined) {
      throw new EngineError({
        code: 'NETWORK',
        message: 'Could not stop the Transmission torrent; check that the local torrent engine is responsive',
        retryable: this.intent === null,
        cause: failed ? new AggregateError([taskError, cleanupError]) : cleanupError
      })
    }
    if (failed) throw taskError
  }

  private async applySavedFileSelection(client: TransmissionRpc, indexes: number[]): Promise<boolean> {
    if (this.torrentId === null) return false
    const files = parseTransmissionFiles(await client.call('torrent-get', {
      ids: [this.torrentId],
      fields: ['files', 'fileStats']
    }))
    if (files.length === 0) return false
    if (
      indexes.length === 0 ||
      new Set(indexes).size !== indexes.length ||
      indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= files.length)
    ) {
      throw new EngineError({
        code: 'PRECONDITION_FAILED',
        message: 'Saved torrent file selection does not match this torrent',
        retryable: false
      })
    }
    const selected = new Set(indexes)
    await client.call('torrent-set', {
      ids: [this.torrentId],
      'files-wanted': indexes,
      'files-unwanted': files.filter((file) => !selected.has(file.index)).map((file) => file.index)
    })
    return true
  }

  private async complete(torrent: TransmissionTorrent): Promise<void> {
    const { download, repos, emit } = this.options
    const finalPath = resolveWithin(download.tempPath, '.')
    const total = Math.max(0, torrent.sizeWhenDone)
    repos.downloads.update(this.options.id, {
      status: 'completed',
      filename: sanitizeFilename(torrent.name, download.filename),
      fileSize: total,
      downloadedBytes: total,
      finalPath,
      computedChecksum: null,
      completedAt: Date.now(),
      errorCode: null,
      errorMessage: null
    })
    emit({ type: 'status', id: this.options.id, status: 'completed' })
    emit({
      type: 'finished',
      id: this.options.id,
      finalPath,
      size: total,
      durationMs: Math.max(0, Date.now() - (download.startedAt ?? Date.now())),
      averageSpeed: 0,
      checksum: null
    })
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
