export interface MagnetInfo {
  uri: string
  /** The preferred identity: v1 for hybrid torrents, otherwise v2. */
  infoHash: string
  v1InfoHash: string | null
  v2InfoHash: string | null
  displayName: string | null
}

const V1_TOPIC = /^urn:btih:(?:[a-f\d]{40}|[a-z2-7]{32})$/i

export function parseMagnetUri(value: string): MagnetInfo | null {
  if (value.length > 4096) return null
  try {
    const magnet = new URL(value)
    if (magnet.protocol !== 'magnet:' || magnet.username || magnet.password) return null

    let v1InfoHash: string | null = null
    let v2InfoHash: string | null = null
    for (const topic of magnet.searchParams.getAll('xt')) {
      if (!v1InfoHash && V1_TOPIC.test(topic)) {
        const rawHash = topic.slice('urn:btih:'.length).toLowerCase()
        v1InfoHash = rawHash.length === 40 ? rawHash : decodeBase32(rawHash, 20)
      } else if (!v2InfoHash) {
        v2InfoHash = parseV2Topic(topic)
      }
    }
    const infoHash = v1InfoHash ?? v2InfoHash
    if (!infoHash) return null

    return {
      uri: magnet.href,
      infoHash,
      v1InfoHash,
      v2InfoHash,
      displayName: magnet.searchParams.get('dn')
    }
  } catch {
    return null
  }
}

export function isTorrentFileUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.pathname.toLowerCase().endsWith('.torrent')
  } catch {
    return false
  }
}

export function isTorrentSource(value: string): boolean {
  return parseMagnetUri(value) !== null ||
    isTorrentFileUrl(value) ||
    isImportedTorrentFileUri(value)
}

export function isImportedTorrentFileUri(value: string): boolean {
  return /^moth-torrent-file:[a-f\d]{64}$/i.test(value)
}

export function magnetUriForHash(hash: string): string | null {
  const normalized = hash.toLowerCase()
  if (/^[a-f\d]{40}$/.test(normalized)) return `magnet:?xt=urn:btih:${normalized}`
  if (/^[a-f\d]{64}$/.test(normalized)) return `magnet:?xt=urn:btmh:1220${normalized}`
  return null
}

function parseV2Topic(topic: string): string | null {
  const prefix = 'urn:btmh:'
  if (!topic.toLowerCase().startsWith(prefix)) return null
  const multihash = topic.slice(prefix.length).toLowerCase()
  if (/^1220[a-f\d]{64}$/.test(multihash)) return multihash.slice(4)
  if (!multihash.startsWith('b')) return null
  const decoded = decodeBase32Bytes(multihash.slice(1))
  if (!decoded || decoded.length !== 34 || decoded[0] !== 0x12 || decoded[1] !== 0x20) return null
  return Array.from(decoded.slice(2), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function decodeBase32(value: string, expectedBytes: number): string | null {
  const bytes = decodeBase32Bytes(value)
  if (!bytes || bytes.length !== expectedBytes) return null
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function decodeBase32Bytes(value: string): Uint8Array | null {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let buffer = 0
  const bytes: number[] = []
  for (const character of value) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) return null
    buffer = (buffer << 5) | digit
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 0xff)
      buffer &= (1 << bits) - 1
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return null
  return Uint8Array.from(bytes)
}
