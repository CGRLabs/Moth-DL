/**
 * Experimental site adapters live in a dedicated registry so they can be added,
 * tested, or removed independently from the stable direct-download and
 * YouTube-specific paths.
 *
 * The default behavior is conservative: these adapters are deliberately not
 * enabled unless someone explicitly turns them on. That keeps the core app
 * behaviour unchanged while leaving a clear extension point for future media
 * sources such as TikTok, Facebook, or other public media pages.
 */

export type SiteAdapterKind = 'video' | 'audio' | 'unknown'

export interface SiteAdapterExtractionContext {
  headers?: Record<string, string>
  pageHtml?: string
}

export interface SiteAdapterCandidate {
  url: string
  kind: SiteAdapterKind
  headers?: Record<string, string>
  filename?: string
  reason?: string
}

export interface SiteAdapter {
  id: string
  name: string
  enabled: boolean
  supportedHosts: string[]
  matches: (url: string) => boolean
  extract: (url: string, context?: SiteAdapterExtractionContext) => Promise<SiteAdapterCandidate | null>
  reason: string
}

const adapters = new Map<string, SiteAdapter>()

function hostMatches(hostname: string, candidates: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return candidates.some((candidate) => {
    const value = candidate.toLowerCase().replace(/\.$/, '')
    return host === value || host.endsWith(`.${value}`)
  })
}

function matchesHost(url: string, candidates: readonly string[]): boolean {
  try {
    const hostname = new URL(url).hostname
    return hostMatches(hostname, candidates)
  } catch {
    return false
  }
}

function inferKindFromUrl(url: string): SiteAdapterKind {
  const value = url.toLowerCase()
  if (/(?:\.mp4|\.m4v|\.webm|\.mkv|\.mov|\.avi|\.m3u8|\.mpd)(?:[?#]|$)/.test(value)) return 'video'
  if (/(?:\.mp3|\.aac|\.m4a|\.wav|\.ogg|\.opus|\.flac)(?:[?#]|$)/.test(value)) return 'audio'
  return 'unknown'
}

function resolveCandidateUrl(baseUrl: string, raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const candidate = new URL(trimmed, baseUrl)
    if (candidate.protocol === 'http:' || candidate.protocol === 'https:') return candidate.href
  } catch {
    // Ignore malformed candidate URLs; a hostile or partial page snippet is not
    // a valid media source for the download engine.
  }
  return null
}

function inferFilename(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const path = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    if (path) return path
  } catch {
    // Keep the raw URL path only when it is actually parseable.
  }
  return undefined
}

function collectHtmlCandidates(baseUrl: string, pageHtml: string | undefined): string[] {
  if (!pageHtml) return []
  const seen = new Set<string>()
  const matches: string[] = []
  const patterns = [
    /https?:\/\/[^\s"'<>]+\.(?:mp4|m4v|webm|mkv|mov|avi|mp3|m4a|aac|wav|ogg|opus|flac|m3u8|mpd)(?:\?[^\s"'<>]*)?/gi,
    /(?:playAddr|downloadAddr|video_url|videoUrl|src|srcUrl|stream_url|streamUrl|file_url|fileUrl|url)["']?\s*[:=]\s*["'](https?:\/\/[^"'\s<>]+)["']/gi,
    /(?:playAddr|downloadAddr|video_url|videoUrl|src|srcUrl|stream_url|streamUrl|file_url|fileUrl|url)["']?\s*[:=]\s*(https?:\/\/[^\s"'<>]+)/gi
  ]

  for (const pattern of patterns) {
    for (const match of pageHtml.matchAll(pattern)) {
      const raw = match[1] ?? match[0]
      const resolved = resolveCandidateUrl(baseUrl, raw)
      if (!resolved || seen.has(resolved)) continue
      seen.add(resolved)
      matches.push(resolved)
    }
  }

  return matches
}

function buildHtmlCandidate(baseUrl: string, pageHtml: string | undefined): SiteAdapterCandidate | null {
  const candidates = collectHtmlCandidates(baseUrl, pageHtml)
  const url = candidates[0]
  if (!url) return null
  const kind = inferKindFromUrl(url)
  return {
    url,
    kind,
    filename: inferFilename(url),
    reason: 'Candidate extracted from HTML by the experimental adapter layer.',
    headers: {
      Referer: baseUrl,
      'User-Agent': 'Mozilla/5.0 (compatible; MothExperimentalAdapter/1.0)'
    }
  }
}

const defaultExperimentalAdapters: SiteAdapter[] = [
  {
    id: 'facebook-experimental',
    name: 'Experimental Facebook adapter',
    enabled: false,
    supportedHosts: ['facebook.com', 'm.facebook.com', 'fb.watch'],
    matches: (url) => matchesHost(url, ['facebook.com', 'm.facebook.com', 'fb.watch']),
    extract: async (url, context) => buildHtmlCandidate(url, context?.pageHtml),
    reason: 'Disabled by default; future Facebook-specific extraction can live here.'
  },
  {
    id: 'tiktok-experimental',
    name: 'Experimental TikTok adapter',
    enabled: false,
    supportedHosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'],
    matches: (url) => matchesHost(url, ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']),
    extract: async (url, context) => buildHtmlCandidate(url, context?.pageHtml),
    reason: 'Disabled by default; future TikTok-specific extraction can live here.'
  },
  {
    id: 'instagram-experimental',
    name: 'Experimental Instagram adapter',
    enabled: false,
    supportedHosts: ['instagram.com', 'www.instagram.com', 'm.instagram.com'],
    matches: (url) => matchesHost(url, ['instagram.com', 'www.instagram.com', 'm.instagram.com']),
    extract: async (url, context) => buildHtmlCandidate(url, context?.pageHtml),
    reason: 'Disabled by default; future Instagram-specific extraction can live here.'
  }
]

export function registerSiteAdapter(adapter: SiteAdapter): void {
  adapters.set(adapter.id, adapter)
}

export function getSiteAdapters(): SiteAdapter[] {
  return [...adapters.values()]
}

export function resetSiteAdapters(): void {
  adapters.clear()
  for (const adapter of defaultExperimentalAdapters) {
    adapters.set(adapter.id, adapter)
  }
}

export function getEnabledSiteAdapterForUrl(url: string): SiteAdapter | null {
  const adapter = Array.from(adapters.values())
    .filter((candidate) => candidate.enabled)
    .find((candidate) => candidate.matches(url))

  return adapter ?? null
}

export async function resolveSiteAdapterCandidate(
  url: string,
  context: SiteAdapterExtractionContext = {}
): Promise<SiteAdapterCandidate | null> {
  const adapter = getEnabledSiteAdapterForUrl(url)
  if (!adapter) return null
  return adapter.extract(url, context)
}

resetSiteAdapters()
