/**
 * System tray and desktop integration.
 *
 * Keeps the app resident while downloads continue in the background, which is
 * the entire point of a download manager. The tray is created lazily and
 * guarded, because a missing AppUserModelId or an unavailable tray on Linux
 * must not prevent the window from opening.
 */

import { BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getLogger } from './util/logger.js'
import { formatRate } from './util/bytes.js'
import type { DownloadEngine } from './core/engine.js'
import type { SettingsStore } from './core/settingsStore.js'

const log = getLogger('tray')

export interface TrayController {
  tray: Tray | null
  update: () => void
  setToolTip: (text: string) => void
  destroy: () => void
}

/** Creates the tray icon, or returns a no-op controller if unavailable. */
export function createTray(options: {
  resourcesPath: string
  engine: DownloadEngine
  settings: SettingsStore
  getWindow: () => BrowserWindow | null
  onShow: () => void
  onQuit: () => void
}): TrayController {
  const iconPath = join(options.resourcesPath, 'trayIcon.png')
  let tray: Tray | null = null

  if (existsSync(iconPath)) {
    try {
      tray = new Tray(nativeImage.createFromPath(iconPath))
    } catch (err) {
      log.warn('Tray unavailable; continuing without it', { error: err })
    }
  } else {
    log.info('Tray icon not bundled; running without a tray', { iconPath })
  }

  const rebuild = (): void => {
    if (!tray) return
    const stats = options.engine.getStats()
    const settings = options.settings.get()
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: `Active: ${stats.activeDownloads}`, enabled: false },
      { label: `Speed: ${formatRate(stats.totalSpeed)}`, enabled: false },
      { type: 'separator' },
      { label: 'Show Moth', click: () => options.onShow() },
      { label: 'Pause all', click: () => options.engine.pauseAll() },
      { label: 'Resume all', click: () => options.engine.resumeAll() },
      { type: 'separator' }
    ]

    if (stats.activeDownloads > 0) {
      template.push({
        label: stats.globalSpeedLimit
          ? 'Remove global speed limit'
          : 'Set global speed limit…',
        click: () => {
          options.onShow()
        }
      })
    }

    template.push(
      { type: 'separator' },
      { label: 'Open downloads folder', click: () => void shell.openPath(options.settings.get().downloadDirectory) },
      { label: 'Quit Moth', click: () => options.onQuit() }
    )

    void settings
    try {
      tray.setContextMenu(Menu.buildFromTemplate(template))
      tray.setToolTip(
        stats.activeDownloads > 0
          ? `Moth — ${stats.activeDownloads} active, ${formatRate(stats.totalSpeed)}`
          : 'Moth Download Manager'
      )
    } catch (err) {
      log.debug('Tray refresh failed', { error: err })
    }
  }

  if (tray) {
    tray.on('click', () => options.onShow())
    tray.on('double-click', () => options.onShow())
  }

  const timer = setInterval(rebuild, 1000)
  if (typeof timer.unref === 'function') timer.unref()
  rebuild()

  return {
    tray,
    update: rebuild,
    setToolTip: (text: string) => {
      try {
        tray?.setToolTip(text)
      } catch {
        /* ignore */
      }
    },
    destroy: () => {
      clearInterval(timer)
      try {
        tray?.destroy()
      } catch {
        /* ignore */
      }
    }
  }
}

/** Keeps native window chrome aligned with the app's fixed dark palette. */
export function applyNativeTheme(nativeTheme: Electron.NativeTheme): void {
  nativeTheme.themeSource = 'dark'
}
