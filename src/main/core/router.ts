import type { RemoteMetadata, VideoCaptureFormat } from '@shared/types.js'
import { getEnabledSiteAdapterForUrl } from './siteAdapters.js'
import { selectIfRangeValidator } from '../net/httpClient.js'
import { isTorrentSource } from '@shared/torrent.js'

export type SourceRoute =
  | { kind: 'direct-file'; transport: 'http'; reason: string }
  | { kind: 'site-adapter'; transport: 'site-adapter'; reason: string }
  | { kind: 'media-page'; transport: 'resolver'; reason: string }
  | { kind: 'youtube-page'; transport: 'yt-dlp'; reason: string }
  | { kind: 'torrent'; transport: 'transmission'; reason: string }

export type TransferRoute =
  | { strategy: 'parallel-ranges'; resumable: boolean; reason: string }
  | { strategy: 'single-stream'; resumable: boolean; reason: string }

/**
 * What a probed HTTP response says its source is.
 *
 * `undetermined` means the response carried no usable signal at all (no
 * content type and no size), so the caller must keep a URL-shape heuristic
 * rather than invent a routing decision.
 */
export type ProbedSourceKind = 'direct-file' | 'media-page' | 'undetermined'

const PAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/xhtml'
])

/**
 * Classifies a source from the response the server actually sent.
 *
 * `classifyUrl` can only read the URL text, and plenty of real download links
 * carry no file extension (`https://host/download/pc/` answers 302 with an
 * 800 MB installer). These rules use response evidence only, in priority order:
 *
 *   1. `Content-Disposition: attachment` — the server says "save this file".
 *   2. `text/html` / XHTML — the server says "this is a document".
 *   3. Any other declared content type is a file.
 *   4. No content type: a disclosed size is still a file, otherwise undetermined.
 */
export function classifyProbedResponse(
  metadata: Pick<RemoteMetadata, 'contentType' | 'contentDisposition' | 'size'>
): ProbedSourceKind {
  if (/^\s*attachment\b/i.test(metadata.contentDisposition ?? '')) return 'direct-file'

  const contentType = metadata.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (PAGE_CONTENT_TYPES.has(contentType)) return 'media-page'
  if (contentType !== '') return 'direct-file'
  return (metadata.size ?? 0) > 0 ? 'direct-file' : 'undetermined'
}

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return (
    host === 'youtu.be' ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com')
  )
}

export function isYouTubePage(pageUrl: string): boolean {
  try {
    return isYouTubeHost(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

export function routeSource(url: string, format?: VideoCaptureFormat): SourceRoute {
  if (isTorrentSource(url)) {
    return {
      kind: 'torrent',
      transport: 'transmission',
      reason: 'A BitTorrent magnet or .torrent URL uses the isolated Transmission torrent engine.'
    }
  }
  if (format === undefined) {
    return {
      kind: 'direct-file',
      transport: 'http',
      reason: 'No media-page format was requested; use the direct HTTP download path.'
    }
  }
  if (isYouTubePage(url)) {
    return {
      kind: 'youtube-page',
      transport: 'yt-dlp',
      reason: 'YouTube pages require yt-dlp to select, download, and merge media streams.'
    }
  }

  const siteAdapter = getEnabledSiteAdapterForUrl(url)
  if (siteAdapter) {
    return {
      kind: 'site-adapter',
      transport: 'site-adapter',
      reason: `${siteAdapter.name} is enabled and matched this URL; use the experimental site-adapter path.`
    }
  }

  return {
    kind: 'media-page',
    transport: 'resolver',
    reason: 'A media format was requested for a page; resolve its playable stream first.'
  }
}

export function routeTransfer(
  metadata: Pick<RemoteMetadata, 'size' | 'acceptRanges' | 'rangeUnsupported' | 'etag' | 'lastModified'>
): TransferRoute {
  const hasValidator = selectIfRangeValidator(metadata.etag, metadata.lastModified).value !== null
  if (metadata.acceptRanges && (metadata.size ?? 0) > 0) {
    return {
      strategy: 'parallel-ranges',
      resumable: hasValidator,
      reason: hasValidator
        ? 'The server supports ranges, disclosed its size, and provides a validator for safe resume.'
        : 'The server supports ranges and disclosed its size, but has no validator; interrupted progress will be discarded.'
    }
  }
  return {
    strategy: 'single-stream',
    resumable: false,
    reason: metadata.rangeUnsupported || metadata.acceptRanges === false
      ? 'The server does not support byte ranges; use one sequential stream.'
      : 'Range support or a usable file size was not confirmed; use one sequential stream.'
  }
}
