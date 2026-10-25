/**
 * IPC surface.
 *
 * Every renderer entry point is registered here and every argument is parsed
 * with a zod schema before it reaches the engine. The renderer is untrusted:
 * a compromised webview must not be able to hand the main process a traversal
 * path, a negative byte count, or an unbounded header map.
 *
 * Handlers return plain data. Any thrown `EngineError` is converted into a
 * serialisable `{ code, message }` so the renderer can branch on the failure
 * without Electron's error mangling losing the type.
 */

import { BrowserWindow, Notification, dialog, ipcMain, shell, app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { IpcChannel, type AppInfo, type DiskRescanResult, type IngestInfo } from '@shared/ipc.js'
import { isTorrentSource } from '@shared/torrent.js'
import {
  addDownloadSchema,
  configureReviewSchema,
  createQueuePlanSchema,
  diagnosticReportIdSchema,
  diagnosticReportSaveSchema,
  idOnlySchema,
  installExtensionSchema,
  parseOrThrow,
  playlistThumbnailSchema,
  previewDownloadSchema,
  removeDownloadSchema,
  refreshDownloadUrlSchema,
  reorderSchema,
  rescanSchema,
  selectDirectorySchema,
  setPrioritySchema,
  setDownloadQuotaSchema,
  setSpeedLimitSchema,
  setTorrentFilesSchema,
  setUploadSpeedLimitSchema,
  setStatusSchema,
  queuePlanIdSchema,
  settingsPatchSchema,
  windowActionSchema
} from '@shared/schemas.js'
import { previewUrl } from '../core/preview.js'
import type { AddDownloadRequest } from '@shared/types.js'
import type { DeepLinkRegistration } from '@shared/ipc.js'
import type { DownloadEngine } from '../core/engine.js'
import { emptyRequestSchema } from '../protocol/deepLink.js'
import { isProtocolRegistered, registerProtocol } from '../protocol/register.js'
import type { SettingsStore } from '../core/settingsStore.js'
import type { Repositories } from '../db/repositories.js'
import type { Database } from '../db/driver.js'
import { getLogger } from '../util/logger.js'
import { verifyFile } from '../util/checksum.js'
import { pathExists } from '../util/paths.js'
import { getExtensionStatus, installExtension } from '../ingest/extensionInstall.js'
import { prepareExtensionSetup } from '../ingest/extensionSetup.js'
import { getDiskUsage } from '../util/diskUsage.js'
import { createDiagnosticReport } from '../diagnostics/report.js'

const log = getLogger('ipc')
let ipcShuttingDown = false
const MAX_PLAYLIST_THUMBNAIL_BYTES = 256 * 1024
const MAX_CACHED_PLAYLIST_THUMBNAILS = 24
const MAX_TORRENT_METAINFO_BYTES = 8 * 1024 * 1024
const MAX_CONCURRENT_PLAYLIST_THUMBNAILS = 3
const playlistThumbnailCache = new Map<string, string>()
const pendingPlaylistThumbnails = new Map<string, Promise<string | null>>()
const playlistThumbnailWaiters: (() => void)[] = []
let activePlaylistThumbnailRequests = 0

async function fetchPlaylistThumbnail(url: string): Promise<string | null> {
  const cached = playlistThumbnailCache.get(url)
  if (cached) {
    playlistThumbnailCache.delete(url)
    playlistThumbnailCache.set(url, cached)
    return cached
  }
  const pending = pendingPlaylistThumbnails.get(url)
  if (pending) return pending

  const request = fetchPlaylistThumbnailData(url)
  pendingPlaylistThumbnails.set(url, request)
  try {
    const dataUrl = await request
    if (dataUrl) {
      playlistThumbnailCache.set(url, dataUrl)
      if (playlistThumbnailCache.size > MAX_CACHED_PLAYLIST_THUMBNAILS) {
        const oldest = playlistThumbnailCache.keys().next().value
        if (oldest) playlistThumbnailCache.delete(oldest)
      }
    }
    return dataUrl
  } finally {
    pendingPlaylistThumbnails.delete(url)
  }
}

async function fetchPlaylistThumbnailData(url: string): Promise<string | null> {
  if (activePlaylistThumbnailRequests >= MAX_CONCURRENT_PLAYLIST_THUMBNAILS) {
    await new Promise<void>((resolve) => playlistThumbnailWaiters.push(resolve))
  } else {
    activePlaylistThumbnailRequests += 1
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg' }
    })
    if (!response.ok || !response.body) return null
    const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (!mime || !['image/avif', 'image/webp', 'image/png', 'image/jpeg'].includes(mime)) return null
    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PLAYLIST_THUMBNAIL_BYTES) return null

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PLAYLIST_THUMBNAIL_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    if (size === 0) return null
    return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`
  } catch {
    log.debug('Playlist thumbnail could not be loaded')
    return null
  } finally {
    clearTimeout(timeout)
    const next = playlistThumbnailWaiters.shift()
    if (next) next()
    else activePlaylistThumbnailRequests -= 1
  }
}

export function setIpcShuttingDown(shuttingDown: boolean): void {
  ipcShuttingDown = shuttingDown
}

export interface IpcContext {
  engine: DownloadEngine
  settings: SettingsStore
  repos: Repositories
  db: Database
  getWindow: () => BrowserWindow | null
  getPaths: () => { userData: string; downloads: string; logs: string }
  /** Null when the ingest subsystem failed to start. */
  getIngest: () => IngestInfo | null
  regenerateToken?: () => IngestInfo
  /** Paths the extension auto-installer needs: stable staging + packed assets. */
  extensionInstall: { appDataDir: string; resourcesDir: string }
}

interface IpcFailure {
  code: string
  message: string
  retryable: boolean
}

/**
 * Wraps a handler so a thrown error becomes a structured rejection instead of
 * an opaque Electron stack trace in the renderer.
 */
function handle<T>(channel: string, fn: (payload: never) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, rawPayload: unknown): Promise<T> => {
    if (ipcShuttingDown) {
      throw {
        code: 'APP_SHUTTING_DOWN',
        message: 'Moth is shutting down; try again after restarting the app',
        retryable: false
      } satisfies IpcFailure
    }
    const startedAt = Date.now()
    try {
      const result = await fn(rawPayload as never)
      log.debug('IPC ok', { channel, ms: Date.now() - startedAt })
      return result
    } catch (err) {
      const failure: IpcFailure = {
        code: (err as { code?: string }).code ?? 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
        retryable: (err as { retryable?: boolean }).retryable ?? false
      }
      log.warn('IPC failed', { channel, code: failure.code, message: failure.message })
      // Re-throw a plain object: `ipcRenderer.invoke` rejects with it verbatim.
      throw failure
    }
  })
}

export function registerIpcHandlers(context: IpcContext): void {
  const { engine, settings, repos, getWindow, getPaths } = context
  let pendingDiagnosticReport: { id: string; content: string } | null = null

  // --- downloads -----------------------------------------------------------

  handle(IpcChannel.AddDownload, async (raw: unknown) => {
    const input = parseOrThrow(addDownloadSchema, raw, 'download request')
    return engine.add(input as AddDownloadRequest)
  })

  handle(IpcChannel.StageDownload, async (raw: unknown) => {
    const input = parseOrThrow(addDownloadSchema, raw, 'staged download request')
    return engine.stage(input as AddDownloadRequest)
  })

  handle(IpcChannel.StartReviewDownload, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    return engine.startReviewDownload(id)
  })

  handle(IpcChannel.GetReviewRequest, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    return engine.getReviewRequest(id)
  })

  handle(IpcChannel.ConfigureReviewDownload, async (raw: unknown) => {
    const { id, request } = parseOrThrow(configureReviewSchema, raw, 'review configuration')
    return engine.configureReview(id, request as AddDownloadRequest)
  })

  handle(IpcChannel.PreviewDownload, async (raw: unknown) => {
    const { url } = parseOrThrow(previewDownloadSchema, raw, 'preview request')
    return previewUrl(url)
  })

  handle(IpcChannel.PreviewMediaPlaylist, async (raw: unknown) => {
    const { url } = parseOrThrow(previewDownloadSchema, raw, 'playlist preview request')
    return engine.previewMediaPlaylist(url)
  })

  handle(IpcChannel.GetPlaylistThumbnail, async (raw: unknown) => {
    const { url } = parseOrThrow(playlistThumbnailSchema, raw, 'playlist thumbnail request')
    return fetchPlaylistThumbnail(url)
  })

  handle(IpcChannel.CheckMediaDuplicate, (raw: unknown) => {
    const { url } = parseOrThrow(previewDownloadSchema, raw, 'media history request')
    return engine.checkMediaDuplicate(url)
  })

  handle(IpcChannel.ListDownloads, () => engine.getSnapshots())

  handle(IpcChannel.GetDownload, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    const download = repos.downloads.get(id)
    return download ? engine.getSnapshot(download) : null
  })

  handle(IpcChannel.GetDownloadFileIcon, async (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    const download = repos.downloads.get(id)
    if (
      process.platform !== 'win32' ||
      !download ||
      download.status !== 'completed' ||
      !download.finalPath ||
      extname(download.finalPath).toLowerCase() !== '.exe' ||
      !(await pathExists(download.finalPath))
    ) {
      return null
    }

    try {
      const icon = await app.getFileIcon(download.finalPath, { size: 'normal' })
      return icon.isEmpty() ? null : icon.toDataURL()
    } catch (error) {
      log.debug('Could not extract downloaded executable icon', {
        id,
        error: error instanceof Error ? error.name : 'UnknownError'
      })
      return null
    }
  })

  handle(IpcChannel.PauseDownload, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    return engine.pause(id)
  })

  handle(IpcChannel.ResumeDownload, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    return engine.resume(id)
  })

  handle(IpcChannel.CancelDownload, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    return engine.cancel(id)
  })

  handle(IpcChannel.RetryDownload, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    return engine.retry(id)
  })

  handle(IpcChannel.RefreshDownloadUrl, async (raw: unknown) => {
    const { id, url } = parseOrThrow(refreshDownloadUrlSchema, raw, 'refresh link request')
    return engine.refreshDownloadUrl(id, url)
  })

  handle(IpcChannel.RemoveDownload, async (raw: unknown) => {
    const { id, deleteFile } = parseOrThrow(removeDownloadSchema, raw, 'remove request')
    await engine.remove(id, deleteFile)
    return { removed: [id] }
  })

  handle(IpcChannel.SetPriority, (raw: unknown) => {
    const { id, priority } = parseOrThrow(setPrioritySchema, raw, 'priority request')
    return engine.setPriority(id, priority)
  })

  handle(IpcChannel.SetSpeedLimit, (raw: unknown) => {
    const { id, speedLimit } = parseOrThrow(setSpeedLimitSchema, raw, 'speed limit request')
    return engine.setSpeedLimit(id, speedLimit)
  })

  handle(IpcChannel.SetUploadSpeedLimit, (raw: unknown) => {
    const { id, speedLimit } = parseOrThrow(setUploadSpeedLimitSchema, raw, 'upload speed limit request')
    return engine.setUploadSpeedLimit(id, speedLimit)
  })

  handle(IpcChannel.GetTorrentFiles, async (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    return engine.getTorrentFiles(id)
  })

  handle(IpcChannel.SetTorrentFiles, async (raw: unknown) => {
    const { id, indexes } = parseOrThrow(setTorrentFilesSchema, raw, 'torrent file selection')
    return engine.setTorrentFiles(id, indexes)
  })

  handle(IpcChannel.SetDownloadQuota, async (raw: unknown) => {
    const { id, quotaBytes } = parseOrThrow(setDownloadQuotaSchema, raw, 'download quota request')
    return engine.setDownloadQuota(id, quotaBytes)
  })

  handle(IpcChannel.MoveUp, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    return moveInQueue(repos, engine, id, -1)
  })

  handle(IpcChannel.MoveDown, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    return moveInQueue(repos, engine, id, 1)
  })

  handle(IpcChannel.Reorder, (raw: unknown) => {
    const { orderedIds } = parseOrThrow(reorderSchema, raw, 'reorder request')
    engine.reorder(orderedIds)
    return repos.downloads.list()
  })

  handle(IpcChannel.PauseAll, () => {
    engine.pauseAll()
    return repos.downloads.list()
  })

  handle(IpcChannel.ResumeAll, () => {
    engine.resumeAll()
    return repos.downloads.list()
  })

  handle(IpcChannel.ClearCompleted, (raw: unknown) => {
    parseOrThrow(emptyRequestSchema, raw, 'clear request')
    const removed = engine.clearCompleted()
    return { removed }
  })

  handle(IpcChannel.SetStatus, (raw: unknown) => {
    const { id, status } = parseOrThrow(setStatusSchema, raw, 'status request')
    return engine.setStatus(id, status)
  })

  handle(IpcChannel.ListQueuePlans, () => engine.listQueuePlans())

  handle(IpcChannel.CreateQueuePlan, (raw: unknown) => {
    const request = parseOrThrow(createQueuePlanSchema, raw, 'queue plan request')
    return engine.createQueuePlan(request)
  })

  handle(IpcChannel.CancelQueuePlan, (raw: unknown) => {
    const { id } = parseOrThrow(queuePlanIdSchema, raw, 'queue plan id')
    return engine.cancelQueuePlan(id)
  })

  handle(IpcChannel.RemoveQueuePlan, (raw: unknown) => {
    const { id } = parseOrThrow(queuePlanIdSchema, raw, 'queue plan id')
    return engine.removeQueuePlan(id)
  })

  handle(IpcChannel.VerifyDownload, async (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    const download = repos.downloads.get(id)
    if (!download || download.status !== 'completed' || !download.finalPath || isTorrentSource(download.url)) {
      return { outcome: 'unavailable' as const }
    }
    const target = download.finalPath
    if (!(await pathExists(target))) return { outcome: 'unavailable' as const }
    const result = await verifyFile(target, download.expectedChecksum)
    return {
      outcome: result.unverified ? 'unverified' : result.ok ? 'verified' : 'mismatch',
      algorithm: result.algorithm,
      actual: result.actual,
      expected: result.expected
    }
  })

  // --- shell integration ---------------------------------------------------

  handle(IpcChannel.RevealFile, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    const download = repos.downloads.get(id)
    if (!download) return false
    const target = download.finalPath ?? download.tempPath
    shell.showItemInFolder(target)
    return true
  })

  handle(IpcChannel.OpenContainingFolder, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    const download = repos.downloads.get(id)
    if (!download) return false
    const torrent = isTorrentSource(download.url)
    const outputPath = download.finalPath ?? download.tempPath
    const dir = torrent ? outputPath : dirname(outputPath)
    return shell.openPath(dir).then(() => true)
  })

  handle(IpcChannel.OpenFile, (raw: unknown) => {
    const { id } = parseOrThrow(idOnlySchema, raw, 'download id')
    const download = repos.downloads.get(id)
    if (!download || download.status !== 'completed') return false
    return shell.openPath(download.finalPath ?? '').then(() => true)
  })

  // --- settings & engine ---------------------------------------------------

  handle(IpcChannel.GetSettings, () => settings.get())

  handle(IpcChannel.SetSettings, (raw: unknown) => {
    const patch = parseOrThrow(settingsPatchSchema, raw, 'settings patch')
    const next = settings.update(patch)
    if (patch.globalSpeedLimit !== undefined) {
      engine.setGlobalSpeedLimit(next.globalSpeedLimit)
    }
    return next
  })

  handle(IpcChannel.GetStats, () => engine.getStats())

  handle(IpcChannel.RunRecovery, () => engine.rescan())

  handle(IpcChannel.RescanDisk, async (raw: unknown): Promise<DiskRescanResult> => {
    const { id } = parseOrThrow(rescanSchema, raw, 'rescan request')
    const result = await engine.rescan(id)
    return {
      repaired: result.repaired,
      invalidated: result.invalidated,
      failed: result.failed,
      details: result.details,
      durationMs: result.durationMs
    }
  })

  // --- dialogs & app -------------------------------------------------------

  handle(IpcChannel.SelectDirectory, async (raw: unknown) => {
    const { title } = parseOrThrow(selectDirectorySchema, raw ?? {}, 'directory request')
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: title ?? 'Choose a download folder',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  handle(IpcChannel.SelectTorrentFile, async (raw: unknown) => {
    parseOrThrow(emptyRequestSchema, raw ?? {}, 'torrent file picker request')
    const window = getWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a .torrent file',
      properties: ['openFile'],
      filters: [{ name: 'BitTorrent files', extensions: ['torrent'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    if (!path) return null
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_TORRENT_METAINFO_BYTES) {
      throw new Error('The selected .torrent file must be between 1 byte and 8 MiB.')
    }
    const bytes = await readFile(path)
    if (bytes.length === 0 || bytes.length > MAX_TORRENT_METAINFO_BYTES) {
      throw new Error('The selected .torrent file must be between 1 byte and 8 MiB.')
    }
    return {
      fileName: basename(path),
      metainfo: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  })

  handle(IpcChannel.OpenLogsFolder, () => {
    const { logs } = getPaths()
    return shell.openPath(logs).then(() => true)
  })

  handle(IpcChannel.PrepareDiagnosticReport, (raw: unknown) => {
    parseOrThrow(emptyRequestSchema, raw ?? {}, 'diagnostic report preview request')
    const downloads = repos.downloads.list()
    const currentSettings = settings.get()
    const report = createDiagnosticReport({
      generatedAt: new Date().toISOString(),
      app: {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        architecture: process.arch
      },
      settings: {
        maxConcurrentDownloads: currentSettings.maxConcurrentDownloads,
        defaultConnections: currentSettings.defaultConnections,
        chunkSize: currentSettings.chunkSize,
        maxRetries: currentSettings.maxRetries,
        logLevel: currentSettings.logLevel
      },
      downloads: downloads.map(({ status, errorCode }) => ({ status, errorCode }))
    })
    const preview = `${JSON.stringify(report, null, 2)}\n`
    const id = randomUUID()
    pendingDiagnosticReport = { id, content: preview }
    return { id, preview }
  })

  handle(IpcChannel.DiscardDiagnosticReport, (raw: unknown) => {
    const { id } = parseOrThrow(diagnosticReportIdSchema, raw, 'diagnostic report discard request')
    if (pendingDiagnosticReport?.id === id) pendingDiagnosticReport = null
  })

  handle(IpcChannel.SaveDiagnosticReport, async (raw: unknown) => {
    const { id } = parseOrThrow(diagnosticReportSaveSchema, raw, 'diagnostic report save request')
    const prepared = pendingDiagnosticReport
    if (!prepared || prepared.id !== id) {
      throw new Error('The diagnostic report preview has expired. Generate a new preview before saving.')
    }
    const window = getWindow()
    const options = {
      title: 'Save Moth diagnostic report',
      defaultPath: `moth-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      filters: [{ name: 'JSON report', extensions: ['json'] }]
    }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, prepared.content, 'utf8')
    pendingDiagnosticReport = null
    log.info('Diagnostic report saved', { path: result.filePath })
    return result.filePath
  })

  handle(IpcChannel.GetAppInfo, (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    startedAt: Date.now()
  }))

  handle(IpcChannel.GetPaths, () => getPaths())

  // Disk usage for the sidebar footer and the live bar. Reads the volume that
  // holds the download directory on every call (polled, ~10 s cadence), so a
  // separate AppInfo field that is only fetched at startup would go stale.
  handle(IpcChannel.GetDiskUsage, () => getDiskUsage(settings.get().downloadDirectory))

  handle(IpcChannel.WindowAction, (raw: unknown) => {
    const { action } = parseOrThrow(windowActionSchema, raw, 'window action')
    const window = getWindow()
    if (!window) return false
    switch (action) {
      case 'minimize':
        window.minimize()
        return true
      case 'maximize':
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        return true
      case 'restore':
        window.restore()
        return true
      case 'hide':
        window.hide()
        return true
      case 'close':
        window.close()
        return true
    }
  })

  handle(IpcChannel.GetIngestInfo, () => {
    const status = context.getIngest()
    if (!status) {
      // The server is not running; still report the token so the UI can show
      // why, rather than pretending integration is unavailable.
      const config = settings.get()
      return {
        enabled: false,
        running: false,
        port: config.ingestPort,
        token: config.ingestToken,
        extensionPath: '',
        watchedFolders: []
      }
    }
    return status
  })

  handle(IpcChannel.OpenExtensionFolder, () => {
    const status = context.getIngest()
    if (!status || status.extensionPath.length === 0) return false
    return shell.openPath(status.extensionPath).then(() => true)
  })

  handle(IpcChannel.PrepareExtensionSetup, async () => {
    const folder = await prepareExtensionSetup(app.getPath('desktop'), context.extensionInstall.resourcesDir)
    const guide = join(folder, 'INSTALL.html')
    shell.showItemInFolder(guide)
    const openError = await shell.openPath(guide)
    if (openError) throw new Error(`Setup folder was created but could not be opened: ${openError}`)
    log.info('Prepared and opened Chrome extension setup guide')
    return folder
  })

  handle(IpcChannel.RegenerateToken, () => {
    const status = context.getIngest()
    if (!status) throw new Error('Browser integration is not running')
    if (!context.regenerateToken) return status
    return context.regenerateToken()
  })

  handle(IpcChannel.InstallExtension, (raw: unknown) => {
    const { browsers } = parseOrThrow(installExtensionSchema, raw ?? {}, 'extension install request')
    return installExtension({ ...context.extensionInstall, ...(browsers ? { browsers } : {}) })
  })

  handle(IpcChannel.GetExtensionStatus, () => getExtensionStatus(context.extensionInstall))

  // --- deep-link protocol ----------------------------------------------------

  handle(IpcChannel.GetDeepLinkStatus, (raw: unknown): DeepLinkRegistration => {
    parseOrThrow(emptyRequestSchema, raw ?? undefined, 'deep-link status request')
    return { registered: isProtocolRegistered() }
  })

  handle(IpcChannel.RegisterDeepLink, (raw: unknown): DeepLinkRegistration => {
    parseOrThrow(emptyRequestSchema, raw ?? undefined, 'deep-link register request')
    return { registered: registerProtocol() }
  })

  handle(IpcChannel.QuitApp, () => {
    app.quit()
  })

  log.info('IPC handlers registered', { count: Object.keys(IpcChannel).length })
}

/** Moves a download up or down the priority queue. */
function moveInQueue(
  repos: Repositories,
  engine: DownloadEngine,
  id: string,
  direction: -1 | 1
): ReturnType<Repositories['downloads']['list']> {
  const ordered = repos.downloads.list()
  const index = ordered.findIndex((d) => d.id === id)
  if (index === -1) return ordered

  const target = index + direction
  if (target < 0 || target >= ordered.length) return ordered

  // Swap the two, then renumber so priorities stay a dense 0..n-1 sequence.
  const a = ordered[index]
  const b = ordered[target]
  if (!a || !b) return ordered
  const swap = ordered[index]!
  ordered[index] = ordered[target]!
  ordered[target] = swap

  const ids = ordered.map((d) => d.id)
  engine.reorder(ids)
  return repos.downloads.list()
}

/** Shows a desktop notification, if the OS allows it. */
export function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  try {
    new Notification({ title, body, silent: false }).show()
  } catch (err) {
    log.warn('Notification failed', { error: err })
  }
}
