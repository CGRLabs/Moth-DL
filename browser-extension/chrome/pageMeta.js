/**
 * Page metadata extraction for the Moth media badge.
 *
 * Pure apart from the supplied document, so tests pass a fake object that
 * only implements `querySelectorAll`.
 *
 * Only `querySelectorAll` is used (never `querySelector`) so fakes stay tiny.
 * Every returned string is cleaned, entity-decoded and capped; fields the
 * page does not provide stay `undefined`, matching the `MediaHint` contract
 * in `src/shared/media.ts` (extra `undefined` keys are dropped by JSON).
 */

(function installMothPageMeta(root) {
const { MAX_LEN, cleanText, parseYear, parseTrack } = root.MothMetaText

const MUSIC_TYPES = ['musicrecording', 'musicalbum', 'audioobject', 'videoobject']

/**
 * Artist-ish values are polymorphic: a plain string, `{ name }`, or an
 * array of either. First non-empty name wins.
 */
function nameOf(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const name = nameOf(item)
      if (name !== undefined) return name
    }
    return undefined
  }
  if (typeof value === 'string') return cleanText(value)
  if (typeof value === 'object' && value !== null) {
    if (typeof value.name === 'string') return cleanText(value.name)
    if (Array.isArray(value.name)) return nameOf(value.name)
  }
  return undefined
}

/** Image values mirror names: URL string, `{ url }`, or an array of those. */
function imageOf(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = imageOf(item)
      if (image !== undefined) return image
    }
    return undefined
  }
  if (typeof value === 'string') return cleanText(value)
  if (typeof value === 'object' && value !== null) {
    if (typeof value.url === 'string') return cleanText(value.url)
    if (typeof value.contentUrl === 'string') return cleanText(value.contentUrl)
  }
  return undefined
}

/** Flatten one JSON-LD script payload: bare object, array, or `@graph`. */
function flattenJsonLd(payload, out) {
  if (Array.isArray(payload)) {
    for (const item of payload) flattenJsonLd(item, out)
    return
  }
  if (typeof payload === 'object' && payload !== null) {
    out.push(payload)
    if (Array.isArray(payload['@graph'])) {
      for (const item of payload['@graph']) flattenJsonLd(item, out)
    }
  }
}

function nodeTypes(node) {
  const raw = node['@type']
  const list = Array.isArray(raw) ? raw : [raw]
  return list.filter((type) => typeof type === 'string').map((type) => type.toLowerCase())
}

function isMusicNode(node) {
  return nodeTypes(node).some((type) => MUSIC_TYPES.includes(type))
}

function isAlbumNode(node) {
  return nodeTypes(node).includes('musicalbum')
}

function queryAll(document, selector) {
  try {
    const found = document.querySelectorAll(selector)
    return Array.from(found || [])
  } catch {
    return []
  }
}

function attr(element, name) {
  try {
    if (element && typeof element.getAttribute === 'function') return element.getAttribute(name)
  } catch {
    return undefined
  }
  return element ? element[name] : undefined
}

function textOf(element) {
  if (!element || typeof element !== 'object') return undefined
  if (typeof element.textContent === 'string' && element.textContent) return element.textContent
  if (typeof element.text === 'string') return element.text
  return undefined
}

/** First `content` attribute among elements matching a meta selector. */
function metaContent(document, selector) {
  const elements = queryAll(document, selector)
  for (const element of elements) {
    const cleaned = cleanText(attr(element, 'content'))
    if (cleaned !== undefined) return cleaned
  }
  return undefined
}

function resolveUrl(raw, base) {
  if (raw === undefined) return undefined
  if (!base) return raw
  try {
    return new URL(raw, base).href.slice(0, MAX_LEN)
  } catch {
    return raw
  }
}

/**
 * Filename fallback from a media URL: `Artist - Title.ext` splits on a
 * space-padded dash; a bare name becomes the title. Query and fragment
 * carry session state, never the name, so they are stripped first.
 */
function inferFromFilename(mediaUrl, into) {
  if (typeof mediaUrl !== 'string' || !mediaUrl) return
  let path = mediaUrl.split('#')[0].split('?')[0]
  try {
    path = decodeURIComponent(path)
  } catch {
    /* keep the raw path; a bad escape is not worth losing the name */
  }
  const segment = path.split('/').filter(Boolean).pop()
  if (!segment) return
  const stem = segment.includes('.') ? segment.slice(0, segment.lastIndexOf('.')) : segment
  const dash = stem.indexOf(' - ')
  if (dash >= 0) {
    if (into.artist === undefined) into.artist = cleanText(stem.slice(0, dash))
    if (into.title === undefined) into.title = cleanText(stem.slice(dash + 3))
  } else if (into.title === undefined) {
    into.title = cleanText(stem)
  }
}

/**
 * Extract page metadata for a `MediaHint`.
 * @param {any} document page (or test fake) exposing `querySelectorAll`
 * @param {string} [url] page URL: resolves relative images, seeds filename
 */
function extractPageMetadata(document, url) {
  /** @type {{ title: string|undefined, artist: string|undefined, album: string|undefined, albumArtist: string|undefined, year: number|undefined, track: number|undefined, pageImage: string|undefined }} */
  const into = {
    title: undefined,
    artist: undefined,
    album: undefined,
    albumArtist: undefined,
    year: undefined,
    track: undefined,
    pageImage: undefined
  }
  if (!document || typeof document.querySelectorAll !== 'function') {
    inferFromFilename(url, into)
    return into
  }

  // 1. JSON-LD: every script block, flattened, first non-empty wins per field.
  // Malformed blocks are page bugs, not ours; skip them silently.
  for (const script of queryAll(document, 'script[type="application/ld+json"]')) {
    let payload
    try {
      payload = JSON.parse(textOf(script) || '')
    } catch {
      continue
    }
    const nodes = []
    flattenJsonLd(payload, nodes)
    for (const node of nodes) {
      if (!isMusicNode(node)) continue
      if (into.title === undefined) into.title = cleanText(node.name)
      const credit = nameOf(node.byArtist)
      if (into.artist === undefined) into.artist = credit
      if (into.albumArtist === undefined) {
        into.albumArtist = nameOf(node.albumArtist) || (isAlbumNode(node) ? credit : undefined)
      }
      if (into.album === undefined) {
        into.album = nameOf(node.inAlbum) || cleanText(node.albumName) || nameOf(node.album)
      }
      if (into.year === undefined) {
        into.year = parseYear(node.datePublished) ?? parseYear(node.dateCreated)
      }
      if (into.track === undefined) into.track = parseTrack(node.trackNumber)
      if (into.pageImage === undefined) {
        into.pageImage = imageOf(node.thumbnailUrl) ?? imageOf(node.image)
      }
    }
  }

  // 2. OpenGraph. `og:video`/`og:audio` name the media file itself, which the
  // badge already reads off the element, so only descriptive tags apply here.
  if (into.title === undefined) into.title = metaContent(document, 'meta[property="og:title"]')
  if (into.pageImage === undefined) into.pageImage = metaContent(document, 'meta[property="og:image"]')
  if (into.artist === undefined) into.artist = metaContent(document, 'meta[property="og:site_name"]')

  // 3. Plain meta/link/title fallbacks.
  if (into.artist === undefined) into.artist = metaContent(document, 'meta[name="author"]')
  if (into.pageImage === undefined) {
    const links = queryAll(document, 'link[rel="image_src"]')
    for (const link of links) {
      const cleaned = cleanText(attr(link, 'href'))
      if (cleaned !== undefined) {
        into.pageImage = cleaned
        break
      }
    }
  }
  if (into.title === undefined) {
    const titles = queryAll(document, 'title')
    if (titles.length > 0) into.title = cleanText(textOf(titles[0]))
  }

  // 4. Filename inference fills whatever is still missing.
  inferFromFilename(url, into)

  if (into.pageImage !== undefined) into.pageImage = resolveUrl(into.pageImage, url)
  return into
}

root.MothPageMeta = { extractPageMetadata }
})(globalThis)
