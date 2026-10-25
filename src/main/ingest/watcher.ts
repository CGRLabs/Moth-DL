/**
 * Watches the download folder for browser downloads.
 *
 * Why this exists: the browser extension is the *reliable* way to hand a URL to
 * Moth, but a user may install Moth after already starting a download, or may
 * decline the extension. Browsers write their in-progress files with a
 * recognisable temporary suffix, so watching for those is the standard
 * "adopt what the browser already started" technique used by commercial
 * download managers.
 *
 * Scope, stated honestly:
 *  - It can tell you a browser download exists and where, and it offers to take
 *    it over. It CANNOT recover the original URL: that lives only in the
 *    browser's history database, and reading another application's SQLite file
 *    while it holds it locked is unreliable and invasive. So an adopted entry
 *    is surfaced as an "adopt" prompt, not silently re-downloaded.
 *  - This is opt-in and off by default.
 */

import { mkdirSync, watch, statSync, type FSWatcher } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { getLogger } from '../util/logger.js'

const log = getLogger('ingest.watcher')

/** Temporary suffixes the major browsers use while a download is in flight. */
const PARTIAL_SUFFIXES = ['.crdownload', '.part', '.partial', '.download', '.tmp', '.opdownload']

export interface DetectedDownload {
  path: string
  filename: string
  /** Bytes written so far, when known. */
  size: number
  detectedAt: number
}

export interface FolderWatcherOptions {
  /** Folders to monitor. Defaults to the configured download directory. */
  folders?: string[]
  onDetected: (download: DetectedDownload) => void
  /** Debounce window, so one file is reported once. */
  debounceMs?: number
}

export class FolderWatcher {
  private watchers: FSWatcher[] = []
  private readonly reported = new Map<string, number>()
  private readonly debounceMs: number
  folders: string[] = []
  private readonly configuredFolders: string[]

  constructor(private readonly options: FolderWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 4000
    this.configuredFolders = options.folders ?? []
  }

  start(): void {
    if (this.watchers.length > 0) return
    for (const folder of this.configuredFolders) {
      try {
        mkdirSync(folder, { recursive: true })
        const watcher = watch(folder, { persistent: false }, (_event, filename) => {
          if (!filename) return
          this.onEntry(folder, filename.toString())
        })
        watcher.on('error', (err) => {
          log.warn('Folder watcher error', { folder, error: err })
        })
        this.watchers.push(watcher)
        this.folders.push(folder)
        log.info('Watching folder for browser downloads', { folder })
      } catch (err) {
        log.warn('Could not watch folder', { folder, error: err })
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
    }
    this.watchers = []
    this.folders = []
  }

  private onEntry(folder: string, filename: string): void {
    const ext = extname(filename).toLowerCase()
    if (!PARTIAL_SUFFIXES.includes(ext)) return

    const fullPath = join(folder, filename)
    const now = Date.now()

    // Debounce: a single download fires many events as it grows.
    const last = this.reported.get(fullPath)
    if (last !== undefined && now - last < this.debounceMs) return

    // Bound the map so a long session cannot leak entries.
    if (this.reported.size > 500) {
      for (const [key, at] of this.reported) {
        if (now - at > this.debounceMs * 4) this.reported.delete(key)
      }
    }

    const display = basename(filename, ext)
    try {
      const size = statSync(fullPath).size
      // Browsers often create the partial file before writing its first byte.
      // Do not consume the debounce slot for that transient empty-file event.
      if (size === 0) return
      this.reported.set(fullPath, now)
      this.options.onDetected({ path: fullPath, filename: display, size, detectedAt: now })
    } catch {
      // The file vanished between the event and the stat; nothing to report.
    }
  }
}
