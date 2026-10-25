/**
 * Destination resolution: where a finished file should land on disk.
 *
 * Separated from the task so the same rules apply to the initial add, to
 * recovery, and to a future reorganisation feature. Every result is passed
 * through `resolveWithin`, so a crafted URL or `Content-Disposition` can never
 * make Moth write outside the configured download root.
 */

import { sep } from 'node:path'
import type { AppSettings, Download, DownloadCategory } from '@shared/types.js'
import { resolveCategory, resolveDestinationDirectory } from './categorizer.js'
import {
  filenameFromUrl,
  partialPathFor,
  resolveWithin,
  sanitizeFilename,
  uniquePath
} from './paths.js'
import { getLogger } from './logger.js'

const log = getLogger('util.destination')

export interface DestinationResult {
  category: DownloadCategory
  finalPath: string
  tempPath: string
}

export interface ResolveOptions {
  download: Download
  url: string
  contentType?: string | null
  /** Resolved settings. Passed by value so this stays unit-testable. */
  settings: AppSettings
  /** Skip the collision check; recovery passes `true` to keep paths stable. */
  reuseExisting?: boolean
}

/**
 * Determines the category, the final path and the in-flight temp path.
 *
 * The category folder is only applied while auto-categorisation is enabled;
 * otherwise files land directly in the download root.
 */
export async function resolveDownloadDestination(options: ResolveOptions): Promise<DestinationResult> {
  const { download, settings: config } = options

  // An explicitly chosen destination always wins, and is treated as trusted
  // user input (it came from a directory picker) but still sanitised.
  if (download.finalPath) {
    const finalPath = download.finalPath
    return {
      category: download.category,
      finalPath,
      tempPath: download.tempPath || partialPathFor(finalPath)
    }
  }

  const root = config.downloadDirectory
  const category = resolveCategory({
    filename: download.filename,
    contentType: options.contentType ?? download.contentType,
    explicit: download.category === 'other' ? null : download.category,
    autoCategorize: config.autoCategorize
  })

  const rawName =
    download.filename && download.filename !== 'download'
      ? download.filename
      : filenameFromUrl(options.url)
  const filename = sanitizeFilename(rawName, 'download')

  const directory = resolveDestinationDirectory({
    root,
    category,
    categoryFolders: config.categoryFolders,
    autoCategorize: config.autoCategorize,
    separator: sep
  })

  // `resolveWithin` throws if the category folder or filename would escape.
  const target = resolveWithin(config.autoCategorize ? directory : root, filename)

  const finalPath = options.reuseExisting
    ? target
    : await uniquePath(target)

  if (options.reuseExisting) {
    log.debug('Reusing destination', { id: download.id, finalPath })
  }

  return {
    category,
    finalPath,
    tempPath: partialPathFor(finalPath)
  }
}
