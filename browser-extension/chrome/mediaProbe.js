/**
 * Media-URL probing for the Moth badge.
 *
 * Pure and dependency-free.
 * The grabbable rules mirror the ingest server (`src/main/ingest/server.ts`
 * accepts only http/https) so the badge never offers what Moth will refuse.
 */

(function installMothMediaProbe(root) {
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'flv', 'avi'])
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus', 'aac', 'm4b'])
const MANIFEST_EXTS = new Set(['m3u8', 'mpd'])

function extOf(url) {
  const path = url.split('#')[0].split('?')[0]
  const segment = path.split('/').filter(Boolean).pop() || ''
  const dot = segment.lastIndexOf('.')
  if (dot < 0 || dot === segment.length - 1) return ''
  return segment.slice(dot + 1).toLowerCase()
}

/**
 * True only for URLs Moth can actually fetch: http(s) with a real host.
 * `blob:`/`data:` URLs are generated in-page with no stable source, and
 * anything else (`file:`, `javascript:`, …) the ingest endpoint refuses.
 */
function isGrabbableUrl(url) {
  if (typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!trimmed) return false
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/** Classify a media URL by file extension; null when not a known type. */
function mediaKindForUrl(url) {
  if (!isGrabbableUrl(url)) return null
  const ext = extOf(url.trim())
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return null
}

function manifestUrl(url) {
  if (!isGrabbableUrl(url)) return false
  return MANIFEST_EXTS.has(extOf(url.trim()))
}

function candidateLabel(url, kind) {
  try {
    const parsed = new URL(url)
    const filename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    return filename ? `${filename} · ${kind}` : `${parsed.hostname} · ${kind}`
  } catch {
    return `Media · ${kind}`
  }
}

/**
 * Finds explicit media URLs and reports whether page-level resolution may
 * help. This is only called on a user request; it does not poll the network.
 */
function discoverPageMedia(root, base, resourceEntries = []) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return { candidates: [], hasMediaSignal: false }
  }

  const candidates = []
  const seen = new Set()
  let hasMediaSignal = false
  const push = (raw, kind, allowExtensionless = false) => {
    const url = resolveUrl(raw, base)
    if (!url || seen.has(url) || !isGrabbableUrl(url) || manifestUrl(url)) return
    const detectedKind = mediaKindForUrl(url)
    if (!detectedKind && !allowExtensionless) return
    seen.add(url)
    candidates.push({
      url,
      kind: detectedKind || kind,
      label: candidateLabel(url, detectedKind || kind)
    })
  }

  const mediaElements = [...queryAll(root, 'video').slice(0, 200), ...queryAll(root, 'audio').slice(0, 200)]
  if (mediaElements.length) hasMediaSignal = true
  for (const element of mediaElements) {
    const tag = (element.tagName || '').toLowerCase()
    const kind = tag === 'audio' ? 'audio' : 'video'
    try {
      push(element.currentSrc, kind, true)
    } catch {
      /* inspect the declared sources below */
    }
    try {
      push(element.src, kind, true)
    } catch {
      /* inspect the declared sources below */
    }
    for (const source of queryAll(element, 'source')) {
      push(srcOf(source), kind, true)
    }
  }

  for (const anchor of queryAll(root, 'a[href]').slice(0, 500)) {
    const url = hrefOf(anchor)
    const kind = mediaKindForUrl(url)
    if (kind) push(url, kind)
  }

  for (const selector of ['meta[property="og:video"]', 'meta[name="twitter:player:stream"]', 'meta[property="og:audio"]']) {
    for (const meta of queryAll(root, selector).slice(0, 20)) {
      const content = meta && typeof meta.getAttribute === 'function' ? meta.getAttribute('content') : ''
      const kind = selector.includes('audio') ? 'audio' : 'video'
      if (content) {
        hasMediaSignal = true
        push(content, kind, true)
      }
    }
  }

  for (const entry of Array.isArray(resourceEntries) ? resourceEntries.slice(-1000) : []) {
    const kind = entry && (entry.initiatorType === 'audio' ? 'audio' : entry.initiatorType === 'video' ? 'video' : null)
    const url = entry && typeof entry.name === 'string' ? entry.name : ''
    const detectedKind = mediaKindForUrl(url)
    if (kind || detectedKind || manifestUrl(url)) hasMediaSignal = true
    if (detectedKind) push(url, detectedKind)
  }

  return { candidates: candidates.slice(0, 20), hasMediaSignal }
}

function hrefOf(element) {
  try {
    if (element && typeof element.getAttribute === 'function') {
      const raw = element.getAttribute('href')
      if (typeof raw === 'string' && raw) return raw
    }
  } catch {
    return ''
  }
  return typeof element?.href === 'string' ? element.href : ''
}

/** `<source>` carries its URL in `src`, never `href`. */
function srcOf(element) {
  try {
    if (element && typeof element.getAttribute === 'function') {
      const raw = element.getAttribute('src')
      if (typeof raw === 'string' && raw) return raw
    }
  } catch {
    return ''
  }
  return typeof element?.src === 'string' ? element.src : ''
}

function queryAll(root, selector) {
  try {
    return Array.from(root.querySelectorAll(selector) || [])
  } catch {
    return []
  }
}

/**
 * Collect grabbable media under `root`: every `video`/`audio` element plus
 * anchors whose href has a media extension. Plain page links are excluded
 * so the badge does not appear over ordinary navigation.
 */
function mediaElementsIn(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return []
  const found = [...queryAll(root, 'video'), ...queryAll(root, 'audio')]
  for (const anchor of queryAll(root, 'a[href]')) {
    if (mediaKindForUrl(hrefOf(anchor)) !== null) found.push(anchor)
  }
  return found
}

function resolveUrl(raw, base) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return ''
  try {
    return new URL(text, base || undefined).href
  } catch {
    return ''
  }
}

function sourceLabel(source, url, kind) {
  for (const name of ['label', 'title', 'data-quality', 'data-res']) {
    try {
      const value = source && typeof source.getAttribute === 'function'
        ? source.getAttribute(name)
        : null
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 64)
    } catch {
      /* hostile getters must not break the picker */
    }
  }
  try {
    const parsed = new URL(url)
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    if (last) return last.slice(0, 64)
    return `${parsed.hostname} · ${kind}`
  } catch {
    return kind
  }
}

/**
 * Capture-format rows for pages with no direct file (MSE/`blob:` playback).
 * Quality caps are sent to Moth's existing resolver; labels stay generic.
 */
function captureFormatOptions() {
  return [
    ...[360, 480, 720, 1080, 1440, 2160].map((videoQuality) => ({
      format: 'video',
      videoQuality,
      kind: `${videoQuality}p`,
      label: `Video · up to ${videoQuality}p`
    })),
    { format: 'audio', kind: 'MP3', label: 'Audio (MP3)' }
  ]
}

const DEEP_LINK_SCHEME = 'moth://download'

/**
 * Deep link the OS uses to cold-start Moth with a queued download.
 * Pure string building; the app's `parseDeepLink` is the matching reader.
 */
function buildDeepLink(pageUrl, format, videoQuality) {
  const url = typeof pageUrl === 'string' ? pageUrl.trim() : ''
  if (!url) return ''
  const params = new URLSearchParams({ url })
  if (format === 'audio' || format === 'video') params.set('format', format)
  if (
    format === 'video' &&
    [360, 480, 720, 1080, 1440, 2160].includes(videoQuality)
  ) {
    params.set('videoQuality', String(videoQuality))
  }
  return `${DEEP_LINK_SCHEME}?${params.toString()}`
}
/**
 * Quality variants offered by one media element: every grabbable discrete
 * file it references — `currentSrc` first (the playing default), then `src`,
 * then each `<source>` in document order — deduplicated by resolved URL.
 *
 * Manifest playlists and `blob:` stubs never appear: Moth cannot fetch those,
 * so offering them would be a lie. Sizes are deliberately absent — a HEAD
 * probe from page context is CORS-opaque cross-origin, so any number shown
 * would be a guess. Pure over a minimal element shape; `base` resolves
 * relative `<source src>` values (pass `document.baseURI` in-page).
 *
 * Anchors and unknown elements yield []: an anchor IS one URL, so there is
 * nothing to choose between and the caller sends it directly.
 */
function collectVariants(element, base) {
  const tag = (element && element.tagName ? element.tagName : '').toLowerCase()
  if (tag !== 'video' && tag !== 'audio') return []
  const seen = new Set()
  const variants = []
  const push = (raw, labelSource, isCurrent) => {
    const url = resolveUrl(raw, base)
    if (!url || seen.has(url)) return
    const kind = mediaKindForUrl(url)
    if (kind === null) return
    seen.add(url)
    variants.push({
      url,
      kind,
      label: labelSource ? sourceLabel(labelSource, url, kind) : sourceLabel(null, url, kind),
      isCurrent: isCurrent === true
    })
  }
  let current = ''
  try {
    if (typeof element.currentSrc === 'string') current = element.currentSrc.trim()
  } catch {
    current = ''
  }
  push(current, null, true)
  try {
    push(typeof element.src === 'string' ? element.src : '', null, false)
  } catch {
    /* fall through to sources */
  }
  for (const source of queryAll(element, 'source')) {
    push(srcOf(source), source, false)
  }
  // The playing URL keeps its flag even when a <source> row carried it.
  if (current) {
    const resolvedCurrent = resolveUrl(current, base)
    for (const variant of variants) {
      if (variant.url === resolvedCurrent) variant.isCurrent = true
    }
  }
  return variants
}

function experimentalSiteName(hostname) {
  const host = typeof hostname === 'string' ? hostname.toLowerCase().replace(/\.$/, '') : ''
  if (!host) return null
  if (host.includes('tiktok')) return 'tiktok'
  if (host.includes('facebook')) return 'facebook'
  if (host.includes('instagram')) return 'instagram'
  if (host.includes('x.com') || host.includes('twitter')) return 'twitter'
  return null
}

function discoverExperimentalSiteHints(root, base, resourceEntries = []) {
  const pageUrl = root && typeof root.location === 'object' && typeof root.location.href === 'string'
    ? root.location.href
    : base || ''
  let hostname = ''
  try {
    hostname = new URL(pageUrl).hostname
  } catch {
    hostname = ''
  }
  const siteName = experimentalSiteName(hostname)
  if (!siteName) {
    return { adapters: [], hasExperimentalSignal: false }
  }

  const { candidates, hasMediaSignal } = discoverPageMedia(root, base, resourceEntries)
  if (!hasMediaSignal && candidates.length === 0) {
    return { adapters: [], hasExperimentalSignal: false }
  }

  return {
    adapters: [{
      id: `${siteName}-experimental`,
      site: siteName,
      host: hostname,
      enabled: false,
      reason: 'Experimental site adapter scaffold; retained for future site-specific extraction work and kept off by default.',
      candidates: candidates.slice(0, 10)
    }],
    hasExperimentalSignal: true
  }
}

root.MothMediaProbe = {
  isGrabbableUrl,
  mediaKindForUrl,
  mediaElementsIn,
  collectVariants,
  discoverPageMedia,
  discoverExperimentalSiteHints,
  captureFormatOptions,
  buildDeepLink
}
})(globalThis)
