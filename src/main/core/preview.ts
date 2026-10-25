/**
 * URL preview for the URL-first Add dialog.
 *
 * Two stages, deliberately split:
 *   1. `classifyUrl` — instant, pure, no network. Host + extension heuristics
 *      decide whether the dialog offers a direct-file card or the Video/MP3
 *      choice. Unit-tested, never wrong-fatally: `page` just means "offer the
 *      choice", and the dialog always has a "not what you expected" escape.
 *   2. `previewUrl` — one `HEAD` (+ one-byte `GET` fallback inside `probe`),
 *      short timeout, to fill in filename/size/type/resumability for direct
 *      files. Known media hosts skip it: `yt-dlp -J` takes up to 45s and needs
 *      helper binaries, so those get the static choice immediately. Unknown
 *      hosts that only look like pages are probed once so an extension-less
 *      download link (`/download/pc/`) is recognised as the file it redirects
 *      to, and the engine resolves the rest after Add.
 */

import type { DownloadCategory, PreviewDownloadResult, PreviewKind, RemoteMetadata } from '@shared/types.js'
import { CATEGORY_EXTENSIONS } from '@shared/constants.js'
import { probe, probeRange } from '../net/httpClient.js'
import { categorize, categorizeContentType, extensionOf } from '../util/categorizer.js'
import { filenameFromUrl, sanitizeFilename } from '../util/paths.js'
import { getLogger } from '../util/logger.js'
import { classifyProbedResponse, routeTransfer } from './router.js'

const log = getLogger('core.preview')

/** Hosts that never serve the file itself — the page must be resolved first. */
const PAGE_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'vimeo.com',
  'www.vimeo.com',
  'tiktok.com',
  'www.tiktok.com',
  'vm.tiktok.com',
  'instagram.com',
  'www.instagram.com',
  'facebook.com',
  'www.facebook.com',
  'fb.watch',
  'x.com',
  'twitter.com',
  'www.x.com',
  'twitch.tv',
  'www.twitch.tv',
  'dailymotion.com',
  'www.dailymotion.com',
  'soundcloud.com',
  'www.soundcloud.com',
  'rumble.com',
  'www.rumble.com',
  'odysee.com',
  'bilibili.com',
  'www.bilibili.com'
] as const

const PAGE_PATH_HINTS = ['/watch', '/video/', '/videos/', '/reel', '/shorts', '/live', '/embed/']

const KNOWN_FILE_EXTS: ReadonlySet<string> = new Set(
  (Object.values(CATEGORY_EXTENSIONS) as string[][]).flat()
)

/**
 * Instant local classification. Pure — safe to call on every keystroke.
 * Unknown hosts with a known file extension are `direct`; known page hosts,
 * extension-less URLs and page-ish paths are `page`.
 *
 * URL text alone cannot separate `page` from `direct` for an extension-less
 * link, so `previewUrl` resolves that case with a probe instead of guessing.
 */
export function classifyUrl(raw: string): PreviewKind {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return 'direct'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'direct'
  const host = parsed.hostname.toLowerCase()
  if (isKnownPageHost(host)) return 'page'
  const ext = extensionOf(parsed.pathname)
  if (ext && KNOWN_FILE_EXTS.has(ext)) return 'direct'
  const path = parsed.pathname.toLowerCase()
  if (path === '/' || path === '' || PAGE_PATH_HINTS.some((hint) => path.includes(hint))) return 'page'
  if (!ext) return 'page'
  return 'direct'
}

function isKnownPageHost(host: string): boolean {
  if ((PAGE_HOSTS as readonly string[]).includes(host)) return true
  // Subdomains of page hosts (e.g. `music.youtube.com`) are pages too.
  return PAGE_HOSTS.some((pageHost) => host.endsWith(`.${pageHost}`))
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw.trim()).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export interface PreviewOptions {
  timeoutMs?: number
}

/** The card shown for a media page: no probe, the engine resolves after Add. */
function pagePreview(parsed: URL, url: string): PreviewDownloadResult {
  return {
    kind: 'page',
    finalUrl: url,
    host: parsed.hostname.toLowerCase(),
    filename: sanitizeFilename(filenameFromUrl(url)),
    fileSize: null,
    contentType: null,
    acceptRanges: false,
    resumeSupport: 'unknown',
    category: 'video',
    undetermined: true
  }
}

/** The card shown for a file the server confirmed, whether or not the URL said so. */
function directPreview(meta: RemoteMetadata, fallbackHost: string): PreviewDownloadResult {
  const finalHost = hostOf(meta.finalUrl)
  const filename = sanitizeFilename(filenameFromUrl(meta.finalUrl))
  const byExtension = categorize(filename)
  const category: DownloadCategory =
    byExtension !== 'other' ? byExtension : (categorizeContentType(meta.contentType) ?? 'other')
  return {
    kind: 'direct',
    finalUrl: meta.finalUrl,
    host: finalHost || fallbackHost,
    filename,
    fileSize: meta.size,
    contentType: meta.contentType,
    acceptRanges: meta.acceptRanges && !meta.rangeUnsupported,
    resumeSupport: meta.size === null
      ? 'unknown'
      : routeTransfer(meta).resumable
        ? 'safe'
        : 'restart',
    category,
    undetermined: meta.size === null && meta.contentType === null
  }
}

/**
 * Probes one URL for the dialog card. Never throws for network failures —
 * those become `{ undetermined: true }` so the dialog can still queue the URL.
 * Only throws for a non-http(s) URL (a programming error: the schema guards it).
 */
export async function previewUrl(url: string, options: PreviewOptions = {}): Promise<PreviewDownloadResult> {
  const trimmed = url.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Not a valid http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported')
  }

  const kind = classifyUrl(trimmed)
  const host = parsed.hostname.toLowerCase()

  if (kind === 'page') {
    // Known media hosts are pages by definition, so never spend a request on them.
    if (isKnownPageHost(host)) return pagePreview(parsed, trimmed)
    // An unknown host with no file extension is the ambiguous case the URL text
    // cannot settle: `https://host/download/pc/` is a redirect to an installer,
    // not a video page. One ranged request decides it from the response the
    // server sent, and also fills in the file details if it turns out to be one.
    try {
      const meta = await probeRange(trimmed, { timeoutMs: options.timeoutMs ?? 10_000 })
      if (classifyProbedResponse(meta) === 'direct-file') return directPreview(meta, host)
    } catch (err) {
      log.debug('Page-shaped URL probe failed, offering the media choice', {
        url: trimmed,
        error: err
      })
    }
    return pagePreview(parsed, trimmed)
  }

  try {
    const meta = await probe(trimmed, { timeoutMs: options.timeoutMs ?? 10_000 })
    return directPreview(meta, host)
  } catch (err) {
    log.debug('Preview probe failed, returning undetermined', { url: trimmed, error: err })
    return {
      kind,
      finalUrl: trimmed,
      host,
      filename: sanitizeFilename(filenameFromUrl(trimmed)),
      fileSize: null,
      contentType: null,
      acceptRanges: false,
      resumeSupport: 'unknown',
      category: categorize(filenameFromUrl(trimmed)),
      undetermined: true
    }
  }
}
