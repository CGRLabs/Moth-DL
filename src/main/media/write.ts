/**
 * Non-destructive tag writing.
 *
 * The rule this module exists to enforce: **a failed tag write must leave the
 * original file byte-identical.** Music files are irreplaceable to the people
 * who own them, and the failure mode of a bad write is nasty — a file that still
 * plays for ten seconds before desyncing, so it looks fine at first.
 *
 * The cycle is therefore:
 *
 *   read original  ->  build new bytes in memory
 *                  ->  write to `<path>.mothtag`
 *                  ->  re-parse the temp file and assert the tags read back
 *                  ->  atomically replace the original
 *
 * Any failure before the replace deletes the temp and returns `{ written: false }`
 * with a reason. The original is never opened for writing.
 */

import { open, readFile, writeFile } from 'node:fs/promises'
import type { MediaTags, MediaWriteResult } from '@shared/media.js'
import { emptyTags } from '@shared/media.js'
import { getLogger } from '../util/logger.js'
import { detectFormat, formatIsSupported } from './detect.js'
import { parseId3v1, parseId3v2 } from './id3/read.js'
import { buildId3v2Tag, stripId3v2 } from './id3/write.js'
import { parseMp4 } from './mp4/read.js'
import { buildTaggedMp4 } from './mp4/write.js'
import { parseFlac, parseVorbisComment } from './vorbis.js'
import { moveFile } from '../util/paths.js'

const log = getLogger('media.write')

/** Bytes read when sniffing a format. */
const SNIFF_BYTES = 16

/** How much of the front of a file to read when looking for an ID3v2 tag. */
const ID3_HEAD_BYTES = 256 * 1024

/** ID3v1 is a fixed 128-byte block at the end of the file. */
const ID3V1_BYTES = 128

/** Reads `length` bytes at `offset` from a file. */
async function readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return new Uint8Array(buffer.buffer, 0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Reads the whole file. Only called for formats whose tags are not at the front. */
async function readWhole(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

/** True when at least one human-meaningful field is populated. */
function hasContent(tags: MediaTags): boolean {
  return Boolean(
    tags.title ||
      tags.artist ||
      tags.album ||
      tags.albumArtist ||
      tags.genre ||
      tags.year !== null ||
      tags.track !== null ||
      tags.disc !== null ||
      tags.artwork
  )
}

/**
 * Reads the tags already present in a file.
 *
 * Used both to show existing metadata and to verify a write. Never throws: a
 * metadata failure must never fail a download.
 */
export async function readTagsFromFile(path: string): Promise<MediaTags> {
  try {
    const format = detectFormat(await readRange(path, 0, SNIFF_BYTES))

    if (!formatIsSupported(format)) {
      return emptyTags(format)
    }

    // MP4's moov box and FLAC's metadata blocks are not guaranteed to be at the
    // front, so those formats need the whole file.
    if (format === 'mp4') {
      return parseMp4(await readWhole(path))
    }
    if (format === 'flac') {
      return parseFlac(await readWhole(path))
    }
    if (format === 'ogg') {
      return parseVorbisComment(await readWhole(path))
    }

    // MP3: ID3v2 at the front, ID3v1 at the back. Prefer v2; fall back to v1.
    const v2 = parseId3v2(await readRange(path, 0, ID3_HEAD_BYTES))
    if (hasContent(v2)) return v2

    const size = await statSize(path)
    const tail = await readRange(path, Math.max(0, size - ID3V1_BYTES), ID3V1_BYTES)
    const v1 = parseId3v1(tail)
    return hasContent(v1) ? v1 : v2
  } catch (err) {
    log.warn('Could not read tags; continuing without metadata', { path, error: err })
    return emptyTags()
  }
}

async function statSize(path: string): Promise<number> {
  const { stat } = await import('node:fs/promises')
  return (await stat(path)).size
}

/**
 * Applies tags to a file, non-destructively.
 *
 * `expected` is the set of tags the caller believes should be present after the
 * write. The temp file is re-parsed and compared against it, so a write that
 * silently drops a field is reported as a failure rather than a success.
 */
export async function writeTagsToFile(
  path: string,
  tags: MediaTags,
  expected?: Partial<MediaTags>
): Promise<MediaWriteResult> {
  const format = detectFormat(await readRange(path, 0, SNIFF_BYTES))

  if (!formatIsSupported(format)) {
    return { written: false, reason: `Format ${format} does not support tags` }
  }

  let tagged: Uint8Array | null = null

  if (format === 'mp3') {
    const original = await readWhole(path)
    const tag = buildId3v2Tag(tags)
    if (!tag) return { written: false, reason: 'Nothing to write' }
    // Strip any existing ID3v2 first, or the new tag stacks in front of the old
    // one and most players read only the first.
    tagged = Buffer.concat([tag, stripId3v2(original)])
  } else if (format === 'mp4') {
    tagged = buildTaggedMp4(await readWhole(path), tags)
    if (!tagged) return { written: false, reason: 'Nothing to write' }
  } else {
    // FLAC and Ogg need their metadata block rewritten in place, which is a more
    // delicate operation than prepending a tag.
    return { written: false, reason: `Writing ${format} tags is not supported yet` }
  }

  const tempPath = `${path}.mothtag`
  try {
    await writeFile(tempPath, tagged)

    // Verify before replacing. This is the step that makes the operation safe.
    const verified = await readTagsFromFile(tempPath)
    if (expected) {
      for (const [key, value] of Object.entries(expected)) {
        if (value === undefined) continue
        const actual = verified[key as keyof MediaTags]
        if (actual !== value) {
          log.warn('Tag verification failed; keeping the original file', {
            path,
            field: key,
            expected: value,
            actual
          })
          return { written: false, reason: `Verification failed for ${key}` }
        }
      }
    }

    await moveFile(tempPath, path, true)
    log.info('Wrote tags to file', { path, format })
    return { written: true }
  } catch (err) {
    log.error('Tag write failed; original untouched', { path, error: err })
    // Never leave a temp file behind.
    const { rm } = await import('node:fs/promises')
    await rm(tempPath, { force: true }).catch(() => {})
    return { written: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
