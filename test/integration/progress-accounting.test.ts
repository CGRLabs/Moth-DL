import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DownloadEngine } from '../../src/main/core/engine.js'
import { closeAgents } from '../../src/main/net/httpClient.js'
import { createHarness, waitFor, type TestHarness } from '../helpers/harness.js'

const CHUNK_SIZE = 64 * 1024
const PARTIAL_BYTES = 40 * 1024

let harness: TestHarness | null = null
let engine: DownloadEngine | null = null
let server: Server | null = null
const releaseHeldResponses: (() => void)[] = []

function releaseResponses(): void {
  for (const release of releaseHeldResponses.splice(0)) release()
}

afterEach(async () => {
  releaseResponses()
  await engine?.shutdown()
  engine = null
  await harness?.cleanup()
  harness = null
  if (server) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
  closeAgents()
})

describe('live transfer progress accounting', () => {
  it('persists paused status when all range workers stop after a user pause', async () => {
    let markRangeStarted!: () => void
    const rangeStarted = new Promise<void>((resolve) => {
      markRangeStarted = resolve
    })
    server = createServer((request, response) => {
      const size = 256 * 1024
      const headers = {
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
        etag: '"pause-state"',
        'content-length': String(size)
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, headers)
        response.end()
        return
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      if (!range) {
        response.writeHead(400)
        response.end()
        return
      }
      const start = Number(range[1])
      const end = Math.min(Number(range[2]), size - 1)
      const payload = Buffer.alloc(end - start + 1, 0x41)
      response.writeHead(206, {
        ...headers,
        'content-length': String(payload.length),
        'content-range': `bytes ${start}-${end}/${size}`
      })
      response.write(payload.subarray(0, 1024), () => markRangeStarted())
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    harness = await createHarness({
      chunkSize: CHUNK_SIZE,
      defaultConnections: 1,
      autoStartDownloads: true
    })
    const { repos, settings, db } = harness
    engine = new DownloadEngine(repos, settings, db)
    const { id } = await engine.add({ url: `http://127.0.0.1:${port}/pause.bin` })
    await rangeStarted
    await waitFor(() => repos.downloads.get(id)?.status === 'downloading')

    engine.pause(id)

    await waitFor(
      () => repos.downloads.get(id)?.status === 'paused' && !engine?.isActive(id),
      { timeoutMs: 5000, message: 'a paused range task remained active or kept its downloading status' }
    )
    expect(repos.downloads.get(id)?.status).toBe('paused')
  })

  it('does not drop active-range bytes when another chunk completes', async () => {
    const fileSize = 2 * 1024 * 1024 + CHUNK_SIZE
    const body = Buffer.alloc(fileSize, 0x5a)
    const partialRanges = new Set<number>()
    let releaseThirdRange = (): void => {}
    let markPartialRange!: (start: number) => void
    const partialRangeReady = new Promise<void>((resolve) => {
      markPartialRange = (start) => {
        partialRanges.add(start)
        if (partialRanges.size === 2) resolve()
      }
    })
    let markThirdRangeReady!: () => void
    const thirdRangeReady = new Promise<void>((resolve) => {
      markThirdRangeReady = resolve
    })

    server = createServer((request, response) => {
      const headers = {
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
        etag: '"progress-accounting"',
        'content-length': String(body.length)
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, headers)
        response.end()
        return
      }

      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      if (!range) {
        response.writeHead(400)
        response.end()
        return
      }
      const start = Number(range[1])
      const end = Number(range[2])
      const payload = body.subarray(start, end + 1)
      response.writeHead(206, {
        ...headers,
        'content-length': String(payload.length),
        'content-range': `bytes ${start}-${end}/${body.length}`
      })

      if (start === 0 && end === 0) {
        response.end(payload)
      } else if (start === 0 || start === CHUNK_SIZE) {
        let released = false
        releaseHeldResponses.push(() => {
          if (released) return
          released = true
          response.end(payload.subarray(PARTIAL_BYTES))
        })
        response.write(payload.subarray(0, PARTIAL_BYTES), () => markPartialRange(start))
      } else if (start === 2 * CHUNK_SIZE) {
        let released = false
        releaseThirdRange = () => {
          if (released) return
          released = true
          response.end(payload)
        }
        releaseHeldResponses.push(releaseThirdRange)
        markThirdRangeReady()
      } else {
        response.end(payload)
      }
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    harness = await createHarness({ chunkSize: CHUNK_SIZE, defaultConnections: 3 })
    const { repos, settings, db } = harness
    engine = new DownloadEngine(repos, settings, db)
    const progress: number[] = []
    engine.on('progress', (event) => {
      progress.push(event.downloadedBytes)
    })

    const { id } = await engine.add({ url: `http://127.0.0.1:${port}/file.bin` })
    await Promise.all([partialRangeReady, thirdRangeReady])
    await waitFor(() => progress.some((bytes) => bytes > CHUNK_SIZE), {
      timeoutMs: 5000,
      message: 'parallel partial ranges did not report their received bytes'
    })

    const progressCount = progress.length
    releaseThirdRange()
    await waitFor(
      () => repos.chunks.listByDownload(id).some((chunk) => chunk.index === 2 && chunk.status === 'complete'),
      { timeoutMs: 5000, message: 'the released range did not complete' }
    )
    await waitFor(() => progress.length > progressCount, {
      timeoutMs: 5000,
      message: 'no progress update followed the chunk completion'
    })

    const observedProgress = [...progress]
    releaseResponses()
    await waitFor(() => repos.downloads.get(id)?.status === 'completed', {
      timeoutMs: 5000,
      message: 'the download did not finish after releasing the held ranges'
    })

    expect(observedProgress.every((bytes, index) => index === 0 || bytes >= (observedProgress[index - 1] ?? 0))).toBe(true)
  })
})
