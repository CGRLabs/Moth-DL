/**
 * Artwork handling: sniffing, size limits and content-addressed storage.
 *
 * Artwork arrives from three places — an embedded tag, a page's OpenGraph image,
 * or a user picking a file — and all three are untrusted. Two rules follow:
 *
 *  1. **Never trust a declared MIME type.** A tag can claim `image/png` while
 *     carrying anything, and that byte array ends up embedded in a media file.
 *     The magic bytes are the only authority.
 *  2. **Never store at a path derived from input.** The filename comes from a
 *     hash of the content, so a hostile string cannot escape the artwork
 *     directory or overwrite an unrelated file.
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtworkMime } from '@shared/media.js'
import { getLogger } from '../util/logger.js'

const log = getLogger('media.artwork')

/** Anything larger is almost certainly not a cover image. */
export const MAX_ARTWORK_BYTES = 5 * 1024 * 1024

const SIGNATURES: ReadonlyArray<{
  mime: ArtworkMime
  ext: string
  bytes: readonly number[]
}> = [
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] }
]

/**
 * Identifies an image from its leading bytes.
 *
 * WebP is `RIFF` + 4 bytes + `WEBP`, so the signature alone is not enough — a
 * plain RIFF container would be misidentified. The caller is expected to pass
 * at least 12 bytes.
 */
export function sniffImageMime(bytes: Uint8Array): ArtworkMime | null {
  for (const signature of SIGNATURES) {
    let matched = true
    for (let i = 0; i < signature.bytes.length; i += 1) {
      if (bytes[i] !== signature.bytes[i]) {
        matched = false
        break
      }
    }
    if (!matched) continue

    if (signature.mime === 'image/webp') {
      // RIFF size field, then 'WEBP'.
      if (bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) {
        continue
      }
    }
    return signature.mime
  }
  return null
}

export interface StoredArtwork {
  /** Absolute path inside the artwork directory. */
  path: string
  mime: ArtworkMime
  bytes: number
}

/**
 * Stores artwork under `<userData>/artwork/`, named by its content hash.
 *
 * Content-addressing means the same image is stored once no matter how many
 * downloads reference it, and means the on-disk name can never be influenced by
 * a filename, a URL or a tag.
 *
 * Returns `null` when the bytes are not a recognised image or exceed the size
 * limit. A rejection is never thrown for bad input.
 */
export async function storeArtwork(
  bytes: Uint8Array,
  userDataDir: string
): Promise<StoredArtwork | null> {
  if (bytes.length === 0 || bytes.length > MAX_ARTWORK_BYTES) {
    log.warn('Rejected artwork', { bytes: bytes.length, limit: MAX_ARTWORK_BYTES })
    return null
  }

  const mime = sniffImageMime(bytes)
  if (!mime) {
    log.warn('Rejected artwork: unrecognised image signature', { bytes: bytes.length })
    return null
  }

  const signature = SIGNATURES.find((entry) => entry.mime === mime)
  const ext = signature?.ext ?? 'bin'
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  const directory = join(userDataDir, 'artwork')

  try {
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${digest}.${ext}`)
    await writeFile(path, bytes)
    return { path, mime, bytes: bytes.length }
  } catch (err) {
    log.error('Failed to store artwork', { error: err })
    return null
  }
}

/** Removes a stored artwork file. Best-effort: a failure is logged, not thrown. */
export async function removeArtwork(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(path, { force: true }).catch((err: unknown) => {
    log.warn('Failed to remove artwork', { path, error: err })
  })
}
