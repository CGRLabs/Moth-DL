/**
 * Regression tests for the three W3 durability risks (W4 fixes).
 *
 * A focused file rather than extensions to recovery.test.ts: these are the
 * durability-critical-path guarantees (checksum disposition, promote-before-
 * record, If-Range soundness), kept together with the shared real-server
 * harness so each risk's old-code failure mode stays readable next to its fix.
 * Every test below FAILS on the pre-fix code — noted per test.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DownloadEngine } from '../../src/main/core/engine.js'
import { planChunks } from '../../src/main/core/planner.js'
import { runRecovery } from '../../src/main/core/recovery.js'
import { makeBody, startTestServer, type TestServer } from '../helpers/testServer.js'
import { createHarness, waitForStatus, type TestHarness } from '../helpers/harness.js'
import type { Download } from '../../src/shared/types.js'
import { closeAgents, openRange, probe } from '../../src/main/net/httpClient.js'
import { setWriterSyncOperationForTests } from '../../src/main/core/writer.js'

let harness: TestHarness | null = null
let server: TestServer | null = null

afterEach(async () => {
  setWriterSyncOperationForTests(null)
  await harness?.cleanup()
  harness = null
  await server?.close()
  server = null
  closeAgents()
})

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function baseDownload(overrides: Partial<Download> & { id: string; url: string }): Download {
  const now = Date.now()
  return {
    finalUrl: null,
    filename: 'w4.bin',
    tempPath: join(harness!.downloadDir, 'w4.bin.mothpart'),
    finalPath: join(harness!.downloadDir, 'w4.bin'),
    fileSize: 0,
    acceptRanges: false,
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
    completedAt: null,
    ...overrides
  }
}

describe('W4 engine fixes', () => {
  it.each([false, true])('removes partial data and handles the completed file choice (deleteFile=%s)', async (deleteFile) => {
    harness = await createHarness()
    const { repos, settings, db, downloadDir } = harness
    const engine = new DownloadEngine(repos, settings, db)
    const id = `remove-choice-${deleteFile}`
    const tempPath = join(downloadDir, `${id}.mothpart`)
    const finalPath = join(downloadDir, `${id}.bin`)
    await writeFile(tempPath, Buffer.from('partial'))
    await writeFile(finalPath, Buffer.from('complete'))
    repos.downloads.insert(
      baseDownload({
        id,
        url: 'http://127.0.0.1:1/file.bin',
        filename: `${id}.bin`,
        tempPath,
        finalPath,
        status: 'completed',
        downloadedBytes: 8
      })
    )

    await engine.remove(id, deleteFile)

    expect(repos.downloads.get(id)).toBeNull()
    await expect(stat(tempPath)).rejects.toThrow()
    if (deleteFile) await expect(stat(finalPath)).rejects.toThrow()
    else expect(await readFile(finalPath, 'utf8')).toBe('complete')
    await engine.shutdown()
  })

  it('clears completed downloads without deleting their files', async () => {
    harness = await createHarness()
    const { repos, settings, db, downloadDir } = harness
    const engine = new DownloadEngine(repos, settings, db)
    const id = 'clear-completed-keeps-file'
    const finalPath = join(downloadDir, `${id}.bin`)
    await writeFile(finalPath, Buffer.from('complete'))
    repos.downloads.insert(
      baseDownload({
        id,
        url: 'http://127.0.0.1:1/file.bin',
        filename: `${id}.bin`,
        finalPath,
        status: 'completed',
        downloadedBytes: 8
      })
    )

    expect(engine.clearCompleted()).toEqual([id])
    expect(repos.downloads.get(id)).toBeNull()
    expect(await readFile(finalPath, 'utf8')).toBe('complete')
    await engine.shutdown()
  })

  it('keeps partial bytes when a refreshed URL has the same strong ETag and size', async () => {
    const body = makeBody(256 * 1024, 81)
    server = await startTestServer({ body })
    server.setEtag('"same-file"')
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 2 })
    const { repos, settings, db, downloadDir } = harness
    const engine = new DownloadEngine(repos, settings, db)
    const id = 'refreshsameetag000000000000000001'
    const tempPath = join(downloadDir, 'refresh.bin.mothpart')
    const finalPath = join(downloadDir, 'refresh.bin')
    const chunks = planChunks({ downloadId: id, fileSize: body.length, desiredChunkSize: 64 * 1024 })
    await writeFile(tempPath, body.subarray(0, 64 * 1024))
    repos.downloads.insert(
      baseDownload({
        id,
        url: 'https://expired.example/file.bin?token=old',
        filename: 'refresh.bin',
        tempPath,
        finalPath,
        fileSize: body.length,
        acceptRanges: true,
        etag: '"same-file"',
        status: 'failed',
        downloadedBytes: 64 * 1024,
        expectedChecksum: { algorithm: 'sha256', value: sha256(body) }
      })
    )
    repos.chunks.replaceAll(
      id,
      chunks.map((chunk, index) =>
        index === 0
          ? { ...chunk, status: 'complete' as const, bytesWritten: chunk.size }
          : chunk
      )
    )

    const refreshed = await engine.refreshDownloadUrl(id, server.url)
    expect(refreshed.keptProgress).toBe(true)
    await waitForStatus(repos, id, ['completed', 'failed'], 30_000)

    const download = repos.downloads.get(id)!
    expect(download.status, download.errorMessage ?? '').toBe('completed')
    expect(sha256(await readFile(finalPath))).toBe(sha256(body))
    // URL refresh probes once; resumed progress is revalidated again before reuse.
    expect(server.rangeRequestCount()).toBe(5)
    await engine.shutdown()
  })

  it('discards partial bytes when a refreshed URL has a different ETag', async () => {
    const body = makeBody(256 * 1024, 82)
    server = await startTestServer({ body })
    server.setEtag('"new-file-version"')
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 2 })
    const { repos, settings, db, downloadDir } = harness
    const engine = new DownloadEngine(repos, settings, db)
    const id = 'refreshdifferentetag0000000000000001'
    const tempPath = join(downloadDir, 'refresh-reset.bin.mothpart')
    const finalPath = join(downloadDir, 'refresh-reset.bin')
    const chunks = planChunks({ downloadId: id, fileSize: body.length, desiredChunkSize: 64 * 1024 })
    await writeFile(tempPath, body.subarray(0, 64 * 1024))
    repos.downloads.insert(
      baseDownload({
        id,
        url: 'https://expired.example/file.bin?token=old',
        filename: 'refresh-reset.bin',
        tempPath,
        finalPath,
        fileSize: body.length,
        acceptRanges: true,
        etag: '"old-file-version"',
        status: 'failed',
        downloadedBytes: 64 * 1024,
        expectedChecksum: { algorithm: 'sha256', value: sha256(body) }
      })
    )
    repos.chunks.replaceAll(
      id,
      chunks.map((chunk, index) =>
        index === 0
          ? { ...chunk, status: 'complete' as const, bytesWritten: chunk.size }
          : chunk
      )
    )

    const refreshed = await engine.refreshDownloadUrl(id, server.url)
    expect(refreshed.keptProgress).toBe(false)
    await waitForStatus(repos, id, ['completed', 'failed'], 30_000)

    const download = repos.downloads.get(id)!
    expect(download.status, download.errorMessage ?? '').toBe('completed')
    expect(sha256(await readFile(finalPath))).toBe(sha256(body))
    expect(server.bytesServed()).toBeGreaterThanOrEqual(body.length)
    await engine.shutdown()
  })

  it('does not trust completed ranges on resume when the source has no validator', async () => {
    const body = makeBody(128 * 1024, 83)
    server = await startTestServer({ body, sendValidators: false })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 2 })
    const { repos, settings, db, downloadDir } = harness
    const engine = new DownloadEngine(repos, settings, db)
    const id = 'novalidatorcomplete0000000000000001'
    const tempPath = join(downloadDir, 'no-validator.bin.mothpart')
    const finalPath = join(downloadDir, 'no-validator.bin')
    const chunks = planChunks({ downloadId: id, fileSize: body.length, desiredChunkSize: 64 * 1024 })
    await writeFile(tempPath, body.subarray(0, 64 * 1024))
    repos.downloads.insert(
      baseDownload({
        id,
        url: server.url,
        filename: 'no-validator.bin',
        tempPath,
        finalPath,
        fileSize: body.length,
        acceptRanges: true,
        status: 'paused',
        downloadedBytes: 64 * 1024
      })
    )
    repos.chunks.replaceAll(
      id,
      chunks.map((chunk, index) =>
        index === 0
          ? { ...chunk, status: 'complete' as const, bytesWritten: chunk.size }
          : chunk
      )
    )

    await engine.resume(id)
    await waitForStatus(repos, id, ['completed', 'failed'], 30_000)

    const download = repos.downloads.get(id)!
    expect(download.status, download.errorMessage ?? '').toBe('completed')
    expect(sha256(await readFile(finalPath))).toBe(sha256(body))
    expect(server.bytesServed()).toBeGreaterThanOrEqual(body.length)
    await engine.shutdown()
  })

  it('downloads a non-range server as one sequential stream', async () => {
    const body = makeBody(192 * 1024, 18)
    server = await startTestServer({ body, supportRanges: false })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 4 })
    const { repos, settings, db } = harness
    const engine = new DownloadEngine(repos, settings, db)

    const result = await engine.add({ url: server.url })
    await waitForStatus(repos, result.id, ['completed', 'failed'], 30_000)

    const download = repos.downloads.get(result.id)!
    expect(download.status, download.errorMessage ?? '').toBe('completed')
    expect(sha256(await readFile(download.finalPath!))).toBe(sha256(body))
    expect(repos.chunks.listByDownload(result.id)).toHaveLength(1)

    await engine.shutdown()
  })

  it('recovers from a one-time dropped range response without corrupting the output', async () => {
    const body = makeBody(256 * 1024, 97)
    server = await startTestServer({
      body,
      dropAfterBytes: 16 * 1024,
      dropFirstResponses: 1
    })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 1 })
    const { repos, settings, db } = harness
    const engine = new DownloadEngine(repos, settings, db)

    const result = await engine.add({ url: server.url })
    await waitForStatus(repos, result.id, ['completed', 'failed'], 30_000)

    const download = repos.downloads.get(result.id)!
    expect(download.status, download.errorMessage ?? '').toBe('completed')
    expect(await readFile(download.finalPath!)).toEqual(body)
    expect(server.bytesServed()).toBeGreaterThan(body.length)
    expect(server.rangeRequestCount()).toBeGreaterThan(4)
    await engine.shutdown()
  })

  it('does not mark a chunk complete or promote output when fsync fails', async () => {
    const body = makeBody(64 * 1024, 102)
    server = await startTestServer({ body })
    harness = await createHarness({
      chunkSize: body.length,
      defaultConnections: 1,
      maxRetries: 0
    })
    const { repos, settings, db } = harness
    const engine = new DownloadEngine(repos, settings, db)
    setWriterSyncOperationForTests(async () => {
      throw Object.assign(new Error('simulated disk sync failure'), { code: 'EIO' })
    })

    const result = await engine.add({ url: server.url })
    await waitForStatus(repos, result.id, ['failed', 'completed'], 30_000)

    const download = repos.downloads.get(result.id)!
    expect(download.status).toBe('failed')
    expect(download.errorMessage).toContain('simulated disk sync failure')
    expect(repos.chunks.listByDownload(result.id).every((chunk) => chunk.status !== 'complete')).toBe(true)
    await expect(access(download.finalPath!)).rejects.toThrow()
    await engine.shutdown()
  })

  it('reports disk-full sync failures without retrying or completing chunks', async () => {
    const body = makeBody(64 * 1024, 103)
    server = await startTestServer({ body })
    harness = await createHarness({
      chunkSize: body.length,
      defaultConnections: 1,
      maxRetries: 0
    })
    const { repos, settings, db } = harness
    const engine = new DownloadEngine(repos, settings, db)
    setWriterSyncOperationForTests(async () => {
      throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' })
    })

    const result = await engine.add({ url: server.url })
    await waitForStatus(repos, result.id, ['failed', 'completed'], 30_000)

    const download = repos.downloads.get(result.id)!
    expect(download.status).toBe('failed')
    expect(download.errorCode).toBe('DISK_FULL')
    expect(download.errorMessage).toContain('Not enough free disk space')
    expect(download.retryCount).toBe(1)
    expect(repos.chunks.listByDownload(result.id).every((chunk) => chunk.status !== 'complete')).toBe(true)
    await expect(access(download.finalPath!)).rejects.toThrow()
    await engine.shutdown()
  })

  it('fails safely when the source changes between ranges during an active download', async () => {
    const originalBody = makeBody(256 * 1024, 98)
    const replacementBody = makeBody(256 * 1024, 99)
    let body = originalBody
    let etag = '"version-one"'
    let rangeResponses = 0
    const changingServer = createServer((request, response) => {
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

      const ifRange = request.headers['if-range']
      if (typeof ifRange === 'string' && ifRange !== etag) {
        response.writeHead(200, {
          'content-length': String(body.length),
          'accept-ranges': 'bytes',
          etag
        })
        response.end(body)
        return
      }

      const start = Number.parseInt(match[1]!, 10)
      const end = Math.min(Number.parseInt(match[2]!, 10), body.length - 1)
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        etag
      })
      rangeResponses += 1
      if (rangeResponses === 1) {
        response.once('finish', () => {
          body = replacementBody
          etag = '"version-two"'
        })
      }
      response.end(body.subarray(start, end + 1))
    })
    await new Promise<void>((resolve) => changingServer.listen(0, '127.0.0.1', resolve))
    const address = changingServer.address() as AddressInfo
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 1 })
    const engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    try {
      const result = await engine.add({ url: `http://127.0.0.1:${address.port}/payload.bin` })
      await waitForStatus(harness.repos, result.id, ['completed', 'failed'], 30_000)

      const download = harness.repos.downloads.get(result.id)!
      expect(download.status).toBe('failed')
      expect(download.errorCode).toBe('RANGE_UNSUPPORTED')
      expect(download.errorMessage).toContain('ignored the Range header')
      await expect(access(download.finalPath!)).rejects.toThrow()
      expect(rangeResponses).toBeGreaterThanOrEqual(1)
    } finally {
      await engine.shutdown()
      await new Promise<void>((resolve) => {
        changingServer.closeAllConnections()
        changingServer.close(() => resolve())
      })
    }
  })

  it('does not forward authorization or cookies to another redirect origin', async () => {
    const receivedHeaders: { value: IncomingHttpHeaders | null } = { value: null }
    const destination = createServer((request, response) => {
      receivedHeaders.value = request.headers
      response.writeHead(206, {
        'content-range': 'bytes 0-1/2',
        'content-length': '2'
      })
      response.end('ok')
    })
    const redirect = createServer((_request, response) => {
      const address = destination.address() as AddressInfo
      response.writeHead(302, { location: `http://127.0.0.1:${address.port}/file` })
      response.end()
    })
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
    const redirectAddress = redirect.address() as AddressInfo
    try {
      const result = await openRange({
        url: `http://127.0.0.1:${redirectAddress.port}/redirect`,
        start: 0,
        end: 1,
        headers: {
          Authorization: 'Bearer private-token',
          Cookie: 'session=private-cookie',
          'X-Download-Option': 'preserved'
        }
      })
      result.stream.resume()
      await new Promise<void>((resolve, reject) => {
        result.stream.once('end', resolve)
        result.stream.once('error', reject)
      })

      expect(receivedHeaders.value?.authorization).toBeUndefined()
      expect(receivedHeaders.value?.cookie).toBeUndefined()
      expect(receivedHeaders.value?.['x-download-option']).toBe('preserved')
    } finally {
      await Promise.all(
        [redirect, destination].map(
          (httpServer) =>
            new Promise<void>((resolve) => {
              httpServer.closeAllConnections()
              httpServer.close(() => resolve())
            })
        )
      )
    }
  })

  it('keeps redirect credential filtering on the engine download path', async () => {
    const body = makeBody(32 * 1024, 91)
    const receivedHeaders: IncomingHttpHeaders[] = []
    const destination = createServer((request, response) => {
      receivedHeaders.push(request.headers)
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      if (!match) {
        response.writeHead(400)
        response.end()
        return
      }
      const start = Number(match[1])
      const end = Math.min(Number(match[2]), body.length - 1)
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
        etag: '"engine-redirect-v1"'
      })
      response.end(body.subarray(start, end + 1))
    })
    const redirect = createServer((_request, response) => {
      const address = destination.address() as AddressInfo
      response.writeHead(302, { location: `http://127.0.0.1:${address.port}/payload` })
      response.end()
    })
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
    const redirectAddress = redirect.address() as AddressInfo
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 2 })
    const engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    try {
      const result = await engine.add({
        url: `http://127.0.0.1:${redirectAddress.port}/redirect`,
        headers: {
          Authorization: '******',
          Cookie: 'session=private-cookie',
          'X-Download-Option': 'preserved'
        }
      })
      await waitForStatus(harness.repos, result.id, ['completed', 'failed'], 30_000)

      const download = harness.repos.downloads.get(result.id)!
      expect(download.status, download.errorMessage ?? '').toBe('completed')
      expect(sha256(await readFile(download.finalPath!))).toBe(sha256(body))
      expect(receivedHeaders.length).toBeGreaterThan(1)
      for (const headers of receivedHeaders) {
        expect(headers.authorization).toBeUndefined()
        expect(headers.cookie).toBeUndefined()
        expect(headers['x-download-option']).toBe('preserved')
      }
    } finally {
      await engine.shutdown()
      await Promise.all(
        [redirect, destination].map(
          (httpServer) =>
            new Promise<void>((resolve) => {
              httpServer.closeAllConnections()
              httpServer.close(() => resolve())
            })
        )
      )
    }
  })

  it('redacts signed query parameters from HTTP error messages', async () => {
    const protectedServer = createServer((_request, response) => {
      response.writeHead(403)
      response.end()
    })
    await new Promise<void>((resolve) => protectedServer.listen(0, '127.0.0.1', resolve))
    const address = protectedServer.address() as AddressInfo
    try {
      await expect(
        probe(`http://127.0.0.1:${address.port}/videoplayback?sig=private-token`)
      ).rejects.toMatchObject({
        code: 'HTTP_CLIENT_ERROR',
        message: expect.not.stringContaining('private-token')
      })
    } finally {
      await new Promise<void>((resolve) => {
        protectedServer.closeAllConnections()
        protectedServer.close(() => resolve())
      })
    }
  })

  it('parses a Retry-After response into a bounded retry delay', async () => {
    server = await startTestServer({ failFirst: 1, retryAfter: '120' })

    await expect(
      openRange({ url: server.url, start: 0, end: 1 })
    ).rejects.toMatchObject({
      code: 'HTTP_SERVER_ERROR',
      context: { retryAfterMs: 120_000 }
    })
  })

  it('rejects an oversized 206 range before it can overwrite neighboring chunk bytes', async () => {
    const rangeServer = createServer((_request, response) => {
      response.writeHead(206, {
        'content-range': 'bytes 0-3/8',
        'content-length': '4'
      })
      response.end('abcd')
    })
    await new Promise<void>((resolve) => rangeServer.listen(0, '127.0.0.1', resolve))
    const address = rangeServer.address() as AddressInfo
    try {
      await expect(
        openRange({ url: `http://127.0.0.1:${address.port}/file`, start: 0, end: 1 })
      ).rejects.toMatchObject({
        code: 'NETWORK',
        message: expect.stringContaining('bytes=0-1')
      })
    } finally {
      await new Promise<void>((resolve) => {
        rangeServer.closeAllConnections()
        rangeServer.close(() => resolve())
      })
    }
  })

  it('does not complete a download when the response body exceeds its requested range', async () => {
    const fileSize = 64 * 1024
    const rangeServer = createServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          'content-length': String(fileSize),
          'accept-ranges': 'bytes'
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
      const start = Number.parseInt(match[1]!, 10)
      const end = Number.parseInt(match[2]!, 10)
      response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${fileSize}` })
      response.end(Buffer.alloc(end - start + 2, 0x61))
    })
    await new Promise<void>((resolve) => rangeServer.listen(0, '127.0.0.1', resolve))
    const address = rangeServer.address() as AddressInfo
    harness = await createHarness({ chunkSize: fileSize, defaultConnections: 1, maxRetries: 1 })
    const downloadEngine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    try {
      const result = await downloadEngine.add({ url: `http://127.0.0.1:${address.port}/video.mp4` })
      await waitForStatus(harness.repos, result.id, ['failed', 'completed'], 30_000)

      const download = harness.repos.downloads.get(result.id)!
      expect(download.status).toBe('failed')
      expect(download.errorMessage).toContain('more bytes than requested')
      await expect(access(download.finalPath!)).rejects.toThrow()
    } finally {
      await downloadEngine.shutdown()
      await new Promise<void>((resolve) => {
        rangeServer.closeAllConnections()
        rangeServer.close(() => resolve())
      })
    }
  })

  it('uses a safe server Content-Disposition filename when no name was supplied', async () => {
    server = await startTestServer({
      contentDisposition: "attachment; filename*=UTF-8''..%2F..%2Fserver%20name.bin"
    })
    harness = await createHarness({ autoStartDownloads: false })
    const engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({ url: server.url })

    expect(result.filename).toBe('server name.bin')
    expect(harness.repos.downloads.get(result.id)?.filename).toBe('server name.bin')
    await engine.shutdown()
  })

  it('RISK 1: checksum mismatch is terminal for auto-retry, discards the poison, and a manual retry re-downloads cleanly', async () => {
    const body = makeBody(256 * 1024, 21)
    server = await startTestServer({ body })
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 4 })
    const { repos, settings, db, downloadDir } = harness
    const engine = new DownloadEngine(repos, settings, db)

    const id = 'w4checksum0000000000000000000001'
    const tempPath = join(downloadDir, 'w4.bin.mothpart')
    // A wrong-but-well-formed digest: verification runs and must fail.
    const wrongDigest = sha256(makeBody(256 * 1024, 22))
    repos.downloads.insert(
      baseDownload({
        id,
        url: server.url,
        tempPath,
        finalPath: join(downloadDir, 'w4.bin'),
        expectedChecksum: { algorithm: 'sha256', value: wrongDigest },
        maxRetries: 5,
        connections: 4
      })
    )

    await engine.resume(id)
    await waitForStatus(repos, id, ['failed'], 30_000)

    const failed = repos.downloads.get(id)!
    expect(failed.errorCode).toBe('CHECKSUM_MISMATCH')
    // UI-visible: says what happened and what to do.
    expect(failed.errorMessage ?? '').toContain('failed checksum verification')
    expect(failed.errorMessage ?? '').toContain('Retry')
    // No automatic retry loop: terminal failure, not re-queued.
    expect(failed.status).toBe('failed')

    // The corrupt file is DELETED (re-fetchable bytes; keeping a corrupt file
    // next to good ones is not an option) and the map is reset.
    // OLD CODE: temp still on disk, map fully complete -> both fail.
    await expect(stat(tempPath)).rejects.toThrow()
    expect(repos.chunks.listByDownload(id).every((c) => c.status === 'pending')).toBe(true)
    expect(failed.downloadedBytes).toBe(0)

    // Explicit user retry with the corrected digest re-downloads cleanly.
    // OLD CODE: re-verifies the same poisoned bytes -> fails again forever.
    repos.downloads.update(id, {
      expectedChecksum: { algorithm: 'sha256', value: sha256(body) }
    })
    engine.retry(id)
    await waitForStatus(repos, id, ['completed', 'failed'], 30_000)

    const final = repos.downloads.get(id)!
    expect(final.status, final.errorMessage ?? '').toBe('completed')
    expect(sha256(await readFile(final.finalPath!))).toBe(sha256(body))

    await engine.shutdown()
  })

  it('RISK 2: recovery claims a promoted final file (with digest) instead of wiping to zero', async () => {
    const body = makeBody(256 * 1024, 33)
    harness = await createHarness({ chunkSize: 64 * 1024 })
    const { repos, downloadDir } = harness

    const id = 'w4promoted0000000000000000000001'
    const tempPath = join(downloadDir, 'promoted.bin.mothpart')
    const finalPath = join(downloadDir, 'promoted.bin')
    // Crash window state: move succeeded, completed-commit never ran.
    await writeFile(finalPath, body)
    const chunks = planChunks({
      downloadId: id,
      fileSize: body.length,
      desiredChunkSize: 64 * 1024
    }).map((c) => ({ ...c, status: 'complete' as const, bytesWritten: c.size, checksum: null }))
    repos.downloads.insert(
      baseDownload({
        id,
        url: 'http://127.0.0.1:1/file.bin',
        filename: 'promoted.bin',
        tempPath,
        finalPath,
        fileSize: body.length,
        acceptRanges: true,
        status: 'downloading',
        downloadedBytes: body.length,
        expectedChecksum: { algorithm: 'sha256', value: sha256(body) }
      })
    )
    repos.chunks.replaceAll(id, chunks)

    const report = await runRecovery(repos, { verify: 'all' })

    // OLD CODE: action 'reset', status paused, downloadedBytes 0 (and the
    // next resume would DELETE the good final file). All three fail there.
    expect(report.details[0]?.bytesKept).toBe(body.length)
    const after = repos.downloads.get(id)!
    expect(after.status).toBe('completed')
    expect(after.downloadedBytes).toBe(body.length)
    expect(sha256(await readFile(finalPath))).toBe(sha256(body))
    expect(repos.chunks.listByDownload(id).every((c) => c.status === 'complete')).toBe(true)
    await expect(stat(tempPath)).rejects.toThrow()
  })

  it('RISK 2: recovery claims a promoted final file by size when no digest was ever recorded', async () => {
    const body = makeBody(128 * 1024, 34)
    harness = await createHarness({ chunkSize: 64 * 1024 })
    const { repos, downloadDir } = harness

    const id = 'w4promoted0000000000000000000002'
    const finalPath = join(downloadDir, 'promoted-size.bin')
    await writeFile(finalPath, body)
    repos.downloads.insert(
      baseDownload({
        id,
        url: 'http://127.0.0.1:1/file.bin',
        filename: 'promoted-size.bin',
        tempPath: join(downloadDir, 'promoted-size.bin.mothpart'),
        finalPath,
        fileSize: body.length,
        acceptRanges: true,
        status: 'downloading',
        downloadedBytes: body.length,
        expectedChecksum: null,
        computedChecksum: null
      })
    )
    repos.chunks.replaceAll(
      id,
      planChunks({ downloadId: id, fileSize: body.length, desiredChunkSize: 64 * 1024 }).map((c) => ({
        ...c,
        status: 'complete' as const,
        bytesWritten: c.size,
        checksum: null
      }))
    )

    await runRecovery(repos, { verify: 'all' })

    // OLD CODE: wiped to zero. Fails there.
    const after = repos.downloads.get(id)!
    expect(after.status).toBe('completed')
    expect(after.downloadedBytes).toBe(body.length)
  })

  it('RISK 3: a weak ETag is never sent as If-Range; the download succeeds', async () => {
    const body = makeBody(256 * 1024, 44)
    server = await startTestServer({ body })
    // S3/CloudFront-style weak validator. A server MUST ignore it in
    // If-Range (the harness models this with a 200 downgrade).
    server.setEtag('W/"weak-044"')
    harness = await createHarness({ chunkSize: 64 * 1024, defaultConnections: 2 })
    const { repos, settings, db, downloadDir } = harness
    const engine = new DownloadEngine(repos, settings, db)

    const id = 'w4weaketag0000000000000000000001'
    repos.downloads.insert(
      baseDownload({
        id,
        url: server.url,
        tempPath: join(downloadDir, 'weak.bin.mothpart'),
        finalPath: join(downloadDir, 'weak.bin'),
        filename: 'weak.bin',
        expectedChecksum: { algorithm: 'sha256', value: sha256(body) }
      })
    )

    await engine.resume(id)
    await waitForStatus(repos, id, ['completed', 'failed'], 30_000)

    // OLD CODE: forwards `If-Range: W/...` verbatim -> server downgrades to
    // 200 -> RANGE_UNSUPPORTED, permanently failed. Fails there.
    const final = repos.downloads.get(id)!
    expect(final.status, final.errorMessage ?? '').toBe('completed')
    expect(sha256(await readFile(final.finalPath!))).toBe(sha256(body))

    await engine.shutdown()
  })

  it('RISK 3: resumed progress with no usable validator is discarded, not stitched', async () => {
    // Chunk (2 MiB) > REWIND_SAFETY_BYTES (1 MiB), so the engine would keep a
    // 1 MiB prefix of old bytes — the exact window where silent stitching
    // would happen without failed-open discard.
    const CHUNK = 2 * 1024 * 1024
    const body = makeBody(5 * 1024 * 1024, 55)
    server = await startTestServer({ body, sendValidators: false })
    harness = await createHarness({ chunkSize: CHUNK, defaultConnections: 2 })
    const { repos, settings, db, downloadDir } = harness
    const engine = new DownloadEngine(repos, settings, db)

    const id = 'w4novalidator00000000000000000001'
    const tempPath = join(downloadDir, 'noval.bin.mothpart')
    const finalPath = join(downloadDir, 'noval.bin')

    // Seed the partial file: fully written, but the first 1 MiB (the bytes a
    // resume would KEEP: bytesWritten - rewind) are corrupt.
    const handle = await open(tempPath, 'w')
    try {
      await handle.truncate(body.length)
      await handle.write(body, 0, body.length, 0)
      await handle.write(Buffer.alloc(1024 * 1024, 0xa5), 0, 1024 * 1024, 0)
    } finally {
      await handle.close()
    }

    const chunks = planChunks({ downloadId: id, fileSize: body.length, desiredChunkSize: CHUNK })
    repos.downloads.insert(
      baseDownload({
        id,
        url: server.url,
        filename: 'noval.bin',
        tempPath,
        finalPath,
        fileSize: body.length,
        acceptRanges: true,
        etag: null,
        lastModified: null,
        expectedChecksum: { algorithm: 'sha256', value: sha256(body) }
      })
    )
    repos.chunks.replaceAll(
      id,
      chunks.map((c, index) =>
        index === 0
          ? { ...c, status: 'pending' as const, bytesWritten: c.size, checksum: null }
          : { ...c, status: 'pending' as const, bytesWritten: 0, checksum: null }
      )
    )

    await engine.resume(id)
    await waitForStatus(repos, id, ['completed', 'failed'], 30_000)

    // OLD CODE: keeps the corrupt prefix (size check passes, no validator to
    // catch it) -> finalise CHECKSUM_MISMATCH -> failed. Fails there.
    const final = repos.downloads.get(id)!
    expect(final.status, final.errorMessage ?? '').toBe('completed')
    expect(sha256(await readFile(final.finalPath!))).toBe(sha256(body))

    await engine.shutdown()
  })
})
