/**
 * Bridges engine events to the renderer.
 *
 * Two things happen here that matter for UI quality:
 *
 *  1. **Coalescing.** Progress fires twice a second per download. Forwarding
 *     every event to every window makes the renderer drop frames, so events
 *     are buffered and flushed on a single timer, and a download that changes
 *     twice in one window only produces one IPC message.
 *  2. **Window safety.** A window may be destroyed at any moment (the user can
 *     close it mid-flush), so every send is guarded.
 */

import type { BrowserWindow } from 'electron'
import { IpcEvent, type DownloadProgressEvent } from '@shared/ipc.js'
import type { Download, DownloadId, EngineStats, SpeedSample } from '@shared/types.js'
import type { DownloadEngine } from '../core/engine.js'
import type { RecoveryReport } from '../core/recovery.js'
import type { SettingsStore } from '../core/settingsStore.js'
import { getLogger } from '../util/logger.js'
import { TELEMETRY_INTERVAL_MS } from '@shared/constants.js'
import { notify } from './handlers.js'

const log = getLogger('ipc.bridge')
const TERMINAL_NOTIFICATION_WINDOW_MS = 1500

export class EventBridge {
  private readonly progressBuffer = new Map<DownloadId, DownloadProgressEvent>()
  private readonly upsertBuffer = new Map<DownloadId, Download>()
  private readonly removedBuffer = new Set<DownloadId>()
  private flushTimer: NodeJS.Timeout | null = null
  private readonly unsubscribers: (() => void)[] = []
  private readonly terminalNotification = { completed: [] as string[], failed: 0, firstFailure: '' }
  private terminalNotificationTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly engine: DownloadEngine,
    private readonly settings: SettingsStore,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  start(): void {
    this.unsubscribers.push(
      this.engine.on('upserted', (download) => {
        this.upsertBuffer.set(download.id, download)
        this.scheduleFlush()
      }),
      this.engine.on('removed', ({ ids }) => {
        for (const id of ids) {
          this.removedBuffer.add(id)
          this.progressBuffer.delete(id)
          this.upsertBuffer.delete(id)
        }
        this.scheduleFlush()
      }),
      this.engine.on('mediaUpdated', ({ id }) => {
        this.send(IpcEvent.MediaUpdated, { id })
      }),
      this.engine.on('progress', (progress) => {
        this.progressBuffer.set(progress.id, progress)
        this.scheduleFlush()
      }),
      this.engine.on('stats', (stats) => this.send(IpcEvent.EngineStats, stats)),
      this.engine.on('speedHistory', ({ samples }) => this.send(IpcEvent.SpeedHistory, { samples })),
      this.engine.on('finished', (payload) => {
        this.send(IpcEvent.DownloadFinished, payload)
        this.queueTerminalNotification('completed', payload.filename)
      }),
      this.engine.on('failed', (payload) => {
        this.send(IpcEvent.DownloadFailed, payload)
        this.queueTerminalNotification('failed', payload.message)
      }),
      this.engine.on('recovery', (report: RecoveryReport) => {
        this.send(IpcEvent.RecoveryReport, report)
      }),
      this.engine.on('scheduled', (payload) => this.send(IpcEvent.SchedulerFired, payload)),
      this.engine.on('queuePlansChanged', (plans) => this.send(IpcEvent.QueuePlansChanged, plans))
    )

    this.settings.onChanged((settings) => {
      this.send(IpcEvent.SettingsChanged, settings)
      this.send(IpcEvent.ThemeChanged, { theme: settings.theme })
    })

    // A slow heartbeat keeps the speed graph animating even when idle.
    this.flushTimer = setInterval(() => this.flush(), TELEMETRY_INTERVAL_MS)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()

    log.info('Event bridge started')
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
    }
    this.unsubscribers.length = 0
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
    if (this.terminalNotificationTimer) clearTimeout(this.terminalNotificationTimer)
    this.terminalNotificationTimer = null
    this.terminalNotification.completed.length = 0
    this.terminalNotification.failed = 0
    this.terminalNotification.firstFailure = ''
    this.flush()
  }

  private scheduleFlush(): void {
    // The interval already guarantees a flush; this only makes sure a burst of
    // events does not wait a whole tick when the window is idle.
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 50)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.upsertBuffer.size > 0) {
      for (const download of this.upsertBuffer.values()) {
        this.send(IpcEvent.DownloadUpserted, download)
      }
      this.upsertBuffer.clear()
    }
    if (this.progressBuffer.size > 0) {
      for (const progress of this.progressBuffer.values()) {
        this.send(IpcEvent.DownloadProgress, progress)
      }
      this.progressBuffer.clear()
    }
    if (this.removedBuffer.size > 0) {
      this.send(IpcEvent.DownloadRemoved, { ids: [...this.removedBuffer] })
      this.removedBuffer.clear()
    }
  }

  private notifyIfEnabled(title: string, body: string): void {
    if (!this.settings.get().notificationsEnabled) return
    // Best-effort: a notification must never break the event pipeline.
    try {
      notify(title, body)
    } catch {
      /* ignore */
    }
  }

  private queueTerminalNotification(kind: 'completed' | 'failed', detail: string): void {
    if (kind === 'completed') {
      if (!this.settings.get().notifyOnDownloadComplete) return
      this.terminalNotification.completed.push(detail)
    } else {
      this.terminalNotification.failed += 1
      if (!this.terminalNotification.firstFailure) this.terminalNotification.firstFailure = detail
    }
    if (this.terminalNotificationTimer) return
    this.terminalNotificationTimer = setTimeout(() => {
      this.terminalNotificationTimer = null
      const completed = this.terminalNotification.completed.splice(0)
      const failed = this.terminalNotification.failed
      const firstFailure = this.terminalNotification.firstFailure
      this.terminalNotification.failed = 0
      this.terminalNotification.firstFailure = ''
      if (completed.length === 1 && failed === 0) {
        this.notifyIfEnabled('Download complete', `${completed[0]} finished downloading`)
      } else if (completed.length === 0 && failed === 1) {
        this.notifyIfEnabled('Download failed', firstFailure)
      } else {
        const title = failed > 0 ? 'Downloads finished' : 'Downloads complete'
        const body = `${completed.length} completed, ${failed} failed. Check Moth for details.`
        this.notifyIfEnabled(title, body)
      }
    }, TERMINAL_NOTIFICATION_WINDOW_MS)
    this.terminalNotificationTimer.unref?.()
  }

  /** Sends to the renderer, tolerating a destroyed window. */
  send(channel: string, payload: unknown): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    try {
      window.webContents.send(channel, payload)
    } catch (err) {
      log.debug('Failed to send to renderer', { channel, error: err })
    }
  }
}

export type { EngineStats, SpeedSample }
