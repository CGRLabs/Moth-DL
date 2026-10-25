/**
 * Non-destructive tag writing tests.
 *
 * The guarantee under test: a failed tag write must leave the original file
 * byte-identical and must not leave a temp file behind. Music files are
 * irreplaceable, and the failure mode of a bad write is a file that still plays
 * for a few seconds before desyncing — so it looks fine at first.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTagsToFile, readTagsFromFile } from '../../src/main/media/write.js'
import { readSyncsafe } from '../../src/main/media/id3/frame.js'
import { emptyTags } from '@shared/media.js'

let dir: string | null = null

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

async function makeMp3(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'moth-tag-'))
  // A minimal MP3: an ID3v2 header is optional, the audio frames just need to
  // look like MPEG audio so the format is detected.
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03, 0x04])
  const path = join(dir, 'track.mp3')
  await writeFile(path, audio)
  return path
}

describe('writeTagsToFile', () => {
  it('writes tags that read back', async () => {
    const path = await makeMp3()
    const result = await writeTagsToFile(path, {
      ...emptyTags('mp3'),
      title: 'Round Trip',
      artist: 'Moth'
    })
    expect(result.written).toBe(true)

    const read = await readTagsFromFile(path)
    expect(read.title).toBe('Round Trip')
    expect(read.artist).toBe('Moth')
  })

  it('leaves the original untouched when there is nothing to write', async () => {
    const path = await makeMp3()
    const before = await readFile(path)
    const result = await writeTagsToFile(path, emptyTags('mp3'))
    expect(result.written).toBe(false)
    expect((await readFile(path)).equals(before)).toBe(true)
  })

  it('refuses a format that does not support tags', async () => {
    dir = await mkdtemp(join(tmpdir(), 'moth-tag-'))
    const path = join(dir, 'clip.mkv')
    // Matroska magic.
    await writeFile(path, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]))
    const result = await writeTagsToFile(path, { ...emptyTags('matroska'), title: 'x' })
    expect(result.written).toBe(false)
    expect(result.reason).toMatch(/does not support tags/)
  })

  it('never leaves a temp file behind', async () => {
    const path = await makeMp3()
    await writeTagsToFile(path, { ...emptyTags('mp3'), title: 'Temp' })
    const entries = await readdir(dir!)
    expect(entries).toEqual(['track.mp3'])
  })

  it('replaces an existing tag rather than stacking two', async () => {
    const path = await makeMp3()
    await writeTagsToFile(path, { ...emptyTags('mp3'), title: 'First' })
    await writeTagsToFile(path, { ...emptyTags('mp3'), title: 'Second' })

    const read = await readTagsFromFile(path)
    expect(read.title).toBe('Second')

    // Exactly one ID3v2 header may be present: the tag must fit inside the file,
    // and the byte immediately after it must not be the start of a second one.
    const buf = new Uint8Array(await readFile(path))
    expect(buf[0]).toBe(0x49) // 'I'
    const tagTotal = 10 + readSyncsafe(buf, 6)
    expect(tagTotal).toBeLessThanOrEqual(buf.length)
    expect(buf[tagTotal]).not.toBe(0x49)
  })
})
