/**
 * Text cleaning for page metadata.
 *
 * Shared by pageMeta.js so entity/whitespace/length rules live in exactly
 * one place. Pure and dependency-free.
 */

(function installMothMetaText(root) {
/** Hard cap: tag blobs in the wild are unbounded, hints must not be. */
const MAX_LEN = 512

/** Named entities seen in the wild; anything else is left verbatim. */
const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
  nbsp: ' '
}

/**
 * Decode HTML entities without a DOM parser (there is none in a worker or
 * in Node, and creating elements from page strings would run scripts).
 */
function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(1), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const known = ENTITY_MAP[body]
    return known === undefined ? match : known
  })
}

/**
 * Normalise one free-text value: entities, whitespace, length cap.
 * Returns `undefined` for missing or blank input, never null or ''.
 */
function cleanText(value) {
  if (typeof value !== 'string') return undefined
  const collapsed = decodeEntities(value).replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  return collapsed.slice(0, MAX_LEN)
}

/** First 4-digit year found in a date string; ISO dates sort this way. */
function parseYear(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const year = Math.floor(value)
    return year >= 1000 && year <= 9999 ? year : undefined
  }
  if (typeof value !== 'string') return undefined
  const found = value.match(/(\d{4})/)
  if (!found) return undefined
  const year = parseInt(found[1], 10)
  return year >= 1000 && year <= 9999 ? year : undefined
}

/** Track numbers arrive as `3`, `"3"` or `"3/12"`; take the leading integer. */
function parseTrack(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const track = Math.floor(value)
    return track > 0 ? track : undefined
  }
  if (typeof value !== 'string') return undefined
  const found = value.match(/\d+/)
  if (!found) return undefined
  const track = parseInt(found[0], 10)
  return track > 0 ? track : undefined
}

root.MothMetaText = { MAX_LEN, decodeEntities, cleanText, parseYear, parseTrack }
})(globalThis)
