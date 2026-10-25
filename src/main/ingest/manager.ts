/**
 * Owns the lifetime of the ingest endpoint and the download-folder watcher.
 *
 * Both are optional subsystems, so the manager is written to make "off" and
 * "on" equally cheap: when disabled, nothing is constructed, no port is bound
 * and no timer runs. That matters because this is a background HTTP surface —
 * it should exist only while the user has asked for it.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SettingsStore } from '../core/settingsStore.js'
import { startIngestServer, type AgentApi, type IngestServer } from './server.js'
import { FolderWatcher } from './watcher.js'
import { getLogger } from '../util/logger.js'
import { ensureToken } from './server.js'
import { toEngineError } from '../util/errors.js'
import { readExtensionIdentity } from './extensionInstall.js'

const log = getLogger('ingest.manager')

export interface IngestStatus {
  enabled: boolean
  running: boolean
  port: number
  token: string
  extensionPath: string
  watchedFolders: string[]
}

export class IngestManager {
  private server: IngestServer | null = null
  private serverToken: string | null = null
  private watcher: FolderWatcher | null = null
  private unsubscribe: (() => void) | null = null
  constructor(
    private readonly settings: SettingsStore,
    private readonly resourcesPath: string,
    private readonly agentApi: AgentApi,
    private readonly onDownload: (request: {
      url: string
      filename?: string
      referer?: string
      cookies?: string
      userAgent?: string
      autoStart?: boolean
      /** Page metadata supplied by the browser extension. */
      media?: import('@shared/media.js').MediaHint
      /**
       * Wanted capture format for pages without a direct file (video
       * slice 1). Absent means the legacy path: fetch the URL as-is.
       */
      format?: import('@shared/types.js').VideoCaptureFormat
      videoQuality?: import('@shared/types.js').VideoQuality
      audioFormat?: import('@shared/types.js').AudioOutputFormat
    }) => Promise<{ id: string }>,
    /**
     * Read-only views for the agent/test CLI. Absent entirely and the
     * routes stay 404, as they are for extension-only deployments.
     */
    private readonly onQuery?: {
      list: () => Promise<unknown>
      get: (id: string) => Promise<unknown>
    }
  ) {}

  /** Where the unpacked extension lives, for the user to load manually. */
  get extensionPath(): string {
    return join(this.resourcesPath, 'browser-extension', 'chrome')
  }

  /** Mints a token on first run and starts/stops to match the settings. */
  async start(): Promise<void> {
    const current = this.settings.get()
    if (!current.ingestToken) {
      const token = ensureToken('')
      this.settings.update({ ingestToken: token })
      log.info('Generated a browser pairing token')
    }

    this.unsubscribe = this.settings.onChanged(() => {
      void this.sync()
    })
    await this.sync()
  }

  /** Reconciles the running subsystems with the current settings. */
  private async sync(): Promise<void> {
    const config = this.settings.get()

    const watchFolders = config.watchDownloadFolder ? [config.downloadDirectory] : []
    const watcherMatchesSettings =
      this.watcher !== null &&
      this.watcher.folders.length === watchFolders.length &&
      this.watcher.folders.every((folder, index) => folder === watchFolders[index])
    if (!watcherMatchesSettings && this.watcher) {
      this.watcher.stop()
      this.watcher = null
    }
    if (watchFolders.length > 0 && !this.watcher) {
      this.watcher = new FolderWatcher({
        folders: watchFolders,
        onDetected: (info) => {
          log.info('Browser download detected in the watch folder', {
            filename: info.filename,
            size: info.size
          })
        }
      })
      this.watcher.start()
    }

    if (config.browserIntegration) {
      const token = ensureToken(config.ingestToken)
      if (this.server && this.serverToken !== token) {
        await this.server.close()
        this.server = null
        this.serverToken = null
      }
      if (!this.server) {
        try {
          let extensionId: string | null = null
          try {
            extensionId = (await readExtensionIdentity(this.resourcesPath))?.id ?? null
          } catch (err) {
            log.warn('Could not read the packaged extension identity for automatic pairing', { error: err })
          }
          this.server = await startIngestServer({
            port: config.ingestPort,
            token,
            extensionId,
            onDownload: this.onDownload,
            agent: this.agentApi,
            ...(this.onQuery ? { onList: this.onQuery.list, onGet: this.onQuery.get } : {}),
            onPort: (port) => {
              // Persist the port actually bound, so the UI shows the truth if
              // the preferred one was already taken.
              if (port !== config.ingestPort) {
                this.settings.update({ ingestPort: port })
                log.warn('Preferred ingest port was busy; using the next one', { port })
              }
            }
          })
          this.serverToken = token
        } catch (err) {
          const error = toEngineError(err)
          log.error('Could not start the ingest server', { error: error.message })
          this.settings.update({ browserIntegration: false })
        }
      }
    } else if (this.server) {
      await this.server.close()
      this.server = null
      this.serverToken = null
      log.info('Ingest server stopped')
    }

  }

  get status(): IngestStatus {
    const config = this.settings.get()
    return {
      enabled: config.browserIntegration,
      running: this.server !== null,
      port: this.server?.port ?? config.ingestPort,
      token: ensureToken(config.ingestToken),
      extensionPath: this.extensionPath,
      watchedFolders: this.watcher?.folders ?? []
    }
  }

  /** Issues a new token, invalidating any extension already paired. */
  regenerateToken(): IngestStatus {
    const token = ensureToken('')
    this.settings.update({ ingestToken: token })
    log.info('Regenerated the browser pairing token')
    return this.status
  }

  /** True when the extension is actually present on disk. */
  hasExtension(): boolean {
    return existsSync(join(this.extensionPath, 'manifest.json'))
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.watcher?.stop()
    this.watcher = null
    await this.server?.close()
    this.server = null
    this.serverToken = null
  }
}
