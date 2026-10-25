/**
 * Main process bootstrap.
 *
 * Startup order is deliberate and load-bearing:
 *
 *   1. logging, so everything after this point is recorded
 *   2. database + migrations, because the engine needs the chunk map
 *   3. settings, so the download directory is known before recovery runs
 *   4. window, so the user sees the UI while recovery runs
 *   5. recovery, then the engine's scheduler and telemetry
 *
 * Crash recovery deliberately runs *after* the window exists: it can take a
 * second or two on a large library, and blocking the first paint would look
 * like a hang.
 */

import { app, BrowserWindow, ipcMain, nativeTheme, protocol, shell } from 'electron'
import { join, dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { DB_FILE_NAME, LOG_DIR_NAME, LOG_FILE_NAME, PARTIAL_DIR_NAME } from '@shared/constants.js'
import type { AddDownloadRequest, DownloadId } from '@shared/types.js'
import { assertSqliteAvailable, openDatabase, type Database } from './db/driver.js'
import { migrate } from './db/schema.js'
import { createRepositories, type Repositories } from './db/repositories.js'
import { SettingsStore } from './core/settingsStore.js'
import { DownloadEngine } from './core/engine.js'
import { flushLogs, getLogger, initLogging, setLogLevel, shutdownLogging } from './util/logger.js'
import { registerIpcHandlers, setIpcShuttingDown } from './ipc/handlers.js'
import { EventBridge } from './ipc/bridge.js'
import { createTray, applyNativeTheme, type TrayController } from './tray.js'
import { IngestManager } from './ingest/manager.js'
import { getExtensionStatus, installExtension } from './ingest/extensionInstall.js'
import { MediaService } from './media/service.js'
import { initDeepLink, registerProtocol } from './protocol/index.js'
import { configureVideoCapture } from './video/index.js'
import { ARTWORK_PROTOCOL_BASE, registerMediaIpc } from './ipc/mediaHandlers.js'
import { closeAgents } from './net/httpClient.js'
import { ensureDir, resolveWithin } from './util/paths.js'

const log = getLogger('main')

const currentDir = dirname(fileURLToPath(import.meta.url))
app.setName('Moth Download Manager')

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let database: Database | null = null
let engine: DownloadEngine | null = null
let ingest: IngestManager | null = null
let media: MediaService | null = null
let bridge: EventBridge | null = null
let isQuitting = false

// A single instance owns the database; a second one would fight it over WAL.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  log.info('Another instance is already running; exiting')
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })
}

function resolvePaths(): { userData: string; logs: string; database: string; downloads: string } {
  const userData = app.getPath('userData')
  const logs = join(userData, LOG_DIR_NAME)
  mkdirSync(logs, { recursive: true })
  return {
    userData,
    logs,
    database: join(userData, DB_FILE_NAME),
    downloads: join(userData, PARTIAL_DIR_NAME)
  }
}

/**
 * Where the runtime icons live.
 *
 * Packaged builds copy `resources/` to `<resources>/assets` via
 * `extraResources`; in development it sits next to the repo. The tray and the
 * window icon are both loaded from here, and both degrade gracefully to a
 * missing file rather than preventing startup.
 */
function resolveResourcesPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'assets')
    : join(currentDir, '../../resources')
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    // Dense by default: a download list with a handful of rows in a very tall
    // window reads as a broken layout, not an empty one.
    width: 1180,
    height: 660,
    minWidth: 880,
    minHeight: 480,
    show: false,
    icon: join(resolveResourcesPath(), 'icon.png'),
    backgroundColor: '#202842',
    title: 'Moth Download Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDir, '../preload/index.mjs'),
      // The renderer is untrusted: no Node integration, no remote module.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('close', (event) => {
    if (isQuitting) return
    const settings = engine?.getSettings()
    if (settings?.closeToTray) {
      // Keep downloading in the background instead of killing the engine.
      event.preventDefault()
      window.hide()
      if (process.platform === 'darwin') app.dock?.hide()
    }
  })

  window.on('closed', () => {
    mainWindow = null
  })

  window.on('unresponsive', () => {
    log.error('Renderer became unresponsive', { webContentsId: window.webContents.id })
  })
  window.on('responsive', () => {
    log.info('Renderer became responsive', { webContentsId: window.webContents.id })
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process exited unexpectedly', {
      webContentsId: window.webContents.id,
      reason: details.reason,
      exitCode: details.exitCode
    })
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error('Preload script failed', { preloadPath, error })
  })
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId) => {
      log.error('Renderer page failed to load', {
        errorCode,
        errorDescription,
        url: validatedURL,
        isMainFrame,
        frameProcessId,
        frameRoutingId
      })
    }
  )
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const details = { webContentsId: window.webContents.id, message, line, source: sourceId }
    if (level >= 3) log.error('Renderer console error', details)
    else if (level === 2) log.warn('Renderer console warning', details)
    else log.info('Renderer console message', details)
  })

  // Never let the renderer navigate away or open windows.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('did-finish-load', () => {
    log.info('Renderer page loaded', {
      webContentsId: window.webContents.id,
      url: window.webContents.getURL()
    })
  })

  window.webContents.on('did-finish-load', () => {
    // Opt-in capture used while iterating on the interface. Off unless the
    // variable is set, and it only ever writes where the operator pointed it.
    const shot = process.env['MOTH_SCREENSHOT']
    if (!shot || !mainWindow) return
    setTimeout(() => {
      void (async () => {
        const window = mainWindow
        if (!window) return
        if (process.env['MOTH_SCREENSHOT_EXPAND_YOUTUBE'] === '1') {
          const expanded = await window.webContents.executeJavaScript(
            `(() => {
              const row = Array.from(document.querySelectorAll('[data-status="completed"]'))
              .find((row) => row.textContent?.includes('YouTube output sample.mp4'))
              const button = row?.querySelector('button[aria-label="Show details"]')
              if (!button) return false
              button.click()
              return true
            })()`
          )
          if (!expanded) log.warn('Could not expand the seeded YouTube row for screenshot')
          else {
            await new Promise((resolve) => setTimeout(resolve, 150))
            await window.webContents.executeJavaScript(
              `Array.from(document.querySelectorAll('span'))
                .find((item) => item.textContent === 'Full-decode validation')
                ?.scrollIntoView({ block: 'center' })`
            )
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        const image = await window.webContents.capturePage()
        await writeFile(shot, image.toPNG())
      })()
        .then(() => log.info('Screenshot written', { path: shot }))
        .catch((err: unknown) => log.warn('Screenshot failed', { error: err }))
    }, 2500)
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(currentDir, '../renderer/index.html'))
  }

  return window
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') app.dock?.show()
}

async function bootstrap(): Promise<void> {
  const paths = resolvePaths()

  // 1. Logging first, so failures during the rest of startup are recorded.
  const bootstrapLogger = await initLogging({
    directory: paths.logs,
    level: 'info',
    console: true
  })

  try {
    assertSqliteAvailable()
  } catch (err) {
    bootstrapLogger.error('SQLite is unavailable; Moth cannot start', { error: err })
    app.quit()
    return
  }

  bootstrapLogger.info('Moth starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node
  })

  // 2. Database.
  database = openDatabase({ location: paths.database, synchronous: 'FULL' })
  migrate(database)
  const repos: Repositories = createRepositories(database)

  // 3. Settings, including the default download directory.
  const settings = new SettingsStore(repos)
  const smokeDownloadDir = process.env['MOTH_SMOKE_DOWNLOAD_DIR']
  if (smokeDownloadDir) {
    settings.update({ downloadDirectory: resolve(smokeDownloadDir) })
  }
  setLogLevel(settings.logLevel)
  settings.onChanged((next) => setLogLevel(next.logLevel))
  const config = settings.get()
  if (!config.downloadDirectory) {
    settings.update({ downloadDirectory: join(app.getPath('downloads')) })
  }
  await ensureDir(settings.get().downloadDirectory)
  applyNativeTheme(nativeTheme)

  // Register before the renderer loads so persisted artwork URLs never race
  // the custom-protocol handler on startup.
  protocol.handle('moth-artwork', async (request) => {
    const url = new URL(request.url)
    const filename = decodeURIComponent(url.pathname.replace(/^\//, ''))
    log.info('Artwork request', { url: request.url, filename })
    const resolved = resolveWithin(join(paths.userData, 'artwork'), filename)
    try {
      const body = await readFile(resolved)
      return new Response(new Uint8Array(body), {
        headers: { 'content-type': mimeForPath(resolved) }
      })
    } catch (err) {
      log.warn('Artwork request failed', { filename, error: err })
      return new Response('not found', { status: 404 })
    }
  })

  // 4. Window.
  mainWindow = createWindow()

  // 5. Engine, IPC, bridge.
  engine = new DownloadEngine(repos, settings, database, paths.userData, resolveResourcesPath())
  engine.setGlobalSpeedLimit(settings.get().globalSpeedLimit)

  // 5b. Video-capture helpers (download-on-demand into userData/bin) and the
  // `moth://` deep link that cold-starts the app from the browser. Both are
  // total functions; neither can fail startup.
  configureVideoCapture({ userDataDir: paths.userData })
  registerProtocol()
  const deepLink = initDeepLink({
    onDeepLink: (request) => {
      if (!engine) {
        log.warn('Deep link arrived before the engine was ready; dropping it')
        return
      }
      void engine
        .add({
          url: request.url,
          format: request.format === 'audio' ? 'audio' : 'video',
          ...(request.videoQuality ? { videoQuality: request.videoQuality } : {})
        })
        .then(
          () => showWindow(),
          (err: unknown) => log.warn('Deep-link download failed', { error: err instanceof Error ? err.message : String(err) })
        )
    }
  })

  // The media service must be attached before the window exists. Otherwise the
  // renderer can request the download list while it is still null, cache
  // snapshots with no metadata, and never show artwork for the rest of the
  // session.
  media = new MediaService({
    repos: repos.media,
    settings,
    artworkBase: ARTWORK_PROTOCOL_BASE,
    userDataDir: paths.userData
  })
  engine.setMediaService(media)

  registerIpcHandlers({
    engine,
    settings,
    repos,
    db: database,
    getWindow: () => mainWindow,
    getPaths: () => ({
      userData: paths.userData,
      downloads: settings.get().downloadDirectory,
      logs: paths.logs
    }),
    getIngest: () => ingest?.status ?? null,
    regenerateToken: () =>
      ingest?.regenerateToken() ?? {
        enabled: false,
        running: false,
        port: settings.get().ingestPort,
        token: settings.get().ingestToken,
        extensionPath: '',
        watchedFolders: []
      },
    extensionInstall: {
      appDataDir: app.getPath('appData'),
      resourcesDir: resolveResourcesPath()
    }
  })

  bridge = new EventBridge(engine, settings, () => mainWindow)
  bridge.start()

  tray = createTray({
    resourcesPath: resolveResourcesPath(),
    engine,
    settings,
    getWindow: () => mainWindow,
    onShow: showWindow,
    onQuit: () => {
      isQuitting = true
      app.quit()
    }
  })

  // Browser integration: a loopback ingest endpoint for the companion extension.
  ingest = new IngestManager(
    settings,
    resolveResourcesPath(),
    {
      stats: () => {
        if (!engine) throw new Error('Download engine is not ready')
        return engine.getStats()
      },
      list: () => {
        if (!engine) throw new Error('Download engine is not ready')
        return engine.getSnapshots()
      },
      get: (id: DownloadId) => {
        const download = repos.downloads.get(id)
        return download && engine ? engine.getSnapshot(download) : null
      },
      add: (request: AddDownloadRequest) => {
        if (!engine) throw new Error('Download engine is not ready')
        return engine.add(request)
      },
      pause: async (id) => {
        if (!engine) throw new Error('Download engine is not ready')
        return engine.pause(id)
      },
      resume: (id) => {
        if (!engine) throw new Error('Download engine is not ready')
        return engine.resume(id)
      },
      retry: (id) => {
        if (!engine) throw new Error('Download engine is not ready')
        return engine.retry(id)
      },
      cancel: (id) => {
        if (!engine) throw new Error('Download engine is not ready')
        return engine.cancel(id)
      },
      logs: async (lines) => {
        const content = await readFile(join(paths.logs, LOG_FILE_NAME), 'utf8').catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
          throw err
        })
        return content.split(/\r?\n/).filter(Boolean).slice(-lines)
      },
      rescan: (id) => {
        if (!engine) throw new Error('Download engine is not ready')
        return engine.rescan(id)
      }
    },
    async (request) => {
      if (!engine) throw new Error('Engine is not ready')
      const headers: Record<string, string> = {}
      if (request.referer) headers['referer'] = request.referer
      if (request.cookies) headers['cookie'] = request.cookies
      if (request.userAgent) headers['user-agent'] = request.userAgent

      const result = await engine.add({
        url: request.url,
        ...(request.filename ? { filename: request.filename } : {}),
        ...(request.format ? { format: request.format } : {}),
        ...(request.videoQuality ? { videoQuality: request.videoQuality } : {}),
        ...(request.audioFormat ? { audioFormat: request.audioFormat } : {}),
        headers,
        // A scheduled start makes no sense for a click-to-download.
        scheduledStartAt: request.autoStart === false ? Date.now() + 5 * 60_000 : null
      })

      // Page metadata is stored now, keyed by download, so the completion path
      // can apply it without the hint having to survive inside the engine.
      if (request.media) {
        persistPageMetadata(repos, result.id, request.media)
      }
      return { id: result.id }
    },
    {
    // Read-only views for the agent/test CLI (`scripts/moth.mjs`). Same
    // engine snapshots the UI already renders — no second source of truth.
    list: async () => (engine ? engine.getSnapshots() : []),
    get: async (id: string) => {
      const download = repos.downloads.get(id)
      return download && engine ? engine.getSnapshot(download) : null
    }
    }
  )
  await ingest.start()
  settings.onChanged((next) => {
    if (next.browserIntegration) void autoInstallCompanionExtension()
  })
  const ingestStatus = ingest.status
  await autoInstallCompanionExtension()
  log.info('Browser integration ready', {
    enabled: ingestStatus.enabled,
    running: ingestStatus.running,
    port: ingestStatus.port,
    hasExtension: ingest.hasExtension()
  })

  // Media metadata IPC. The service itself was created and attached to the
  // engine above, before the window existed.
  registerMediaIpc({
    service: media,
    repos,
    onChanged: (id) => bridge?.send('moth:event:media:updated', { id })
  })
  log.info('Media metadata service ready')
  engine.setMediaService(media)

  // Recovery runs last so the window paints first.
  const report = await engine.start()
  if (report.repaired > 0) {
    // `engine.start()` already emitted 'recovery', which the event bridge
    // forwards. Sending it again here produced a duplicate toast.
    log.info('Recovered downloads after restart', {
      repaired: report.repaired,
      bytesRecovered: report.bytesRecovered,
      durationMs: report.durationMs
    })
  }

  // A cold-start deep link waits for the engine before it can queue.
  if (deepLink.pending && engine) {
    const pending = deepLink.pending
    try {
      await engine.add({
        url: pending.url,
        format: pending.format === 'audio' ? 'audio' : 'video'
      })
      showWindow()
    } catch (err) {
      log.warn('Pending deep-link download failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  // Opt-in self test used by `scripts/smoke.mjs` against the built bundle.
  const smokeUrl = process.env['MOTH_SMOKE_URL']
  if (smokeUrl && engine) {
    const { runSmokeTest } = await import('./smoke.js')
    const resultPath =
      process.env['MOTH_SMOKE_RESULT'] ?? join(paths.userData, 'smoke-result.json')
    const result = await runSmokeTest({
      url: smokeUrl,
      resultPath,
      expectedDigest: process.env['MOTH_SMOKE_DIGEST'] ?? null,
      downloadDir:
        process.env['MOTH_SMOKE_DOWNLOAD_DIR'] ?? join(paths.userData, 'smoke-downloads'),
      engine,
      repos,
      settings
    })
    log.info('Smoke test finished', { ok: result.ok, steps: result.steps.length })
    isQuitting = true
    await shutdown()
    app.exit(result.ok ? 0 : 1)
  }
}

/** Maps a stored artwork filename to a Content-Type. */
function mimeForPath(path: string): string {
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg')) return 'image/jpeg'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

/**
 * Stores page metadata supplied by the browser extension, keyed by download.
 *
 * Written at add time rather than threaded through the engine, so the completion
 * path only has to look at the record. `source` is `page`, which ranks below a
 * manual edit but above anything inferred from the file or the filename.
 */
async function persistPageMetadata(
  repos: Repositories,
  downloadId: string,
  hint: import('@shared/media.js').MediaHint
): Promise<void> {
  try {
    const { emptyTags } = await import('@shared/media.js')
    const tags = emptyTags('unknown')
    if (hint.title) tags.title = hint.title
    if (hint.artist) tags.artist = hint.artist
    if (hint.album) tags.album = hint.album
    if (hint.albumArtist) tags.albumArtist = hint.albumArtist
    if (hint.genre) tags.genre = hint.genre
    if (hint.year !== undefined && Number.isFinite(hint.year)) tags.year = hint.year
    if (hint.track !== undefined && Number.isFinite(hint.track)) tags.track = hint.track

    repos.media.upsert({
      downloadId,
      format: 'unknown',
      title: tags.title,
      artist: tags.artist,
      albumArtist: tags.albumArtist,
      album: tags.album,
      track: tags.track,
      disc: null,
      year: tags.year,
      genre: tags.genre,
      artworkPath: null,
      artworkMime: null,
      artworkBytes: null,
      source: 'page',
      writtenAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  } catch (err) {
    log.warn('Could not store page metadata', { downloadId, error: err })
  }
}

async function autoInstallCompanionExtension(): Promise<void> {
  if (!app.isPackaged || process.platform !== 'win32' || !ingest?.status.enabled) return
  try {
    const extensionStatus = await getExtensionStatus({
      appDataDir: app.getPath('appData'),
      resourcesDir: resolveResourcesPath()
    })
    if (!extensionStatus.packaged) {
      log.info('Automatic browser pairing unavailable; the signed extension is not packaged')
      return
    }
    const browsers = extensionStatus.browsers
      .filter((browser) => browser.detected && !browser.registered)
      .map((browser) => browser.browser)
    if (browsers.length === 0) return

    const result = await installExtension({
      appDataDir: app.getPath('appData'),
      resourcesDir: resolveResourcesPath(),
      browsers
    })
    log.info('Automatically registered the Moth extension with detected browsers', {
      browsers: result.results.map((entry) => ({ browser: entry.browser, ok: entry.ok })),
      restartRequired: result.restartRequired
    })
  } catch (err) {
    log.warn('Could not automatically register the Moth browser extension', { error: err })
  }
}

async function shutdown(): Promise<void> {
  if (isQuitting && !database) return
  isQuitting = true
  setIpcShuttingDown(true)
  log.info('Moth shutting down')

  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
    mainWindow = null
    tray?.destroy()
    await ingest?.stop()
    bridge?.stop()
    await engine?.shutdown()
    closeAgents()
    database?.checkpoint()
    database?.close()
  } catch (err) {
    log.error('Error during shutdown', { error: err })
  }

  await shutdownLogging()
}

app.on('window-all-closed', () => {
  // On macOS the app normally stays alive; elsewhere the tray keeps it alive
  // only if the user chose "close to tray".
  const settings = engine?.getSettings()
  if (process.platform !== 'darwin' && !settings?.closeToTray) {
    isQuitting = true
    app.quit()
  }
})

app.on('activate', () => {
  showWindow()
})

app.on('before-quit', () => {
  isQuitting = true
  log.info('Application quit requested')
})

app.on('will-quit', (event) => {
  if (database && !database.isClosed) {
    // Give the async shutdown a chance to flush state to disk.
    event.preventDefault()
    void shutdown().finally(() => {
      database = null
      app.quit()
    })
  }
})

process.once('uncaughtException', (err) => {
  log.error('Uncaught exception in main process', { error: err })
  void flushLogs().finally(() => app.quit())
})

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection in main process', { error: reason })
})

process.on('warning', (warning) => {
  log.warn('Node.js runtime warning', { warning })
})

app.on('child-process-gone', (_event, details) => {
  log.error('Electron child process exited unexpectedly', { details })
})

ipcMain.on('moth:diagnostic:renderer-error', (event, payload: unknown) => {
  if (event.sender !== mainWindow?.webContents) {
    log.warn('Ignored renderer diagnostic from an untrusted webContents', {
      senderId: event.sender.id
    })
    return
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    log.warn('Ignored malformed renderer diagnostic')
    return
  }

  const diagnostic = payload as Record<string, unknown>
  const kind = diagnostic['kind']
  const message = diagnostic['message']
  if (
    (kind !== 'uncaught-error' && kind !== 'unhandled-rejection') ||
    typeof message !== 'string'
  ) {
    log.warn('Ignored malformed renderer diagnostic', { kind })
    return
  }

  log.error('Renderer JavaScript failure', {
    kind,
    message: message.slice(0, 32_768),
    ...(typeof diagnostic['stack'] === 'string'
      ? { stack: diagnostic['stack'].slice(0, 32_768) }
      : {}),
    ...(typeof diagnostic['source'] === 'string'
      ? { source: diagnostic['source'].slice(0, 4096) }
      : {}),
    ...(typeof diagnostic['line'] === 'number' ? { line: diagnostic['line'] } : {}),
    ...(typeof diagnostic['column'] === 'number' ? { column: diagnostic['column'] } : {})
  })
})

// Custom schemes must be registered as privileged before the app is ready, or
// requests to them are handled by the default handler and fail. Without this the
// artwork <img> silently 404s and the row falls back to a category badge.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'moth-artwork',
    privileges: { standard: true, supportFetchAPI: true, stream: true }
  }
])
log.info('Artwork scheme registered as privileged')

if (gotLock) {
  app.whenReady().then(bootstrap).catch((err: unknown) => {
    log.error('Bootstrap failed', { error: err })
    app.quit()
  })
}
