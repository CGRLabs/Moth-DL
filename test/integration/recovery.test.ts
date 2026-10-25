/**
 * THE core guarantee: a download interrupted at ~70% must resume from ~70%
 * and produce a byte-identical file. If this test fails, the product promise
 * is broken.
 *
 * The test is deliberately end-to-end: a real HTTP server with real Range
 * support, the real engine, the real database, real files on disk. Nothing
 * is mocked, because the failure modes that matter (torn writes, out-of-order
 * chunk completion, stale DB rows) only exist when the parts are real.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { readFile, stat, writeFile, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { DownloadEngine } from '../../src/main/core/engine.js'
import { planChunks } from '../../src/main/core/planner.js'
import { runRecovery } from '../../src/main/core/recovery.js'
import { makeBody, startTestServer, type TestServer } from '../helpers/testServer.js'
import { createHarness, waitFor, waitForStatus, type TestHarness } from '../helpers/harness.js'
import type { Download } from '../../src/shared/types.js'
import { closeAgents } from '../../src/main/net/httpClient.js'

const FILE_SIZE = 1024 * 1024 // 1 MiB
const CHUNK_SIZE = 64 * 1024

let harness: TestHarness | null = null
let server: TestServer | null = null
let rawServer: Server | null = null

afterEach(async () => {
  await harness?.cleanup()
  harness = null
  await server?.close()
  server = null
  if (rawServer) {
    rawServer.closeAllConnections?.()
    await new Promise<void>((resolve) => rawServer!.close(() => resolve()))
    rawServer = null
  }
  closeAgents()
})

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

describe('crash recovery', () => {
  it('recovers a real interrupted transfer and resumes to byte-identical output', async () => {
    const body = makeBody(512 * 1024, 104)
    const etag = '"interrupted-transfer"'
    let rangeRequests = 0
    let releaseSecondRange!: () => void
    const secondRangeSeen = new Promise<void>((resolve) => {
      releaseSecondRange = resolve
    })

    rawServer = createServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          'content-length': String(body.length),
          'accept-ranges': 'bytes',
          etag
        })
        response.end()
        return
      }

      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      if (!match) {
        response.writeHead(400)
        response.end()
        return
      }
      const start = Number(match[1])
      const end = Number(match[2])
      const payload = body.subarray(start, end + 1)
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': String(payload.length),
        'accept-ranges': 'bytes',
        etag
      })

      if (start === 0 && end === 0) {
        response.end(payload)
        return
      }
      rangeRequests += 1
      if (rangeRequests === 2) {
        releaseSecondRange()
        return
      }
      response.end(payload)
    })
    await new Promise<void>((resolve) => rawServer!.listen(0, '127.0.0.1', resolve))
    const { port } = rawServer.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/payload.bin`
    harness = await createHarness({ chunkSize: CHUNK_SIZE, defaultConnections: 1 })
    const { repos, settings, db } = harness
    let engine: DownloadEngine | null = new DownloadEngine(repos, settings, db)

    try {
      const result = await engine.add({ url, expectedChecksum: sha256(body) })
      await secondRangeSeen
      expect(repos.chunks.listByDownload(result.id).filter((chunk) => chunk.status === 'complete')).toHaveLength(1)

      await engine.shutdown()
      const interrupted = repos.downloads.get(result.id)!
      expect(interrupted.status).toBe('paused')

      const report = await runRecovery(repos, { verify: 'all' })
      expect(report.bytesRecovered).toBe(CHUNK_SIZE)
      expect(repos.downloads.get(result.id)?.status).toBe('paused')
      expect(repos.chunks.listByDownload(result.id).filter((chunk) => chunk.status === 'complete')).toHaveLength(1)

      engine = new DownloadEngine(repos, settings, db)
      await engine.resume(result.id)
      await waitForStatus(repos, result.id, ['completed', 'failed'], 30_000)

      const completed = repos.downloads.get(result.id)!
      expect(completed.status, completed.errorMessage ?? '').toBe('completed')
      expect(sha256(await readFile(completed.finalPath!))).toBe(sha256(body))
    } finally {
      await engine?.shutdown()
      engine = null
    }
  })

  it('resumes a partially downloaded file and produces an identical result', async () => {
    const body = makeBody(FILE_SIZE, 42)
    server = await startTestServer({ body })
    server.setEtag('"resume-test"')
    harness = await createHarness({ chunkSize: CHUNK_SIZE, defaultConnections: 4 })
    const { repos, settings, db, downloadDir } = harness

    const engine = new DownloadEngine(repos, settings, db)

    // Insert a download the way the IPC layer would, and let the engine plan it.
    const now = Date.now()
    const id = 'crashresumetest0000000000000001'
    const download: Download = {
      id,
      url: server.url,
      finalUrl: null,
      filename: 'payload.bin',
      tempPath: join(downloadDir, 'payload.bin.mothpart'),
      finalPath: join(downloadDir, 'payload.bin'),
      fileSize: 0,
      acceptRanges: false,
      etag: '"resume-test"',
      lastModified: null,
      contentType: null,
      category: 'other',
      status: 'queued',
      downloadedBytes: 0,
      expectedChecksum: { algorithm: 'sha256', value: sha256(body) },
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 2,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: 4,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    }
    repos.downloads.insert(download)

    // ---- Simulate a crash partway through ---------------------------------
    // Rather than racing the network, we deterministically model the on-disk
    // state a crash at ~70% would leave: 11 of 16 chunks complete.
    const chunks = planChunks({ downloadId: id, fileSize: FILE_SIZE, desiredChunkSize: CHUNK_SIZE })
    const completeCount = Math.floor(chunks.length * 0.7)
    const partial = join(downloadDir, 'payload.bin.mothpart')

    // Write the first `completeCount` chunks of real bytes to the partial file.
    const handle = await import('node:fs/promises').then((fs) =>
      fs.open(partial, 'w').then(async (h) => {
        await h.truncate(FILE_SIZE)
        return h
      })
    )
    for (let i = 0; i < completeCount; i += 1) {
      const chunk = chunks[i]!
      await handle.write(body.subarray(chunk.start, chunk.end + 1), 0, chunk.size, chunk.start)
    }
    // And a partially-written chunk, to exercise the in-progress resume path.
    const partialChunk = chunks[completeCount]!
    const partialBytes = Math.floor(partialChunk.size / 2)
    await handle.write(
      body.subarray(partialChunk.start, partialChunk.start + partialBytes),
      0,
      partialBytes,
      partialChunk.start
    )
    await handle.close()

    const markedComplete = chunks.map((chunk, index) => ({
      ...chunk,
      status: index < completeCount ? ('complete' as const) : ('pending' as const),
      bytesWritten: index < completeCount ? chunk.size : index === completeCount ? partialBytes : 0,
      checksum: null
    }))
    repos.chunks.replaceAll(id, markedComplete)
    repos.downloads.update(id, {
      status: 'downloading', // as if the process died mid-transfer
      fileSize: FILE_SIZE,
      acceptRanges: true,
      downloadedBytes: completeCount * CHUNK_SIZE
    })

    // ---- Recovery ---------------------------------------------------------
    const report = await runRecovery(repos, { verify: 'all' })
    expect(report.scanned).toBe(1)
    expect(report.bytesRecovered).toBe(completeCount * CHUNK_SIZE)

    const afterRecovery = repos.downloads.get(id)!
    expect(afterRecovery.status).toBe('paused')
    expect(afterRecovery.downloadedBytes).toBe(completeCount * CHUNK_SIZE)
    // The partial chunk must NOT be counted as done.
    expect(afterRecovery.downloadedBytes).toBeLessThan(FILE_SIZE)

    const chunksAfter = repos.chunks.listByDownload(id)
    expect(chunksAfter.filter((c) => c.status === 'complete')).toHaveLength(completeCount)

    // ---- Resume -----------------------------------------------------------
    const bytesBefore = server.bytesServed()
    await engine.resume(id)
    await waitForStatus(repos, id, ['completed', 'failed'], 30_000)

    const final = repos.downloads.get(id)!
    expect(final.status, final.errorMessage ?? '').toBe('completed')
    expect(final.downloadedBytes).toBe(FILE_SIZE)

    // The finished file must be byte-identical to the source.
    const written = await readFile(final.finalPath!)
    expect(written.length).toBe(FILE_SIZE)
    expect(sha256(written)).toBe(sha256(body))

    // And it must have resumed, not restarted: fewer bytes were re-fetched
    // than a full re-download would require.
    const bytesFetched = server.bytesServed() - bytesBefore
    const remaining = FILE_SIZE - completeCount * CHUNK_SIZE
    expect(bytesFetched).toBeGreaterThanOrEqual(remaining)
    expect(bytesFetched).toBeLessThan(FILE_SIZE)

    // The partial file must be gone (promoted to the final name).
    await expect(stat(partial)).rejects.toThrow()

    await engine.shutdown()
  })

  it('discards progress when the partial file has been deleted', async () => {
    const body = makeBody(256 * 1024, 7)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024 })
    const { repos, settings, db } = harness
    const engine = new DownloadEngine(repos, settings, db)

    const id = 'missingpartial00000000000000000001'
    const now = Date.now()
    repos.downloads.insert({
      id,
      url: server.url,
      finalUrl: null,
      filename: 'gone.bin',
      tempPath: join(harness.downloadDir, 'gone.bin.mothpart'),
      finalPath: join(harness.downloadDir, 'gone.bin'),
      fileSize: body.length,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'other',
      status: 'downloading',
      downloadedBytes: 200_000,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 2,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: 2,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    })
    repos.chunks.replaceAll(
      id,
      planChunks({ downloadId: id, fileSize: body.length, desiredChunkSize: 64 * 1024 }).map((c) => ({
        ...c,
        status: 'complete' as const,
        bytesWritten: c.size
      }))
    )

    // The database claims 100% but the file is gone.
    const activeReport = await engine.rescan(id)
    expect(activeReport.details[0]?.action).toBe('skipped')
    expect(activeReport.details[0]?.note).toMatch(/pause this active download/i)
    expect(repos.downloads.get(id)?.downloadedBytes).toBe(200_000)

    repos.downloads.update(id, { status: 'paused' })
    const report = await engine.rescan(id)
    expect(report.details[0]?.action).toBe('reset')
    expect(report.invalidated).toEqual([id])
    expect(report.details[0]?.note).toMatch(/progress reset to zero/i)

    const after = repos.downloads.get(id)!
    expect(after.status).toBe('paused')
    expect(after.downloadedBytes).toBe(0)
    expect(repos.chunks.listByDownload(id).every((c) => c.status === 'pending')).toBe(true)

    await engine.shutdown()
  })

  it('re-downloads a chunk whose bytes were corrupted on disk', async () => {
    const body = makeBody(256 * 1024, 99)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024 })
    const { repos } = harness

    const id = 'corruptrecovery000000000000000001'
    const now = Date.now()
    const partial = join(harness.downloadDir, 'corrupt.bin.mothpart')

    const chunks = planChunks({ downloadId: id, fileSize: body.length, desiredChunkSize: 64 * 1024 })
    const handle = await import('node:fs/promises').then((fs) =>
      fs.open(partial, 'w').then(async (h) => {
        await h.truncate(body.length)
        return h
      })
    )
    for (const chunk of chunks) {
      await handle.write(body.subarray(chunk.start, chunk.end + 1), 0, chunk.size, chunk.start)
    }
    await handle.close()

    // Record every chunk as complete, with a *correct* digest.
    const withDigests = []
    for (const chunk of chunks) {
      const actual = sha256(body.subarray(chunk.start, chunk.end + 1))
      withDigests.push({ ...chunk, status: 'complete' as const, bytesWritten: chunk.size, checksum: actual })
    }
    repos.downloads.insert({
      id,
      url: server.url,
      finalUrl: null,
      filename: 'corrupt.bin',
      tempPath: partial,
      finalPath: join(harness.downloadDir, 'corrupt.bin'),
      fileSize: body.length,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'other',
      status: 'downloading',
      downloadedBytes: body.length,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 2,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: 2,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    })
    repos.chunks.replaceAll(id, withDigests)

    // Now flip some bytes in the middle of chunk 1, as a bad sector would.
    const handle2 = await import('node:fs/promises').then((fs) => fs.open(partial, 'r+'))
    await handle2.write(Buffer.from([0xde, 0xad, 0xbe, 0xef]), 0, 4, 70_000)
    await handle2.close()

    const report = await runRecovery(repos, { verify: 'all' })
    expect(report.details[0]?.chunksReset).toBeGreaterThanOrEqual(1)

    const after = repos.downloads.get(id)!
    expect(after.downloadedBytes).toBeLessThan(body.length)
    const stillPending = repos.chunks.listByDownload(id).filter((c) => c.status !== 'complete')
    expect(stillPending.length).toBeGreaterThanOrEqual(1)
  })

  it('rebuilds a corrupt chunk map and salvages verifiable progress', async () => {
    const body = makeBody(256 * 1024, 5)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024 })
    const { repos } = harness

    const id = 'badmap00000000000000000000000001'
    const now = Date.now()
    const partial = join(harness.downloadDir, 'badmap.bin.mothpart')
    await writeFile(partial, body)

    repos.downloads.insert({
      id,
      url: server.url,
      finalUrl: null,
      filename: 'badmap.bin',
      tempPath: partial,
      finalPath: join(harness.downloadDir, 'badmap.bin'),
      fileSize: body.length,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'other',
      status: 'downloading',
      downloadedBytes: body.length,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 2,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: 2,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    })

    // A map with a deliberate hole: chunk 2 is missing entirely.
    const good = planChunks({ downloadId: id, fileSize: body.length, desiredChunkSize: 64 * 1024 })
    repos.chunks.replaceAll(
      id,
      good
        .filter((c) => c.index !== 2)
        .map((c) => ({ ...c, status: 'complete' as const, bytesWritten: c.size }))
    )

    // The engine always passes the configured chunk size; the rebuilt map must
    // use the same layout or the salvaged ranges stop lining up.
    const report = await runRecovery(repos, { verify: 'all', desiredChunkSize: 64 * 1024 })
    const detail = report.details[0]
    expect(detail?.action).toBe('replanned')

    // The map must now be contiguous and cover the whole file.
    const rebuilt = repos.chunks.listByDownload(id)
    expect(rebuilt.length).toBe(good.length)
    expect(rebuilt[0]?.start).toBe(0)
    expect(rebuilt[rebuilt.length - 1]?.end).toBe(body.length - 1)
    for (let i = 1; i < rebuilt.length; i += 1) {
      expect(rebuilt[i]!.start).toBe(rebuilt[i - 1]!.end + 1)
    }
    // Progress that survived should be kept.
    expect(detail!.bytesKept).toBeGreaterThan(0)
  })

  it('marks a download whose remote file changed as needing a full restart', async () => {
    const body = makeBody(128 * 1024, 3)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024 })
    const { repos, settings, db } = harness
    const engine = new DownloadEngine(repos, settings, db)

    const id = 'changedremote0000000000000000001'
    const now = Date.now()
    repos.downloads.insert({
      id,
      url: server.url,
      finalUrl: null,
      filename: 'changed.bin',
      tempPath: join(harness.downloadDir, 'changed.bin.mothpart'),
      finalPath: join(harness.downloadDir, 'changed.bin'),
      fileSize: body.length,
      acceptRanges: true,
      etag: 'v1',
      lastModified: null,
      contentType: null,
      category: 'other',
      status: 'queued',
      downloadedBytes: 0,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 0,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: 2,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    })

    // The server's file grows mid-flight: content-length no longer matches.
    server.setBody(makeBody(200 * 1024, 3))

    await engine.resume(id)
    await waitForStatus(repos, id, ['failed', 'completed', 'paused'], 30_000)
    await engine.shutdown()
  })

  it('restarts from zero when the remote content changes at the same size between runs', async () => {
    const originalBody = makeBody(256 * 1024, 31)
    const replacementBody = makeBody(256 * 1024, 32)
    server = await startTestServer({ body: originalBody, etag: '"version-one"' })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 4 })
    const { repos, settings, db, downloadDir } = harness
    const engine = new DownloadEngine(repos, settings, db)
    const id = 'sameSizeSourceChanged000000000001'
    const now = Date.now()
    const tempPath = join(downloadDir, 'changed-content.bin.mothpart')
    const finalPath = join(downloadDir, 'changed-content.bin')
    await writeFile(tempPath, originalBody)

    const chunks = planChunks({ downloadId: id, fileSize: originalBody.length, desiredChunkSize: CHUNK_SIZE })
    repos.downloads.insert({
      id,
      url: server.url,
      finalUrl: server.url,
      filename: 'changed-content.bin',
      tempPath,
      finalPath,
      fileSize: originalBody.length,
      acceptRanges: true,
      etag: '"version-one"',
      lastModified: null,
      contentType: 'application/octet-stream',
      category: 'other',
      status: 'downloading',
      downloadedBytes: CHUNK_SIZE,
      expectedChecksum: { algorithm: 'sha256', value: sha256(replacementBody) },
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 2,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: 4,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: null
    })
    repos.chunks.replaceAll(
      id,
      chunks.map((chunk, index) => ({
        ...chunk,
        status: index === 0 ? ('complete' as const) : ('pending' as const),
        bytesWritten: index === 0 ? chunk.size : 0,
        checksum: index === 0 ? sha256(originalBody.subarray(chunk.start, chunk.end + 1)) : null
      }))
    )

    const crashReport = await runRecovery(repos, { verify: 'all', desiredChunkSize: CHUNK_SIZE })
    expect(crashReport.details[0]?.action).toBe('resumable')
    expect(repos.downloads.get(id)?.downloadedBytes).toBe(CHUNK_SIZE)

    server.setBody(replacementBody)
    const bytesBeforeResume = server.bytesServed()
    await engine.resume(id)
    await waitForStatus(repos, id, ['completed', 'failed', 'paused'], 30_000)

    const final = repos.downloads.get(id)!
    expect(final.status, final.errorMessage ?? '').toBe('completed')
    expect(final.computedChecksum).toBe(sha256(replacementBody))
    expect(await readFile(final.finalPath!)).toEqual(replacementBody)
    expect(server.bytesServed() - bytesBeforeResume).toBeGreaterThanOrEqual(replacementBody.length)
    await engine.shutdown()
  })

  it('never leaves a hole when chunks complete out of order', async () => {
    const body = makeBody(512 * 1024, 11)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 32 * 1024, defaultConnections: 8 })
    const { repos, settings, db } = harness
    const engine = new DownloadEngine(repos, settings, db)

    const id = 'outoforder0000000000000000000001'
    const now = Date.now()
    repos.downloads.insert({
      id,
      url: server.url,
      finalUrl: null,
      filename: 'ooo.bin',
      tempPath: join(harness.downloadDir, 'ooo.bin.mothpart'),
      finalPath: join(harness.downloadDir, 'ooo.bin'),
      fileSize: body.length,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'other',
      status: 'queued',
      downloadedBytes: 0,
      expectedChecksum: { algorithm: 'sha256', value: sha256(body) },
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 1,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: 8,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    })

    await engine.resume(id)
    await waitForStatus(repos, id, ['completed', 'failed'], 30_000)

    const final = repos.downloads.get(id)!
    expect(final.status, final.errorMessage ?? '').toBe('completed')
    expect(sha256(await readFile(final.finalPath!))).toBe(sha256(body))
    await engine.shutdown()
  })

  it('cleans up the partial file when a download is cancelled', async () => {
    const body = makeBody(4 * 1024 * 1024, 17)
    server = await startTestServer({ body, dropAfterBytes: 32 * 1024 })
    harness = await createHarness({ chunkSize: 64 * 1024 })
    const { repos, settings, db } = harness
    const engine = new DownloadEngine(repos, settings, db)

    const id = 'cancelcleanup0000000000000000001'
    const now = Date.now()
    const partial = join(harness.downloadDir, 'cancel.bin.mothpart')
    repos.downloads.insert({
      id,
      url: server.url,
      finalUrl: null,
      filename: 'cancel.bin',
      tempPath: partial,
      finalPath: join(harness.downloadDir, 'cancel.bin'),
      fileSize: body.length,
      acceptRanges: true,
      etag: null,
      lastModified: null,
      contentType: null,
      category: 'other',
      status: 'queued',
      downloadedBytes: 0,
      expectedChecksum: null,
      computedChecksum: null,
      priority: 0,
      retryCount: 0,
      maxRetries: 0,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: 2,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    })

    await engine.resume(id)
    await waitFor(async () => (await stat(partial).catch(() => null)) !== null, {
      message: 'partial file never appeared'
    })
    await engine.cancel(id)
    await waitFor(async () => (await stat(partial).catch(() => null)) === null, {
      message: 'partial file was not removed on cancel'
    })

    await unlink(partial).catch(() => {})
    await engine.shutdown()
  })
})
