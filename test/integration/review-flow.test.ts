import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DownloadEngine } from '../../src/main/core/engine.js'
import { runRecovery } from '../../src/main/core/recovery.js'
import { closeAgents } from '../../src/main/net/httpClient.js'
import { configureVideoCapture, resetVideoCaptureForTests } from '../../src/main/video/index.js'
import { setVideoResolverForTests } from '../../src/main/video/resolve.js'
import { createHarness, waitFor, waitForStatus, type TestHarness } from '../helpers/harness.js'
import { makeBody, startTestServer, type TestServer } from '../helpers/testServer.js'

let harness: TestHarness | null = null
let server: TestServer | null = null
let engine: DownloadEngine | null = null

afterEach(async () => {
  setVideoResolverForTests(null)
  resetVideoCaptureForTests()
  await engine?.shutdown()
  engine = null
  await harness?.cleanup()
  harness = null
  await server?.close()
  server = null
  closeAgents()
})

describe('staged download review', () => {
  it('keeps a staged file in review through recovery and transfers only after Start', async () => {
    const body = makeBody(256 * 1024, 37)
    server = await startTestServer({ body })
    harness = await createHarness({ defaultConnections: 1 })
    const { repos, settings, db } = harness
    engine = new DownloadEngine(repos, settings, db)

    const staged = await engine.stage({ url: server.url })
    await waitFor(() => (repos.downloads.get(staged.id)?.fileSize ?? 0) === body.length)
    expect(repos.downloads.get(staged.id)?.status).toBe('review')
    expect(server.bytesServed()).toBe(1)

    await engine.shutdown()
    engine = null
    const recovery = await runRecovery(repos)
    expect(recovery.scanned).toBe(0)
    expect(repos.downloads.get(staged.id)?.status).toBe('review')

    engine = new DownloadEngine(repos, settings, db)
    const expectedChecksum = createHash('sha256').update(body).digest('hex')
    await engine.configureReview(staged.id, {
      url: server.url,
      expectedChecksum,
      speedLimit: 128 * 1024,
      connections: 2
    })
    const configured = repos.downloads.get(staged.id)!
    expect(configured.status).toBe('review')
    expect(configured.expectedChecksum?.value).toBe(expectedChecksum)
    expect(configured.speedLimit).toBe(128 * 1024)
    expect(configured.connections).toBe(2)
    expect(server.bytesServed()).toBe(1)

    await engine.startReviewDownload(staged.id)
    await waitForStatus(repos, staged.id, ['completed', 'failed'])

    const completed = repos.downloads.get(staged.id)!
    expect(completed.status, completed.errorMessage ?? '').toBe('completed')
    expect(server.bytesServed()).toBe(body.length + 1)
  })

  it('keeps an extension-less link that redirects to a file on the file path', async () => {
    const body = makeBody(128 * 1024, 11)
    server = await startTestServer({ body })
    harness = await createHarness({ defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    // Any media resolution would mean the URL was mistaken for a page.
    setVideoResolverForTests(async () => {
      throw new Error('A download link must never reach the media resolver')
    })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    // No file extension anywhere in the URL, exactly like a download button
    // that redirects to an installer.
    const downloadUrl = server.url.replace('/file.bin', '/r2/download/pc/')
    const staged = await engine.stage({ url: downloadUrl })
    await waitFor(() => (harness!.repos.downloads.get(staged.id)?.fileSize ?? 0) === body.length)

    const row = harness.repos.downloads.get(staged.id)!
    expect(row.status).toBe('review')
    expect(row.finalUrl).toMatch(/\/file\.bin$/)
    expect(row.filename).toBe('file.bin')
    expect(harness.repos.mediaResolutions.get(staged.id)).toBeNull()
  })

  it('identifies a redirecting link before Start, so the file gets its real name', async () => {
    const body = makeBody(128 * 1024, 23)
    server = await startTestServer({ body })
    harness = await createHarness({ defaultConnections: 1 })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    // Start immediately: the link lookup is still in flight at this point, and
    // the URL's own last segment ("pc") must never become the filename.
    const staged = await engine.stage({ url: server.url.replace('/file.bin', '/r2/download/pc/') })
    await engine.startReviewDownload(staged.id)
    await waitForStatus(harness.repos, staged.id, ['completed', 'failed'])

    const row = harness.repos.downloads.get(staged.id)!
    expect(row.status, row.errorMessage ?? '').toBe('completed')
    expect(row.filename).toBe('file.bin')
    expect(row.fileSize).toBe(body.length)
    expect(row.finalPath).toMatch(/file\.bin$/)
    expect(existsSync(row.finalPath!)).toBe(true)
  })

  it('keeps a filename the user chose for a redirecting link', async () => {
    server = await startTestServer({ body: makeBody(64 * 1024, 29) })
    harness = await createHarness({ defaultConnections: 1 })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const downloadUrl = server.url.replace('/file.bin', '/r2/download/pc/')
    const staged = await engine.stage({ url: downloadUrl, filename: 'VLogNow installer.exe' })
    await waitFor(() => (harness!.repos.downloads.get(staged.id)?.fileSize ?? 0) > 0)

    const row = harness.repos.downloads.get(staged.id)!
    expect(row.filename).toBe('VLogNow installer.exe')
    expect(row.status).toBe('review')
  })

  it('routes a staged URL the server answers with a document to media resolution', async () => {
    const body = makeBody(64 * 1024, 13)
    server = await startTestServer({ body, htmlPaths: ['/watch'] })
    harness = await createHarness({ defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    setVideoResolverForTests(async () =>
      JSON.stringify({
        title: 'Page Clip',
        formats: [
          {
            url: server!.url,
            ext: 'mp4',
            vcodec: 'avc1.64001f',
            acodec: 'mp4a.40.2',
            height: 720
          }
        ]
      })
    )
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const staged = await engine.stage({ url: server.url.replace('/file.bin', '/watch/clip') })
    await waitFor(() => harness!.repos.mediaResolutions.get(staged.id) !== null)

    const pending = harness.repos.mediaResolutions.get(staged.id)!
    expect(pending.format).toBe('video')
    expect(pending.sourcePageUrl).toBe(server.url.replace('/file.bin', '/watch/clip'))
    await waitFor(() => harness!.repos.downloads.get(staged.id)?.filename === 'Page Clip.mp4')
    expect(harness.repos.downloads.get(staged.id)?.status).toBe('review')
  })

  it('honours an explicit direct-file choice even when the server answers with a page', async () => {
    server = await startTestServer({ body: makeBody(64 * 1024, 17), htmlPaths: ['/watch'] })
    harness = await createHarness({ defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    setVideoResolverForTests(async () => {
      throw new Error('An explicit direct-file choice must not reach the media resolver')
    })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const staged = await engine.stage({
      url: server.url.replace('/file.bin', '/watch/clip'),
      sourceKind: 'direct'
    })
    await waitFor(() => harness!.repos.downloads.get(staged.id)?.fileSize !== 0)

    const row = harness.repos.downloads.get(staged.id)!
    expect(row.status).toBe('review')
    expect(row.contentType).toBe('text/html; charset=utf-8')
    expect(harness.repos.mediaResolutions.get(staged.id)).toBeNull()
  })

  it('never reroutes a URL that already names a file, whatever the server sends', async () => {
    // `.html` is not a known file extension, so the URL text says nothing —
    // but it is not extension-less either, so the response cannot promote it
    // to a media page.
    server = await startTestServer({ body: makeBody(64 * 1024, 19), htmlPaths: ['/report.html'] })
    harness = await createHarness({ defaultConnections: 1 })
    configureVideoCapture({ userDataDir: harness.root })
    setVideoResolverForTests(async () => {
      throw new Error('A named file must never reach the media resolver')
    })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const staged = await engine.stage({ url: server.url.replace('/file.bin', '/report.html') })
    await waitFor(() => harness!.repos.downloads.get(staged.id)?.fileSize !== 0)

    const row = harness.repos.downloads.get(staged.id)!
    expect(row.status).toBe('review')
    expect(row.filename).toBe('report.html')
    expect(harness.repos.mediaResolutions.get(staged.id)).toBeNull()
  })
})
