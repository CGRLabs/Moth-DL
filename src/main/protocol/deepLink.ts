/**
 * Deep-link parsing for the `moth://download` protocol.
 *
 * Link shape (frozen cross-stream contract):
 * `moth://download?url=<urlencoded>&format=<video|audio>`
 *
 * Pure module: no Electron, no Node, no side effects. The OS hands us an
 * attacker-influenced string (browser address bar, command line), so every
 * candidate is validated before it becomes a download: the outer scheme must
 * be exactly `moth`, the path must be `download`, the inner `url` must pass
 * the same http(s) schema the IPC layer enforces, and `format` defaults to
 * `video` when absent but rejects the whole link when unrecognised — silently
 * queuing a mistyped format as the wrong media kind would be worse than
 * dropping it.
 */

import { z } from 'zod'
import { httpUrlSchema, videoQualitySchema } from '@shared/schemas.js'
import type { VideoQuality } from '@shared/types.js'

export const DEEP_LINK_SCHEME = 'moth'
export const DEEP_LINK_PATH = 'download'

/** Media kind carried by the link. Matches `AddDownloadRequest.format`. */
export type DeepLinkFormat = 'video' | 'audio'

/** A validated deep link, ready for the orchestrator's glue to pass to `engine.add`. */
export interface DeepLinkRequest {
  url: string
  format: DeepLinkFormat
  videoQuality?: VideoQuality
}

/**
 * Status/register channels take no arguments. The union tolerates
 * `invoke(channel)` (payload `undefined`) and `invoke(channel, {})` alike;
 * anything else is stripped, since there is nothing for a caller to smuggle.
 */
export const emptyRequestSchema = z.union([z.undefined(), z.object({})])

const deepLinkPayloadSchema = z.object({
  url: httpUrlSchema,
  format: z.enum(['video', 'audio']),
  videoQuality: videoQualitySchema.optional()
})

/**
 * Finds the first `moth:` entry in an argv-style array.
 *
 * Electron delivers protocol launches as extra command-line arguments — both
 * for a cold start (`process.argv`) and for `second-instance` forwarding —
 * mixed in with flags and the exe path. Matching is deliberately loose here
 * (prefix only); `parseDeepLink` applies the strict validation afterwards.
 */
export function findDeepLinkInArgv(argv: readonly string[]): string | null {
  const prefix = `${DEEP_LINK_SCHEME}:`
  for (const arg of argv) {
    if (typeof arg !== 'string') continue
    const trimmed = arg.trim().replace(/^["']+|["']+$/g, '')
    if (trimmed.toLowerCase().startsWith(prefix)) return trimmed
  }
  return null
}

/**
 * Parses a deep link from a bare URL string or an argv array.
 *
 * Returns the validated request, or `null` for anything that is not an
 * `moth://download` link: garbage, wrong scheme, wrong path,
 * missing/non-http(s) inner URL, or an unrecognised `format`.
 */
export function parseDeepLink(raw: string | readonly string[]): DeepLinkRequest | null {
  const candidate = typeof raw === 'string' ? raw : Array.isArray(raw) ? findDeepLinkInArgv(raw) : null
  if (candidate === null) return null
  return parseDeepLinkUrl(candidate)
}

function parseDeepLinkUrl(candidate: string): DeepLinkRequest | null {
  let parsed: URL
  try {
    parsed = new URL(candidate.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null
  if (!isDownloadPath(parsed)) return null

  const inner = parsed.searchParams.get('url')
  if (inner === null || inner.trim().length === 0) return null

  let format: DeepLinkFormat = 'video'
  const formatRaw = parsed.searchParams.get('format')
  if (formatRaw !== null && formatRaw.trim().length > 0) {
    const lowered = formatRaw.trim().toLowerCase()
    if (lowered !== 'video' && lowered !== 'audio') return null
    format = lowered
  }

  const videoQualityRaw = parsed.searchParams.get('videoQuality')
  const videoQuality =
    videoQualityRaw !== null && videoQualityRaw.trim().length > 0
      ? Number(videoQualityRaw)
      : undefined

  // The inner URL goes through the same http(s) schema the IPC layer uses,
  // so a deep link can never queue what `addDownload` itself would refuse.
  const result = deepLinkPayloadSchema.safeParse({
    url: inner.trim(),
    format,
    ...(videoQuality !== undefined ? { videoQuality } : {})
  })
  if (!result.success) return null
  return {
    url: result.data.url,
    format: result.data.format,
    ...(result.data.videoQuality !== undefined ? { videoQuality: result.data.videoQuality } : {})
  }
}

/**
 * Accepts `moth://download` (host form) and `moth:download` (opaque form —
 * some launchers strip the slashes). Anything else — another host, a
 * sub-path, credentials, a port — is not our link.
 */
function isDownloadPath(parsed: URL): boolean {
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return false
  if (parsed.host.toLowerCase() === DEEP_LINK_PATH) {
    return parsed.pathname === '' || parsed.pathname === '/'
  }
  if (parsed.host === '') {
    return parsed.pathname.replace(/^\/+|\/+$/g, '').toLowerCase() === DEEP_LINK_PATH
  }
  return false
}
