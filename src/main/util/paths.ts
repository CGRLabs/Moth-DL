/**
 * Filesystem path helpers with hard guarantees about containment.
 *
 * Two rules are enforced everywhere:
 *  1. A filename coming from a URL is never trusted; it is sanitised.
 *  2. A resolved destination is always verified to live inside the configured
 *     download root, so a hostile `Content-Disposition` or crafted URL cannot
 *     make Moth write outside it.
 */

import { constants as fsConstants } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { PARTIAL_SUFFIX } from '@shared/constants.js'
import { EngineError, fromFileSystemError } from './errors.js'

const ILLEGAL_FILENAME_CHARS = /[\x00-\x1f<>:"|?*\\/]/g
const RESERVED_WINDOWS_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const WINDOWS_TRAILING = /[. ]+$/

/** Maximum length of the stem, keeping the extension within Windows' 255 cap. */
const MAX_STEM_LENGTH = 200

/** Strips directory components, illegal characters and reserved names. */
export function sanitizeFilename(raw: string, fallback = 'download'): string {
  let name = raw

  // Defeat traversal and UNC prefixes outright.
  name = name.replace(/^[a-zA-Z]:[\\/]/, '')
  name = name.split(/[\\/]/).pop() ?? name

  name = name.replace(ILLEGAL_FILENAME_CHARS, '_')
  name = name.replace(WINDOWS_TRAILING, '')
  name = name.replace(/^\.+/, '')
  name = name.trim()

  if (!name) return fallback
  if (RESERVED_WINDOWS_NAMES.test(name)) name = `_${name}`
  if (name.length > 240) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ''
    name = name.slice(0, MAX_STEM_LENGTH) + ext
  }
  return name
}

/** Derives a filename from a URL's last path segment. */
export function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    if (segment) return sanitizeFilename(segment)
  } catch {
    /* fall through */
  }
  return sanitizeFilename('download')
}

/** Extracts a filename from a `Content-Disposition` header, RFC 5987 aware. */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null

  // filename*=UTF-8''name%20here  (preferred, handles non-ASCII)
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header)
  if (extended?.[2]) {
    try {
      return sanitizeFilename(decodeURIComponent(extended[2].trim()))
    } catch {
      /* malformed percent-encoding; try the plain form */
    }
  }

  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header)
  if (quoted?.[1]) return sanitizeFilename(quoted[1])

  const bare = /filename\s*=\s*([^;]+)/i.exec(header)
  if (bare?.[1]) return sanitizeFilename(bare[1].trim())

  return null
}

/** Sanitises a single path segment, e.g. a category folder name. */
export function sanitizeSegment(raw: string, fallback = 'Other'): string {
  const cleaned = sanitizeFilename(raw, fallback)
  return cleaned === '.' || cleaned === '..' ? fallback : cleaned
}

/**
 * Asserts that `candidate` resolves inside `root`.
 * Returns the resolved absolute path, or throws. Comparison is done on
 * normalised, case-insensitive paths to behave sanely on Windows.
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, ...segments)
  const rel = relative(absoluteRoot, target)
  const escapes = rel === '' ? false : rel.startsWith('..') || isAbsolute(rel)
  if (escapes) {
    throw new EngineError({
      code: 'INTERNAL',
      message: `Refusing to write outside the download directory: ${target}`,
      retryable: false
    })
  }
  return target
}

/** `true` when `child` is inside `parent`. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The in-flight path for a final destination. */
export function partialPathFor(finalPath: string): string {
  return `${finalPath}${PARTIAL_SUFFIX}`
}

/** Reverse of `partialPathFor`; tolerates paths that are already final. */
export function finalPathFromPartial(partialPath: string): string {
  return partialPath.endsWith(PARTIAL_SUFFIX)
    ? partialPath.slice(0, -PARTIAL_SUFFIX.length)
    : partialPath
}

/**
 * Resolves a collision-free destination: `a.zip` -> `a (1).zip`.
 * `existsFn` is injected so this stays testable without touching the disk.
 */
export async function uniquePath(
  desiredPath: string,
  existsFn: (path: string) => Promise<boolean> = pathExists
): Promise<string> {
  if (!(await existsFn(desiredPath))) return desiredPath

  const dir = desiredPath.slice(0, desiredPath.length - (desiredPath.split(sep).pop()?.length ?? 0))
  const base = desiredPath.split(sep).pop() ?? desiredPath
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''

  for (let n = 1; n < 10_000; n += 1) {
    const candidate = normalize(join(dir, `${stem} (${n})${ext}`))
    if (!(await existsFn(candidate))) return candidate
  }
  return normalize(join(dir, `${stem}-${Date.now()}${ext}`))
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch (err) {
    throw fromFileSystemError(err, path)
  }
}

export interface FileSizeInfo {
  exists: boolean
  size: number
  isDirectory: boolean
}

export async function inspectPath(path: string): Promise<FileSizeInfo> {
  try {
    const info = await stat(path)
    return { exists: true, size: info.size, isDirectory: info.isDirectory() }
  } catch {
    return { exists: false, size: 0, isDirectory: false }
  }
}

/**
 * Renames a file, falling back to copy+unlink across devices.
 * `overwrite` removes the destination first, which Windows requires anyway
 * (rename fails with EPERM/EBUSY when the target exists).
 */
export async function moveFile(from: string, to: string, overwrite = true): Promise<void> {
  if (overwrite && (await pathExists(to))) {
    await rm(to, { force: true }).catch((err: unknown) => {
      throw fromFileSystemError(err, to)
    })
  }
  try {
    await rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      // Cross-device: copy then unlink.
      const { copyFile } = await import('node:fs/promises')
      try {
        await copyFile(from, to)
        await rm(from, { force: true })
      } catch (copyErr) {
        throw fromFileSystemError(copyErr, to)
      }
      return
    }
    throw fromFileSystemError(err, from)
  }
}

export async function deleteFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch((err: unknown) => {
    throw fromFileSystemError(err, path)
  })
}

/** Truncates/creates a file to `size` bytes so positional writes can be sparse. */
export async function preallocate(filePath: string, size: number): Promise<void> {
  const { open } = await import('node:fs/promises')
  let handle
  try {
    handle = await open(filePath, 'a+')
    const info = await handle.stat()
    if (info.size < size) {
      // `truncate` extends the file with a hole; the OS allocates lazily.
      await handle.truncate(size)
    }
  } catch (err) {
    throw fromFileSystemError(err, filePath)
  } finally {
    await handle?.close()
  }
}
