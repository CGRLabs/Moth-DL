import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { DownloadEngine } from '../../src/main/core/engine.js'
import { closeAgents } from '../../src/main/net/httpClient.js'
import { createHarness, waitFor, waitForStatus, type TestHarness } from '../helpers/harness.js'
import { makeBody, startTestServer, type TestServer } from '../helpers/testServer.js'

let harness: TestHarness | null = null
let server: TestServer | null = null
let engine: DownloadEngine | null = null

afterEach(async () => {
  await engine?.shutdown()
  engine = null
  await harness?.cleanup()
  harness = null
  await server?.close()
  server = null
  closeAgents()
})

describe('per-download quota', () => {
  it('pauses at the exact saved-byte quota and resumes when it is raised', async () => {
    const body = makeBody(256 * 1024, 1)
    server = await startTestServer({ body })
    harness = await createHarness({
      autoStartDownloads: false,
      chunkSize: 64 * 1024,
      defaultConnections: 4
    })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

    const result = await engine.add({ url: server.url })
    const quotaBytes = 100 * 1024 + 37
    await engine.setDownloadQuota(result.id, quotaBytes)
    await engine.resume(result.id)

    await waitForStatus(harness.repos, result.id, ['paused', 'completed', 'failed'])
    await waitFor(() => engine?.getStats().activeDownloads === 0)

    const paused = harness.repos.downloads.get(result.id)
    expect(paused?.status).toBe('paused')
    expect(paused?.downloadedBytes).toBe(quotaBytes)
    expect(paused?.quotaBytes).toBe(quotaBytes)
    expect(paused?.errorMessage).toContain('quota')
    expect(paused?.finalPath).not.toBeNull()
    if (!paused?.finalPath) throw new Error('Paused download has no destination path')
    await expect(readFile(paused.finalPath)).rejects.toThrow()

    await engine.setDownloadQuota(result.id, 64 * 1024)
    const stillPaused = harness.repos.downloads.get(result.id)
    expect(stillPaused?.status).toBe('paused')
    expect(stillPaused?.downloadedBytes).toBe(quotaBytes)

    await engine.setDownloadQuota(result.id, body.length + 1)
    await engine.resume(result.id)
    await waitForStatus(harness.repos, result.id, ['completed', 'failed'])

    const completed = harness.repos.downloads.get(result.id)
    expect(completed?.status).toBe('completed')
    expect(completed?.quotaBytes).toBe(body.length + 1)
    if (!completed?.finalPath) throw new Error('Completed download has no destination path')
    expect(await readFile(completed.finalPath)).toEqual(body)
  })
})
