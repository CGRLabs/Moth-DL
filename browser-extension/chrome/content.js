/**
 * Content script: hover badge over in-page media, send grabs to Moth.
 *
 * Detection runs entirely in-page (mouseover plus a throttled
 * MutationObserver), so no `<all_urls>` permission is needed; the only
 * network call goes through the service worker, keeping the pairing token
 * out of page context.
 */

(function installMothContentScript(root) {
const { extractPageMetadata } = root.MothPageMeta
const {
  isGrabbableUrl,
  mediaKindForUrl,
  mediaElementsIn,
  collectVariants,
  discoverPageMedia,
  captureFormatOptions,
  buildDeepLink
} = root.MothMediaProbe
const { createBadge } = root.MothBadge
const { prefs, badgeDisabled, watchPrefs } = root.MothBadgePrefs

// `chrome` in Chrome, `browser` in Firefox; identical behaviour otherwise.
const extApi = root.chrome ?? root.browser

const SCAN_THROTTLE_MS = 500
const MEDIA_SELECTOR = 'video,audio'

const drmElements = new WeakSet()
const wiredElements = new WeakSet()

let badge = null
let currentAnchor = null

function host() {
  try {
    return window.location.hostname
  } catch {
    return ''
  }
}

function isYouTubePage() {
  const name = host().toLowerCase()
  return ['youtube.com', 'youtube-nocookie.com'].some(
    (domain) => name === domain || name.endsWith(`.${domain}`)
  )
}

function mediaUrlOf(element) {
  const tag = (element.tagName || '').toLowerCase()
  if (tag === 'video' || tag === 'audio') {
    // `currentSrc`, not `src`: under MSE the real URL only appears there
    // once playback starts, and `src` may be an empty stub.
    try {
      if (typeof element.currentSrc === 'string' && element.currentSrc) return element.currentSrc
    } catch {
      /* fall through to src */
    }
    return element.src || ''
  }
  if (tag === 'a') {
    try {
      return element.href || ''
    } catch {
      return ''
    }
  }
  return ''
}

function anchorFor(target) {
  if (!target || typeof target.closest !== 'function') return null
  const media = target.closest(MEDIA_SELECTOR)
  if (media) return media
  const link = target.closest('a[href]')
  if (link) {
    try {
      if (mediaKindForUrl(link.href) !== null) return link
    } catch {
      return null
    }
  }
  return null
}

/** One-time listeners per element; `currentSrc` is re-read on metadata. */
function wireElement(element) {
  if (!element || wiredElements.has(element)) return
  wiredElements.add(element)
  const tag = (element.tagName || '').toLowerCase()
  if (tag !== 'video' && tag !== 'audio') return
  // DRM is observable, not bypassable: `encrypted` fires when the element
  // binds a CDM. Mark it and refuse later, plainly.
  element.addEventListener('encrypted', () => {
    drmElements.add(element)
  })
  element.addEventListener('loadedmetadata', () => {
    if (currentAnchor === element && badge && badgeDisabled(host(), mediaUrlOf(element))) {
      currentAnchor = null
      badge.hide()
      return
    }
    if (currentAnchor === element && badge) {
      try {
        badge.showAt(element.getBoundingClientRect(), element)
      } catch {
        /* detached mid-load; the next hover re-anchors */
      }
    }
  })
  if (isYouTubePage()) {
    const keepBadgeForPlayback = () => {
      if (currentAnchor === element && badge) {
        let hovered = false
        try {
          hovered = element.matches(':hover')
        } catch {
          /* detached media is treated as no longer hovered */
        }
        if (!hovered) {
          currentAnchor = null
          badge.hide()
        }
      }
    }
    element.addEventListener('play', () => {
      currentAnchor = element
      try {
        badge?.showAt(element.getBoundingClientRect(), element)
      } catch {
        /* detached mid-play; the next hover re-anchors */
      }
    })
    element.addEventListener('pause', keepBadgeForPlayback)
    element.addEventListener('ended', keepBadgeForPlayback)
  }
}

function guessFilename(url) {
  return globalThis.MothTransferPolicy.filenameForUrl(url)
}

function onActivate() {
  if (!currentAnchor || !badge) return
  const tag = (currentAnchor.tagName || '').toLowerCase()
  const isMediaElement = tag === 'video' || tag === 'audio'
  const url = mediaUrlOf(currentAnchor)
  // DRM is observable, not bypassable: refuse plainly, never offer capture.
  if (drmElements.has(currentAnchor)) {
    badge.setRefusal('DRM-protected — Moth will not bypass it.')
    return
  }
  if (isMediaElement && (isYouTubePage() || !isGrabbableUrl(url))) {
    // Page resolution handles MSE playback and lets yt-dlp choose real streams
    // instead of sending a transient player URL as an ordinary file.
    const pageUrl = window.location.href
    badge.showPicker(
      captureFormatOptions().map((option) => ({
        url: pageUrl,
        kind: option.kind || option.format,
        format: option.format,
        videoQuality: option.videoQuality,
        label: option.label,
        isCurrent: false
      })),
      (pick) => {
        currentAnchor = null
        badge.hide()
        sendUrl(pick.url, pick.format, pick.videoQuality)
      }
    )
    return
  }
  if (url && !isGrabbableUrl(url)) {
    badge.setRefusal("Can't grab this — no downloadable file here.")
    return
  }
  if (!isGrabbableUrl(url)) {
    badge.setRefusal("Can't grab this — no downloadable file here.")
    return
  }
  // Several discrete files behind one element: let the user pick instead of
  // guessing. A lone URL keeps the old one-click path.
  const variants = collectVariants(currentAnchor, document.baseURI)
  if (variants.length > 1) {
    badge.showPicker(variants, (pick) => {
      currentAnchor = null
      badge.hide()
      sendUrl(pick.url)
    })
    return
  }
  sendUrl(url)
}

/**
 * Cold-start fallback: when the app is not running the POST fails, so hand
 * the URL to the OS, which launches Moth and queues the download on boot.
 * Only ever called on an explicit send failure — never speculatively, so a
 * sent download is never queued twice.
 */
function launchApp(url, format, videoQuality) {
  try {
    const link = buildDeepLink(url, format, videoQuality)
    if (link) window.location.href = link
  } catch {
    /* last resort spent; the toolbar badge already reports reachability */
  }
}

function sendUrl(url, format, videoQuality) {
  const meta = extractPageMetadata(document, url)
  const payload = {
    url,
    filename: guessFilename(url),
    referer: window.location.href,
    autoStart: true,
    ...(format === 'audio' || format === 'video' ? { format } : {}),
    ...(videoQuality ? { videoQuality } : {}),
    media: {
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      albumArtist: meta.albumArtist,
      year: meta.year,
      track: meta.track,
      pageImage: meta.pageImage
    }
  }
  try {
    const sending = extApi.runtime.sendMessage({ type: 'send', config: { port: prefs.port, token: prefs.token }, payload })
    // The worker replies { ok:false } when the app refused or is down; only
    // then fall back to the deep link. No reply means sent — never queue twice.
    if (sending && typeof sending.then === 'function') {
      sending.then(
        (reply) => {
          if (reply && reply.ok === false && reply.code !== 'POLICY_BLOCKED') launchApp(url, format, videoQuality)
        },
        () => launchApp(url, format, videoQuality)
      )
    }
  } catch {
    launchApp(url, format, videoQuality)
  }
}

function rescan() {
  try {
    for (const element of mediaElementsIn(document)) wireElement(element)
  } catch {
    /* a hostile page overriding querySelectorAll must not break the badge */
  }
}

function onMouseOver(event) {
  const anchor = anchorFor(event.target)
  if (!anchor) return
  if (badgeDisabled(host(), mediaUrlOf(anchor))) {
    currentAnchor = null
    badge?.hide()
    return
  }
  wireElement(anchor)
  currentAnchor = anchor
  try {
    badge.showAt(anchor.getBoundingClientRect(), anchor)
  } catch {
    /* detached node; ignore this pass */
  }
}

function onMouseOut(event) {
  if (!currentAnchor || !badge) return
  const next = event.relatedTarget
  try {
    if (next && currentAnchor.contains(next)) return
    if (next && next.closest && next.closest('.moth-media-badge,.moth-media-picker')) return
  } catch {
    /* fall through to hide */
  }
  if (
    isYouTubePage() &&
    (currentAnchor.tagName || '').toLowerCase() === 'video' &&
    currentAnchor.paused === false
  ) {
    return
  }
  currentAnchor = null
  badge.hide()
}

function init() {
  watchPrefs(() => {
    if (badge && currentAnchor && badgeDisabled(host(), mediaUrlOf(currentAnchor))) {
      currentAnchor = null
      badge.hide()
    }
  })

  badge = createBadge({ onActivate, prominent: isYouTubePage() })
  rescan()

  document.addEventListener('mouseover', onMouseOver, { capture: true })
  document.addEventListener('mouseout', onMouseOut, { capture: true })

  // Re-wire dynamically added media on a throttle so a chatty feed does
  // not re-scan on every keystroke.
  let scanTimer = 0
  const observer = new MutationObserver(() => {
    if (scanTimer) return
    scanTimer = window.setTimeout(() => {
      scanTimer = 0
      rescan()
    }, SCAN_THROTTLE_MS)
  })
  try {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true })
  } catch {
    /* body may not exist yet at document_idle on odd pages */
  }

  // Context-menu enrichment: the worker cannot read the DOM, so it asks
  // the tab and this single implementation answers.
  try {
    extApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'moth-page-meta') {
        sendResponse({ ok: true, media: extractPageMetadata(document, message.url || window.location.href) })
      }
      if (message && message.type === 'moth-discover-media') {
        const entries = performance.getEntriesByType('resource')
        const result = discoverPageMedia(document, document.baseURI, entries)
        const candidates = result.candidates.map((candidate) => ({ ...candidate, mode: 'direct' }))
        const resolverLabel = result.hasMediaSignal ? 'Try page resolver' : 'Try page resolver (best effort)'
        for (const option of captureFormatOptions()) {
          candidates.push({
            url: window.location.href,
            kind: option.kind || option.format,
            label: `${resolverLabel} · ${option.label}`,
            mode: 'resolve',
            format: option.format,
            ...(option.videoQuality ? { videoQuality: option.videoQuality } : {})
          })
        }
        sendResponse({ ok: true, pageUrl: window.location.href, candidates, hasMediaSignal: result.hasMediaSignal })
      }
      return false
    })
  } catch {
    /* messaging unavailable; badge sends still work */
  }
}

// Content scripts may be evaluated without a page context in tests.
if (typeof document !== 'undefined' && extApi && extApi.runtime) {
  init()
}
})(globalThis)
