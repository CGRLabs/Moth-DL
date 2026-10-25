/**
 * Extension-based auto-categorisation and destination routing.
 *
 * Pure functions with no filesystem or Electron dependency, which keeps them
 * trivially unit-testable and reusable by a future plugin.
 */

import { extname, isAbsolute, resolve } from 'node:path'
import { CATEGORY_EXTENSIONS } from '@shared/constants.js'
import type { DownloadCategory } from '@shared/types.js'
import { sanitizeSegment } from './paths.js'

/** Compound extensions that must be checked before the bare extension. */
const COMPOUND_EXTENSIONS: ReadonlyArray<readonly [string, DownloadCategory]> = [
  ['tar.gz', 'archive'],
  ['tar.bz2', 'archive'],
  ['tar.xz', 'archive'],
  ['tar.zst', 'archive'],
  ['tar.lzma', 'archive'],
  ['user.js', 'other'],
  ['js.map', 'other']
]

/** Returns the lowercase extension without the leading dot. */
export function extensionOf(filenameOrUrl: string): string {
  let value = filenameOrUrl.trim()
  // Strip query string and fragment before looking at the extension.
  const cut = value.search(/[?#]/)
  if (cut !== -1) value = value.slice(0, cut)
  // Take the last path segment so directories containing dots do not confuse us.
  value = value.split(/[\\/]/).pop() ?? value
  const ext = extname(value)
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : ext.toLowerCase()
}

/** Maps a filename or URL to a category. Unknown types fall back to `other`. */
export function categorize(input: string): DownloadCategory {
  const lowered = input.trim().toLowerCase()
  const stripped = lowered.replace(/[?#].*$/, '')
  const base = (stripped.split(/[\\/]/).pop() ?? stripped)

  for (const [suffix, category] of COMPOUND_EXTENSIONS) {
    if (base.endsWith(suffix)) return category
  }

  const ext = extensionOf(base)
  if (!ext) return 'other'

  for (const category of Object.keys(CATEGORY_EXTENSIONS) as DownloadCategory[]) {
    if (CATEGORY_EXTENSIONS[category].includes(ext)) return category
  }
  return 'other'
}

/** Best-effort category from a `Content-Type` header, for extension-less URLs. */
export function categorizeContentType(contentType: string | null | undefined): DownloadCategory | null {
  if (!contentType) return null
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!type) return null

  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('text/')) return 'document'
  if (type === 'application/pdf') return 'document'
  if (type === 'application/msword' || type === 'application/vnd.ms-excel') return 'document'
  if (
    type === 'application/zip' ||
    type === 'application/x-tar' ||
    type === 'application/gzip' ||
    type === 'application/x-7z-compressed' ||
    type === 'application/x-rar-compressed' ||
    type === 'application/x-iso9660-image'
  ) {
    return 'archive'
  }
  if (type === 'application/x-msdownload' || type === 'application/vnd.microsoft.portable-executable') {
    return 'executable'
  }
  if (type === 'application/vnd.ms-package' || type === 'application/x-msi') return 'installer'
  return null
}

/**
 * Final category decision: an explicit user choice always wins, then the file
 * extension, then the content type.
 */
export function resolveCategory(options: {
  filename: string
  contentType?: string | null
  explicit?: DownloadCategory | null
  autoCategorize: boolean
}): DownloadCategory {
  if (!options.autoCategorize) return 'other'
  if (options.explicit) return options.explicit
  const byExtension = categorize(options.filename)
  if (byExtension !== 'other') return byExtension
  return categorizeContentType(options.contentType) ?? 'other'
}

/**
 * Builds the directory a finished file should land in.
 * Returns the root itself when auto-categorisation is off.
 */
export function resolveDestinationDirectory(options: {
  root: string
  category: DownloadCategory
  categoryFolders: Record<DownloadCategory, string>
  autoCategorize: boolean
  separator: string
}): string {
  if (!options.autoCategorize) return options.root
  const folder = options.categoryFolders[options.category] ?? 'Other'
  if (isAbsolute(folder)) return resolve(folder)
  const safe = sanitizeSegment(folder, 'Other')
  return `${options.root.replace(/[\\/]+$/, '')}${options.separator}${safe}`
}
