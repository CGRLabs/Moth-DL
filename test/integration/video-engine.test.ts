/**
 * Engine integration for video-capture slice 1.
 *
 * The resolver is stubbed (inject, never spawn): the stub hands back the
 * loopback test server as the "resolved" URL, and the test proves the
 * download then flows through the NORMAL chunk pipeline. No network beyond
 * loopback, no binaries.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DownloadEngine } from '../../src/main/core/engine.js'
import { configureVideoCapture, resetVideoCaptureForTests } from '../../src/main/video/index.js'
import { setVideoResolverForTests } from '../../src/main/video/resolve.js'
import { setVideoMuxerForTests, setVideoValidatorForTests } from '../../src/main/video/transcode.js'
import { setYtDlpRunnerForTests } from '../../src/main/video/download.js'
import { EngineError } from '../../src/main/util/errors.js'
import { makeBody, startTestServer, type TestServer } from '../helpers/testServer.js'
import { createHarness, waitFor, waitForStatus, type TestHarness } from '../helpers/harness.js'
import { closeAgents } from '../../src/main/net/httpClient.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MediaService } from '../../src/main/media/service.js'
import { openDatabase } from '../../src/main/db/driver.js'
import { migrate } from '../../src/main/db/schema.js'
import { createRepositories } from '../../src/main/db/repositories.js'
import { SettingsStore } from '../../src/main/core/settingsStore.js'

let harness: TestHarness | null = null
let server: TestServer | null = null
let subtitleServer: TestServer | null = null
let engine: DownloadEngine | null = null

afterEach(async () => {
  setVideoResolverForTests(null)
  setVideoMuxerForTests(null)
  setVideoValidatorForTests(null)
  setYtDlpRunnerForTests(null)
  resetVideoCaptureForTests()
  await engine?.shutdown().catch(() => {})
  engine = null
  await harness?.cleanup()
  harness = null
  await server?.close()
  server = null
  await subtitleServer?.close()
  subtitleServer = null
  closeAgents()
})

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

describe('video-capture slice 1 (stubbed resolver)', () => {
  it('uses yt-dlp for YouTube transfer and honors the selected video quality', async () => {
    const body = Buffer.from('yt-dlp video output')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Ff8AAAAASUVORK5CYII=',
      'base64'
    )
    server = await startTestServer({ body: png })
    harness = await createHarness({ autoStartDownloads: true })
    configureVideoCapture({ userDataDir: harness.root })
    setVideoResolverForTests(async () =>
      JSON.stringify({
        id: 'youtube-quality-test',
        extractor_key: 'Youtube',
        title: 'YouTube Quality Test',
        thumbnail: server!.url,
        formats: []
      })
    )
    let args: string[] = []
    let artworkReadyBeforeTransfer = false
    setYtDlpRunnerForTests(async (request) => {
      args = request.args
      artworkReadyBeforeTransfer = Boolean(harness!.repos.media.get(resultId)?.artworkPath)
      request.onProgress({ filename: null, downloadedBytes: body.length, totalBytes: body.length, speed: 512, eta: 0 })
      const outputPath = join(request.workDir, 'media.mp4')
      await writeFile(outputPath, body)
      return outputPath
    })
    setVideoValidatorForTests(async () => ({
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
      width: 1920,
      height: 1080
    }))
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    engine.setMediaService(
      new MediaService({
        repos: harness.repos.media,
        settings: harness.settings,
        artworkBase: 'moth-artwork://file/',
        userDataDir: harness.root
      })
    )
    let resultId = ''
    const result = await engine.add({
      url: 'https://www.youtube.com/watch?v=youtube-quality-test',
      format: 'video',
      videoQuality: 2160
    })
    resultId = result.id
    await waitForStatus(harness.repos, result.id, ['completed', 'failed'], 30_000)

    const download = harness.repos.downloads.get(result.id)!
    expect(download.status, download.errorMessage ?? '').toBe('completed')
    expect(download.filename).toBe('YouTube Quality Test.mp4')
    expect(sha256(await readFile(download.finalPath!))).toBe(sha256(body))
    const selector = args[args.indexOf('--format') + 1] ?? ''
    expect(selector).toContain('[height<=2160]')
    expect(args).toContain('--remux-video')
    expect(args).toContain('--merge-output-format')
    expect(args).toContain('mp4')
    expect(args).not.toContain('--recode-video')
    expect(args).toContain('--continue')
    expect(harness.repos.chunks.listByDownload(result.id)).toHaveLength(0)
    expect(artworkReadyBeforeTransfer).toBe(true)
    expect(engine.getSnapshot(download)).toMatchObject({
      youtubeVideoOutput: {
        requestedQuality: 2160,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac'
      }
    })
  })

  it('lets yt-dlp extract an MP3 for YouTube audio downloads', async () => {
    const body = Buffer.from('yt-dlp mp3 output')
    harness = await createHarness()
    configureVideoCapture({ userDataDir: harness.root })
    setVideoResolverForTests(async () =>
      JSON.stringify({
        id: 'youtube-audio-test',
        extractor_key: 'Youtube',
        title: 'YouTube Audio Test',
        formats: []
      })
    )
    let args: string[] = []
    setYtDlpRunnerForTests(async (request) => {
      args = request.args
      const outputPath = join(request.workDir, 'media.mp3')
      await writeFile(outputPath, body)
      return outputPath
    })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    const result = await engine.add({
      url: 'https://youtu.be/youtube-audio-test',
      format: 'audio',
      audioFormat: 'mp3'
    })
    await waitForStatus(harness.repos, result.id, ['completed', 'failed'], 30_000)

    const download = harness.repos.downloads.get(result.id)!
    expect(download.status, download.errorMessage ?? '').toBe('completed')
    expect(download.filename).toBe('YouTube Audio Test.mp3')
    expect(sha256(await readFile(download.finalPath!))).toBe(sha256(body))
    expect(args).toContain('bestaudio')
    expect(args).toContain('--extract-audio')
    expect(args).toContain('--audio-format')
    expect(args).toContain('mp3')
  })

  it('does not complete a YouTube video when media validation fails', async () => {
    const body = Buffer.from('synthetic invalid media')
    harness = await createHarness({ autoStartDownloads: true })
    configureVideoCapture({ userDataDir: harness.root })
    setVideoResolverForTests(async () =>
      JSON.stringify({
        id: 'youtube-invalid-media',
        extractor_key: 'Youtube',
        title: 'Invalid Media',
        formats: []
      })
    )
    setYtDlpRunnerForTests(async ({ workDir }) => {
      const outputPath = join(workDir, 'media.mp4')
      await writeFile(outputPath, body)
      return outputPath
    })
    setVideoValidatorForTests(async () => {
      throw new EngineError({
        code: 'FILE_IO',
        message: 'The downloaded file does not contain a readable video stream',
        retryable: false
      })
    })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    let finishedEvents = 0
    engine.on('finished', () => { finishedEvents += 1 })
    const result = await engine.add({
      url: 'https://www.youtube.com/watch?v=youtube-invalid-media',
      format: 'video'
    })
    await waitForStatus(harness.repos, result.id, ['failed'], 30_000)

    const download = harness.repos.downloads.get(result.id)!
    expect(download.status).toBe('failed')
    expect(download.errorMessage).toContain('readable video stream')
    expect(finishedEvents).toBe(0)
    expect(await access(download.finalPath!).then(() => true, () => false)).toBe(false)
    await engine.shutdown()
  })

  it('stores the page title and artwork, then refreshes the completed row', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Ff8AAAAASUVORK5CYII=',
      'base64'
    )
    server = await startTestServer({ body: png })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    setVideoResolverForTests(async () =>
      JSON.stringify({
        title: 'Artful Clip',
        thumbnail: server!.url,
        formats: [
          {
            url: server!.url,
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'mp4a.40.2',
            height: 360
          }
        ]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    engine.setMediaService(
      new MediaService({
        repos: harness.repos.media,
        settings: harness.settings,
        artworkBase: 'moth-artwork://',
        userDataDir: harness.root
      })
    )
    let resultId = ''
    let artworkRefreshObserved = false
    engine.on('upserted', (download) => {
      if (download.id === resultId && harness?.repos.media.get(resultId)?.artworkPath) {
        artworkRefreshObserved = true
      }
    })
    const result = await engine.add({ url: 'https://example.com/watch?v=artfulclip1', format: 'video' })
    resultId = result.id

    await waitForStatus(harness.repos, result.id, ['completed'], 30_000)
    await waitFor(() => Boolean(harness!.repos.media.get(result.id)?.artworkPath))
    const media = harness.repos.media.get(result.id)
    expect(media?.title).toBe('Artful Clip')
    expect(media?.source).toBe('page')
    expect(media?.artworkMime).toBe('image/png')
    expect(artworkRefreshObserved).toBe(true)
    await engine.shutdown()
  })

  it('format video: resolves first, then runs the normal chunk pipeline', async () => {
    const body = makeBody(256 * 1024, 7)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 4 })
    configureVideoCapture({ userDataDir: harness.root })
    const resolvedUrl = server.url
    setVideoResolverForTests(async () =>
      JSON.stringify({
        title: 'Grabbed Clip',
        formats: [
          {
            url: resolvedUrl,
            ext: 'mp4',
            vcodec: 'avc1.64001f',
            acodec: 'mp4a.40.2',
            height: 720,
            tbr: 1500
          }
        ]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({
      url: 'https://example.com/watch?v=grabbedclip1',
      format: 'video'
    })
    expect(harness.repos.downloads.get(result.id)?.status).toBe('connecting')
    await waitFor(() => harness!.repos.downloads.get(result.id)?.filename === 'Grabbed Clip.mp4')

    await waitForStatus(harness.repos, result.id, ['completed'], 30_000)
    const row = harness.repos.downloads.get(result.id)!
    // The record points at the resolved file URL, not the page URL.
    expect(row.url).toBe(resolvedUrl)
    expect(sha256(await readFile(row.finalPath!))).toBe(sha256(body))

    await engine.shutdown()
  })

  it('shows a media row immediately and respects pause during page resolution', async () => {
    const body = makeBody(64 * 1024, 3)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    const resolverGate: { release: (value: string) => void } = {
      release: () => {
        throw new Error('Resolver has not started')
      }
    }
    setVideoResolverForTests(
      () =>
        new Promise((resolve) => {
          resolverGate.release = resolve
        })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({
      url: 'https://example.com/watch?v=instantrow01',
      format: 'video',
      videoQuality: 480
    })
    const placeholder = harness.repos.downloads.get(result.id)
    expect(placeholder?.status).toBe('connecting')
    expect(placeholder?.filename).toMatch(/^Preparing video from /)
    expect(harness.repos.mediaResolutions.get(result.id)?.videoQuality).toBe(480)

    engine.pause(result.id)
    resolverGate.release(
      JSON.stringify({
        title: 'Paused Clip',
        formats: [
          {
            url: server.url,
            ext: 'mp4',
            vcodec: 'avc1.64001f',
            acodec: 'mp4a.40.2',
            height: 480
          }
        ]
      })
    )
    await waitFor(
      () =>
        harness!.repos.downloads.get(result.id)?.status === 'paused' &&
        harness!.repos.downloads.get(result.id)?.filename === 'Paused Clip.mp4'
    )
    expect(harness.repos.downloads.get(result.id)?.filename).toBe('Paused Clip.mp4')

    await engine.resume(result.id)
    await waitForStatus(harness.repos, result.id, ['completed'], 30_000)
    expect(sha256(await readFile(harness.repos.downloads.get(result.id)!.finalPath!))).toBe(sha256(body))
    await engine.shutdown()
  })

  it('format audio: an MP3 source lands as .mp3 with no transcoder involved', async () => {
    const body = makeBody(128 * 1024, 9)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 2 })
    // Capture is configured, but no helper binary exists on disk: completion
    // proves the direct-copy path never reached for a transcoder.
    configureVideoCapture({ userDataDir: harness.root })
    const resolvedUrl = server.url
    setVideoResolverForTests(async () =>
      JSON.stringify({
        title: 'Song',
        formats: [{ url: resolvedUrl, ext: 'mp3', vcodec: 'none', acodec: 'mp3', abr: 192 }]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({ url: 'https://example.com/watch?v=songtrack01', format: 'audio' })
    expect(harness.repos.downloads.get(result.id)?.status).toBe('connecting')
    await waitFor(() => harness!.repos.downloads.get(result.id)?.filename === 'Song.mp3')

    await waitForStatus(harness.repos, result.id, ['completed'], 30_000)
    const row = harness.repos.downloads.get(result.id)!
    expect(sha256(await readFile(row.finalPath!))).toBe(sha256(body))

    await engine.shutdown()
  })

  it('can keep the selected source audio container instead of converting to MP3', async () => {
    const body = makeBody(96 * 1024, 11)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 2 })
    configureVideoCapture({ userDataDir: harness.root })
    const resolvedUrl = server.url
    setVideoResolverForTests(async () =>
      JSON.stringify({
        id: 'sourcesong01',
        extractor_key: 'Example',
        title: 'Source Song',
        formats: [{ url: resolvedUrl, ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 256 }]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({
      url: 'https://example.com/watch?v=sourcesong01',
      format: 'audio',
      audioFormat: 'source'
    })
    await waitForStatus(harness.repos, result.id, ['completed'], 30_000)
    const row = harness.repos.downloads.get(result.id)!
    expect(row.filename).toBe('Source Song.m4a')
    expect(sha256(await readFile(row.finalPath!))).toBe(sha256(body))
    expect(harness.repos.audioTranscodes.has(result.id)).toBe(false)
    expect(engine.checkMediaDuplicate('https://example.com/watch?v=sourcesong01')).toEqual({
      duplicate: true,
      title: 'Source Song',
      filename: 'Source Song.m4a'
    })
    expect(harness.repos.mediaHistory.hasSourceKey('example:sourcesong01')).toBe(true)
    await engine.shutdown()
  })

  it('refreshes a media page URL when retrying a failed stream transfer', async () => {
    const body = makeBody(64 * 1024, 19)
    server = await startTestServer({ body })
    harness = await createHarness({
      chunkSize: 64 * 1024,
      defaultConnections: 1,
      autoStartDownloads: false,
      maxRetries: 0
    })
    configureVideoCapture({ userDataDir: harness.root })
    let resolutions = 0
    const resolvedUrl = server.url
    setVideoResolverForTests(async () => {
      resolutions += 1
      return JSON.stringify({
        id: 'refreshable-video',
        extractor_key: 'Example',
        title: 'Refreshable',
        formats: [{ url: resolvedUrl, ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a.40.2', height: 360 }]
      })
    })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({
      url: 'https://example.com/watch?v=refreshable-video',
      format: 'video'
    })
    await waitFor(() => harness!.repos.downloads.get(result.id)?.filename === 'Refreshable.mp4')
    server.setFailFirst(10)
    harness.settings.update({ autoStartDownloads: true })
    await engine.resume(result.id)
    await waitForStatus(harness.repos, result.id, ['failed'], 30_000)
    expect(resolutions).toBe(1)

    server.setFailFirst(0)
    engine.retry(result.id)
    await waitForStatus(harness.repos, result.id, ['completed'], 30_000)
    expect(resolutions).toBe(2)
    expect(sha256(await readFile(harness.repos.downloads.get(result.id)!.finalPath!))).toBe(sha256(body))
    await engine.shutdown()
  })

  it('keeps a failed subtitle sidecar independent and applies the requested filename template', async () => {
    const body = makeBody(64 * 1024, 27)
    server = await startTestServer({ body })
    subtitleServer = await startTestServer({ failFirst: 10 })
    harness = await createHarness({
      chunkSize: 64 * 1024,
      defaultConnections: 1,
      autoStartDownloads: false
    })
    configureVideoCapture({ userDataDir: harness.root })
    setVideoResolverForTests(async () =>
      JSON.stringify({
        id: 'rendered-media01',
        extractor_key: 'Example',
        title: 'Rendered Clip',
        formats: [{ url: server!.url, ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a.40.2', height: 360 }],
        subtitles: { en: [{ url: subtitleServer!.url, ext: 'vtt' }] }
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    const failedIds: string[] = []
    engine.on('failed', ({ id }) => failedIds.push(id))

    const result = await engine.add({
      url: 'https://example.com/watch?v=rendered-media01',
      format: 'video',
      subtitleLanguages: ['en'],
      namingTemplate: '{title}.{id}.{ext}',
      embedMetadata: false
    })
    await waitFor(
      () => harness!.repos.downloads.get(result.id)?.filename === 'Rendered Clip.rendered-media01.mp4'
    )
    expect(harness.repos.mediaResolutions.get(result.id)).toMatchObject({
      namingTemplate: '{title}.{id}.{ext}',
      embedMetadata: false
    })
    await waitFor(() => subtitleServer!.requestCount() >= 2)
    expect(harness.repos.downloads.get(result.id)?.status).toBe('queued')
    expect(failedIds).not.toContain(result.id)

    await engine.resume(result.id)
    await waitForStatus(harness.repos, result.id, ['completed'], 30_000)
    expect(failedIds).not.toContain(result.id)
    expect(harness.repos.downloads.get(result.id)?.filename).toBe(
      'Rendered Clip.rendered-media01.mp4'
    )
    await engine.shutdown()
  })

  it('restores filename and metadata options when recovering pending media after restart', async () => {
    harness = await createHarness({ autoStartDownloads: false })
    configureVideoCapture({ userDataDir: harness.root })
    let resolverCalls = 0
    setVideoResolverForTests(
      () =>
        new Promise<string>(() => {
          resolverCalls += 1
        })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    const result = await engine.add({
      url: 'https://example.com/watch?v=persist-options01',
      format: 'video',
      namingTemplate: '{title}.{id}.{ext}',
      embedMetadata: false
    })
    await waitFor(() => resolverCalls > 0)
    await engine.shutdown()
    engine = null

    harness.db.close()
    const reopenedDb = openDatabase({
      location: join(harness.root, 'test.db'),
      synchronous: 'OFF'
    })
    migrate(reopenedDb)
    harness.db = reopenedDb
    harness.repos = createRepositories(reopenedDb)
    harness.settings = new SettingsStore(harness.repos)

    server = await startTestServer({ body: makeBody(64 * 1024, 31) })
    setVideoResolverForTests(async () =>
      JSON.stringify({
        id: 'persist-options01',
        extractor_key: 'Example',
        title: 'Recovered Clip',
        formats: [{ url: server!.url, ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a.40.2', height: 360 }]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    await engine.start()
    await waitFor(() => harness!.repos.mediaResolutions.get(result.id)?.resolved === true)
    expect(harness.repos.mediaResolutions.get(result.id)).toMatchObject({
      namingTemplate: '{title}.{id}.{ext}',
      embedMetadata: false
    })
    expect(harness.repos.downloads.get(result.id)?.filename).toBe(
      'Recovered Clip.persist-options01.mp4'
    )
    await engine.shutdown()
  })

  it('keeps MP3 conversion failures failed across an explicit retry', async () => {
    const body = makeBody(64 * 1024, 13)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    const helperDir = join(harness.root, 'bin')
    await mkdir(helperDir, { recursive: true })
    await writeFile(join(helperDir, 'ffmpeg.exe'), 'not a runnable ffmpeg binary')
    harness.settings.update({ helperDir })
    const resolvedUrl = server.url
    setVideoResolverForTests(async () =>
      JSON.stringify({
        title: 'Conversion Failure',
        formats: [{ url: resolvedUrl, ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    let finishedEvents = 0
    engine.on('finished', () => {
      finishedEvents += 1
    })
    const result = await engine.add({ url: 'https://example.com/watch?v=convertFailure01', format: 'audio' })
    await waitForStatus(harness.repos, result.id, ['failed'], 30_000)
    expect(harness.repos.audioTranscodes.has(result.id)).toBe(true)
    expect(finishedEvents).toBe(0)

    engine.retry(result.id)
    await waitForStatus(harness.repos, result.id, ['failed'], 30_000)
    expect(harness.repos.audioTranscodes.has(result.id)).toBe(true)
    expect(finishedEvents).toBe(0)
    await engine.shutdown()
  })

  it('downloads the video track, muxes a separate audio track, and clears its durable merge job', async () => {
    const body = makeBody(96 * 1024, 17)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 2 })
    configureVideoCapture({ userDataDir: harness.root })
    const helperDir = join(harness.root, 'bin')
    await mkdir(helperDir, { recursive: true })
    await writeFile(join(helperDir, 'yt-dlp.exe'), 'test resolver')
    await writeFile(join(helperDir, 'ffmpeg.exe'), 'test muxer')
    harness.settings.update({ helperDir })

    let muxed = false
    setVideoMuxerForTests(async (videoPath, outputPath, options) => {
      expect(videoPath).toBe(outputPath)
      expect(options.audioUrl).toBe('https://cdn.example/audio.m4a')
      expect(options.container).toBe('mp4')
      muxed = true
      return outputPath
    })
    setVideoResolverForTests(async () =>
      JSON.stringify({
        title: 'Muxed Clip',
        formats: [
          { url: server!.url, ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720 },
          { url: 'https://cdn.example/audio.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }
        ]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({ url: 'https://example.com/watch?v=separateTracks01', format: 'video' })
    expect(harness.repos.downloads.get(result.id)?.status).toBe('connecting')
    await waitFor(
      () =>
        muxed ||
        harness!.repos.downloads.get(result.id)?.status === 'failed',
      { message: `media preparation ended unexpectedly: ${JSON.stringify(harness.repos.downloads.get(result.id))}` }
    )

    await waitForStatus(harness.repos, result.id, ['completed'], 30_000)
    expect(muxed).toBe(true)
    expect(harness.repos.videoMerges.get(result.id)).toBeNull()
    const row = harness.repos.downloads.get(result.id)!
    expect(sha256(await readFile(row.finalPath!))).toBe(sha256(body))
    await engine.shutdown()
  })

  it('does not report a video complete when required audio muxing fails', async () => {
    const body = makeBody(64 * 1024, 23)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    const helperDir = join(harness.root, 'bin')
    await mkdir(helperDir, { recursive: true })
    await writeFile(join(helperDir, 'ffmpeg.exe'), 'test muxer')
    harness.settings.update({ helperDir })
    setVideoMuxerForTests(async () => {
      throw new Error('synthetic mux failure')
    })
    setVideoResolverForTests(async () =>
      JSON.stringify({
        title: 'Mux Failure',
        formats: [
          { url: server!.url, ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 360 },
          { url: 'https://cdn.example/audio.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }
        ]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    let finishedEvents = 0
    engine.on('finished', () => {
      finishedEvents += 1
    })
    const result = await engine.add({ url: 'https://example.com/watch?v=muxFailureTrack1', format: 'video' })
    await waitForStatus(harness.repos, result.id, ['failed'], 30_000)

    const row = harness.repos.downloads.get(result.id)!
    expect(row.status).toBe('failed')
    expect(row.errorMessage).toContain('could not merge audio')
    expect(finishedEvents).toBe(0)
    expect(harness.repos.videoMerges.get(result.id)).not.toBeNull()
    await expect(access(row.finalPath!)).rejects.toThrow()
    await engine.shutdown()
  })

  it('waits for a video mux before removing its download record and file', async () => {
    const body = makeBody(64 * 1024, 29)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    const helperDir = join(harness.root, 'bin')
    await mkdir(helperDir, { recursive: true })
    await writeFile(join(helperDir, 'ffmpeg.exe'), 'test muxer')
    harness.settings.update({ helperDir })

    let muxStarted = false
    let releaseMux: () => void = () => {
      throw new Error('Mux has not started')
    }
    setVideoMuxerForTests(
      async (_videoPath, outputPath) =>
        new Promise((resolve) => {
          muxStarted = true
          releaseMux = () => resolve(outputPath)
        })
    )
    setVideoResolverForTests(async () =>
      JSON.stringify({
        title: 'Removed During Mux',
        formats: [
          { url: server!.url, ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 360 },
          { url: 'https://cdn.example/audio.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }
        ]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({ url: 'https://example.com/watch?v=removeDuringMux1', format: 'video' })
    await waitFor(() => muxStarted)
    const removing = engine.remove(result.id, true)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(harness.repos.downloads.get(result.id)).not.toBeNull()
    releaseMux()
    await removing

    expect(harness.repos.downloads.get(result.id)).toBeNull()
    await expect(access(join(harness.downloadDir, 'Removed During Mux.mp4'))).rejects.toThrow()
    await engine.shutdown()
  })

  it('keeps the database open until an active video mux finishes during shutdown', async () => {
    const body = makeBody(64 * 1024, 31)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    const helperDir = join(harness.root, 'bin')
    await mkdir(helperDir, { recursive: true })
    await writeFile(join(helperDir, 'ffmpeg.exe'), 'test muxer')
    harness.settings.update({ helperDir })

    let muxStarted = false
    let releaseMux: () => void = () => {
      throw new Error('Mux has not started')
    }
    setVideoMuxerForTests(
      async (_videoPath, outputPath) =>
        new Promise((resolve) => {
          muxStarted = true
          releaseMux = () => resolve(outputPath)
        })
    )
    setVideoResolverForTests(async () =>
      JSON.stringify({
        title: 'Shutdown During Mux',
        formats: [
          { url: server!.url, ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 360 },
          { url: 'https://cdn.example/audio.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }
        ]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({ url: 'https://example.com/watch?v=shutdownDuringMux1', format: 'video' })
    await waitFor(() => muxStarted)
    const shuttingDown = engine.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(harness.db.isClosed).toBe(false)
    expect(harness.repos.downloads.get(result.id)?.status).toBe('verifying')
    releaseMux()
    await shuttingDown

    expect(harness.repos.downloads.get(result.id)?.status).toBe('completed')
  })

  it('a resolver failure is visible on the placeholder; the app is unaffected', async () => {
    const body = makeBody(64 * 1024, 11)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024 })
    configureVideoCapture({ userDataDir: harness.root })
    setVideoResolverForTests(async () => {
      throw new EngineError({ code: 'HTTP_CLIENT_ERROR', message: 'No streams for this page' })
    })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const pending = await engine.add({ url: 'https://example.com/watch?v=deadbeef00', format: 'video' })
    await waitForStatus(harness.repos, pending.id, ['failed'])
    expect(harness.repos.downloads.get(pending.id)?.errorMessage).toMatch(/Could not grab media from this page/)

    // The engine is still fully usable afterwards.
    const direct = await engine.add({ url: server.url })
    await waitForStatus(harness.repos, direct.id, ['completed'], 30_000)
    const row = harness.repos.downloads.get(direct.id)!
    expect(sha256(await readFile(row.finalPath!))).toBe(sha256(body))

    await engine.shutdown()
  })

  it('absent format behaves exactly as today (no resolver, no capture config)', async () => {
    const body = makeBody(128 * 1024, 13)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024 })
    // Deliberately: no configureVideoCapture, no resolver stub.
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({ url: server.url })
    await waitForStatus(harness.repos, result.id, ['completed'], 30_000)
    const row = harness.repos.downloads.get(result.id)!
    expect(sha256(await readFile(row.finalPath!))).toBe(sha256(body))

    await engine.shutdown()
  })
})
