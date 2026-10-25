import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DownloadEngine } from '../../src/main/core/engine.js'
import { closeAgents } from '../../src/main/net/httpClient.js'
import { createHarness, waitFor, type TestHarness } from '../helpers/harness.js'

let harness: TestHarness | null = null
let engines: DownloadEngine[] = []
let server: Server | null = null

afterEach(async () => {
  for (const engine of engines.reverse()) await engine.shutdown()
  engines = []
  await harness?.cleanup()
  harness = null
  if (server) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
  closeAgents()
})

describe('queue plans', () => {
  it('persists a future plan across restart and runs selected downloads smallest-first', async () => {
    const files = new Map([
      ['/small.bin', Buffer.alloc(24 * 1024, 0x31)],
      ['/large.bin', Buffer.alloc(192 * 1024, 0x72)]
    ])
    server = createServer((request, response) => {
      const body = files.get(request.url ?? '')
      if (!body) {
        response.writeHead(404).end()
        return
      }
      const common = {
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
        etag: `"${request.url}"`,
        'content-length': String(body.length)
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, common).end()
        return
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      if (!range) {
        response.writeHead(400).end()
        return
      }
      const start = Number(range[1])
      const end = Math.min(Number(range[2]), body.length - 1)
      const payload = body.subarray(start, end + 1)
      response.writeHead(206, {
        ...common,
        'content-length': String(payload.length),
        'content-range': `bytes ${start}-${end}/${body.length}`
      }).end(payload)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    harness = await createHarness({
      autoStartDownloads: false,
      maxConcurrentDownloads: 1,
      defaultConnections: 1
    })
    const firstEngine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    engines.push(firstEngine)
    const large = await firstEngine.add({ url: `http://127.0.0.1:${port}/large.bin` })
    const small = await firstEngine.add({ url: `http://127.0.0.1:${port}/small.bin` })
    const plan = firstEngine.createQueuePlan({
      name: 'Night run',
      downloadIds: [large.id, small.id],
      startsAt: Date.now() + 300,
      durationMinutes: 2,
      strategy: 'smallest-first',
      endAction: 'continue'
    })[0]
    expect(plan?.status).toBe('scheduled')
    expect(harness.repos.downloads.get(large.id)?.status).toBe('queued')

    await firstEngine.shutdown()
    engines = []
    const resumedEngine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    engines.push(resumedEngine)
    const completionOrder: string[] = []
    resumedEngine.on('finished', ({ id }) => completionOrder.push(id))
    await resumedEngine.start()

    await waitFor(
      () => harness?.repos.queuePlans.get(plan!.id)?.status === 'completed',
      { timeoutMs: 10_000, message: 'the restarted engine did not finish its queue plan' }
    )
    expect(completionOrder).toEqual([small.id, large.id])
    expect(harness.repos.downloads.get(small.id)?.status).toBe('completed')
    expect(harness.repos.downloads.get(large.id)?.status).toBe('completed')
  })

  it.each([
    ['pause', 'paused'],
    ['continue', 'completed']
  ] as const)('applies the %s end action when a plan window has expired', async (endAction, expectedStatus) => {
    const body = Buffer.alloc(16 * 1024, 0x5c)
    server = createServer((request, response) => {
      const headers = {
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
        etag: '"end-action-test"',
        'content-length': String(body.length)
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, headers).end()
        return
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      if (!range) {
        response.writeHead(400).end()
        return
      }
      const start = Number(range[1])
      const end = Math.min(Number(range[2]), body.length - 1)
      const payload = body.subarray(start, end + 1)
      response.writeHead(206, {
        ...headers,
        'content-length': String(payload.length),
        'content-range': `bytes ${start}-${end}/${body.length}`
      }).end(payload)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    harness = await createHarness({ autoStartDownloads: false, maxConcurrentDownloads: 1 })
    const currentEngine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    engines.push(currentEngine)
    const download = await currentEngine.add({ url: `http://127.0.0.1:${port}/end-action.bin` })
    harness.repos.queuePlans.insert({
      id: `expired-${endAction}`,
      name: 'Expired plan',
      downloadIds: [download.id],
      startsAt: Date.now() - 60_000,
      durationMinutes: 1,
      strategy: 'queue-order',
      endAction,
      status: 'running',
      createdAt: Date.now() - 60_000,
      endedAt: null
    })

    await currentEngine.start()
    await waitFor(
      () => harness?.repos.downloads.get(download.id)?.status === expectedStatus,
      { timeoutMs: 8000, message: `the plan did not apply its ${endAction} end action` }
    )
    expect(harness.repos.queuePlans.get(`expired-${endAction}`)?.status).toBe('completed')
  })
})
