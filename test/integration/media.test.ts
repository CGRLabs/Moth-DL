/**
 * Media service integration tests.
 *
 * Exercises the real path: a file on disk, the tag reader/writer, the repository
 * and the service that ties them together. Catches the class of bug where each
 * piece works alone but the wiring does not.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarness } from '../helpers/harness.js'
import { MediaService } from '../../src/main/media/service.js'
import { emptyTags } from '@shared/media.js'

let harness: Awaited<ReturnType<typeof createHarness>> | null = null
let dir: string | null = null

afterEach(async () => {
  await harness?.cleanup()
  harness = null
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  dir = null
})

async function setup(): Promise<{ service: MediaService; dir: string }> {
  harness = await createHarness()
  dir = await mkdtemp(join(tmpdir(), 'moth-media-'))
  const service = new MediaService({
    repos: harness.repos.media,
    settings: harness.settings,
    artworkBase: 'moth-artwork:///',
    userDataDir: dir
  })
  return { service, dir: dir! }
}

/** Writes a minimal MP3 (MPEG frame sync is enough for format detection). */
async function writeMp3(name: string): Promise<string> {
  const path = join(dir!, name)
  await writeFile(path, Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03, 0x04]))
  return path
}

describe('MediaService', () => {
  it('returns null for a download with no metadata', async () => {
    const { service } = await setup()
    expect(service.getView('missing')).toBeNull()
  })

  it('resolves metadata from a file after download', async () => {
    const { service } = await setup()
    const path = await writeMp3('song.mp3')

    // Seed a download row so the service has something to attach to.
    const id = 'media0000000000000000000000001'
    harness!.repos.downloads.insert({
      id,
      url: 'https://example.com/song.mp3',
      finalUrl: null,
      filename: 'song.mp3',
      tempPath: path,
      finalPath: path,
      fileSize: 8,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'audio',
      status: 'completed',
      downloadedBytes: 8,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 5,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: null,
      headers: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null
    })

    // Write tags into the file first, so the service can read them.
    const { writeTagsToFile } = await import('../../src/main/media/write.js')
    await writeTagsToFile(path, {
      ...emptyTags('mp3'),
      title: 'From the File',
      artist: 'Moth'
    })

    const view = await service.resolveAfterDownload(id, path)
    expect(view).not.toBeNull()
    expect(view?.title).toBe('From the File')
    expect(view?.artist).toBe('Moth')
    expect(view?.source).toBe('file')
  })

  it('prefers page metadata over what is in the file', async () => {
    const { service } = await setup()
    const path = await writeMp3('page.mp3')
    const id = 'media0000000000000000000000002'
    harness!.repos.downloads.insert({
      id,
      url: 'https://example.com/page.mp3',
      finalUrl: null,
      filename: 'page.mp3',
      tempPath: path,
      finalPath: path,
      fileSize: 8,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'audio',
      status: 'completed',
      downloadedBytes: 8,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 5,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: null,
      headers: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null
    })

    const { writeTagsToFile } = await import('../../src/main/media/write.js')
    await writeTagsToFile(path, { ...emptyTags('mp3'), title: 'File Title' })

    const view = await service.resolveAfterDownload(id, path, {
      title: 'Page Title',
      artist: 'Page Artist'
    })
    expect(view?.title).toBe('Page Title')
    expect(view?.artist).toBe('Page Artist')
    expect(view?.source).toBe('page')
  })

  it('stores page artwork and serves it as a URL', async () => {
    const { service } = await setup()
    const path = await writeMp3('art.mp3')
    const id = 'media0000000000000000000000003'
    harness!.repos.downloads.insert({
      id,
      url: 'https://example.com/art.mp3',
      finalUrl: null,
      filename: 'art.mp3',
      tempPath: path,
      finalPath: path,
      fileSize: 8,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'audio',
      status: 'completed',
      downloadedBytes: 8,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 5,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: null,
      headers: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null
    })

    const hint = {
      title: 'Art',
      pageImage: 'data:image/png;base64,iVBORw0KGgo='
    }
    const duringDownload = await service.resolvePageHint(id, hint)
    expect(duringDownload?.artworkUrl).toMatch(/^moth-artwork:\/\/\//)

    const view = await service.resolveAfterDownload(id, path, hint)
    expect(view?.artworkUrl).not.toBeNull()
    expect(view?.artworkUrl).toMatch(/^moth-artwork:\/\/\//)
  })

  it('honors the per-download metadata and artwork opt-out', async () => {
    const { service } = await setup()
    const path = await writeMp3('opt-out.mp3')
    const id = 'media0000000000000000000000005'
    harness!.repos.downloads.insert({
      id,
      url: 'https://example.com/opt-out.mp3',
      finalUrl: null,
      filename: 'opt-out.mp3',
      tempPath: path,
      finalPath: path,
      fileSize: 8,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'audio',
      status: 'completed',
      downloadedBytes: 8,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 5,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: null,
      headers: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null
    })
    harness!.settings.update({ writeMediaTags: true })
    const before = await readFile(path)
    const view = await service.resolveAfterDownload(
      id,
      path,
      {
        title: 'Page title',
        artist: 'Page artist',
        pageImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Ff8AAAAASUVORK5CYII='
      },
      { writeTags: false, fetchArtwork: false }
    )

    expect(view?.title).toBe('Page title')
    expect(view?.artworkUrl).toBeNull()
    expect(await readFile(path)).toEqual(before)
  })

  it('a manual edit outranks the stored source', async () => {
    const { service } = await setup()
    const path = await writeMp3('edit.mp3')
    const id = 'media0000000000000000000000004'
    harness!.repos.downloads.insert({
      id,
      url: 'https://example.com/edit.mp3',
      finalUrl: null,
      filename: 'edit.mp3',
      tempPath: path,
      finalPath: path,
      fileSize: 8,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'audio',
      status: 'completed',
      downloadedBytes: 8,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 5,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: null,
      headers: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      completedAt: null
    })

    await service.resolveAfterDownload(id, path, { title: 'Automatic' })
    const edited = await service.applyManualEdit(id, { title: 'Manual' })
    expect(edited?.title).toBe('Manual')
    expect(edited?.source).toBe('manual')
  })
})
