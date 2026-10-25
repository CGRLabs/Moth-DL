import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startIngestServer, type IngestServer } from '../../src/main/ingest/server.js'
import type { AgentApi } from '../../src/main/ingest/server.js'
import type { AddDownloadRequest, DownloadSnapshot } from '../../src/shared/types.js'

let server: IngestServer | null = null
let lastAddedRequest: AddDownloadRequest | null = null
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await server?.close()
  server = null
  lastAddedRequest = null
})

function snapshot(): DownloadSnapshot {
  const now = Date.now()
  return {
    id: 'agent-api-download-1',
    url: 'https://example.com/file.zip?token=private&version=3',
    finalUrl: null,
    filename: 'file.zip',
    tempPath: 'C:\\Downloads\\file.zip.mothpart',
    finalPath: 'C:\\Downloads\\file.zip',
    fileSize: 100,
    acceptRanges: true,
    etag: '"tag"',
    lastModified: null,
    contentType: 'application/zip',
    category: 'archive',
    status: 'downloading',
    downloadedBytes: 25,
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
    connections: 4,
    headers: { cookie: 'private-cookie' },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    speed: 10,
    eta: 8,
    chunksComplete: 1,
    chunksTotal: 4,
    chunkBitmap: [1, 0, 0, 0]
  }
}

async function startApi(): Promise<{ port: number; api: AgentApi }> {
  const item = snapshot()
  const api: AgentApi = {
    stats: () => ({
      activeDownloads: 1,
      queuedDownloads: 0,
      completedDownloads: 0,
      failedDownloads: 0,
      totalSpeed: 10,
      sessionBytes: 25,
      globalSpeedLimit: null,
      uptimeMs: 1000
    }),
    list: () => [item],
    get: (id) => (id === item.id ? item : null),
    add: async (request) => {
      lastAddedRequest = request
      return {
        id: item.id,
        filename: request.filename ?? 'file.zip',
        fileSize: item.fileSize,
        acceptRanges: true
      }
    },
    pause: async () => ({ ...item, status: 'paused' }),
    resume: async () => item,
    retry: () => item,
    cancel: async () => ({ ...item, status: 'canceled' }),
    logs: async (lines) => [`requested ${lines} lines`],
    rescan: async (id) => ({
      repaired: id ? [id] : [],
      invalidated: [],
      failed: [],
      details: id
        ? [{
            id,
            action: 'repaired' as const,
            bytesKept: 1024,
            chunksKept: 1,
            chunksReset: 1,
            note: 'One damaged range was re-planned'
          }]
        : [],
      durationMs: 12
    })
  }
  server = await startIngestServer({
    port: 0,
    token: 'a'.repeat(64),
    onDownload: async () => ({ id: item.id }),
    agent: api,
    onPort: () => {}
  })
  return { port: server.port, api }
}

describe('agent control API', () => {
  it('requires the pairing token and returns redacted download state', async () => {
    const { port } = await startApi()
    const denied = await fetch(`http://127.0.0.1:${port}/api/v1/downloads`)
    expect(denied.status).toBe(401)

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/downloads`, {
      headers: { 'x-moth-token': 'a'.repeat(64) }
    })
    const body = await response.json() as { ok: boolean; data: Array<Record<string, unknown>> }
    expect(body.ok).toBe(true)
    expect(body.data[0]?.headers).toBeUndefined()
    expect(body.data[0]?.url).toBe('https://example.com/file.zip?token=REDACTED&version=3')
  })

  it('exposes status, validates and accepts add requests, and tails bounded logs', async () => {
    const { port } = await startApi()
    const headers = { 'x-moth-token': 'a'.repeat(64), 'content-type': 'application/json' }

    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { headers })
    expect(statusResponse.status).toBe(200)

    const invalid = await fetch(`http://127.0.0.1:${port}/api/v1/downloads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'file:///private.txt' })
    })
    expect(invalid.status).toBe(400)

    const added = await fetch(`http://127.0.0.1:${port}/api/v1/downloads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/file.zip' })
    })
    expect(added.status).toBe(201)

    const logs = await fetch(`http://127.0.0.1:${port}/api/v1/logs?lines=12`, { headers })
    expect(await logs.json()).toMatchObject({ ok: true, data: ['requested 12 lines'] })
    const badLimit = await fetch(`http://127.0.0.1:${port}/api/v1/logs?lines=501`, { headers })
    expect(badLimit.status).toBe(400)

    const rescan = await fetch(`http://127.0.0.1:${port}/api/v1/maintenance/rescan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'agent-api-download-1' })
    })
    expect(await rescan.json()).toMatchObject({
      ok: true,
      data: {
        repaired: ['agent-api-download-1'],
        invalidated: [],
        failed: [],
        details: [{
          id: 'agent-api-download-1',
          action: 'repaired',
          bytesKept: 1024,
          chunksKept: 1,
          chunksReset: 1,
          note: 'One damaged range was re-planned'
        }]
      }
    })

    const invalidRescan = await fetch(`http://127.0.0.1:${port}/api/v1/maintenance/rescan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: '../not-an-id' })
    })
    expect(invalidRescan.status).toBe(400)
  })

  it('lets the terminal CLI query the running API and emits machine-readable JSON', async () => {
    const { port } = await startApi()
    const { stdout } = await execFileAsync(process.execPath, ['scripts/moth.mjs', 'status'], {
      env: {
        ...process.env,
        MOTH_API_TOKEN: 'a'.repeat(64),
        MOTH_API_URL: `http://127.0.0.1:${port}`
      }
    })

    const output = JSON.parse(stdout) as {
      ok: boolean
      data: { app: string; stats: { activeDownloads: number } }
    }
    expect(output).toMatchObject({
      ok: true,
      data: { app: 'moth-dlm', stats: { activeDownloads: 1 } }
    })
  })

  it('lets the agent CLI add torrent magnets through the authenticated app API', async () => {
    const { port } = await startApi()
    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test'
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/moth.mjs',
      'add',
      magnet,
      '--filename',
      'test-torrent'
    ], {
      env: {
        ...process.env,
        MOTH_API_TOKEN: 'a'.repeat(64),
        MOTH_API_URL: `http://127.0.0.1:${port}`
      }
    })

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      data: { id: 'agent-api-download-1', filename: 'test-torrent' }
    })
    expect(lastAddedRequest).toMatchObject({
      url: magnet,
      filename: 'test-torrent'
    })
  })

  it('routes remote .torrent URLs through the authenticated app API', async () => {
    const { port } = await startApi()
    const torrentUrl = 'https://tracker.example/downloads/example.torrent'
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/moth.mjs',
      'add',
      torrentUrl
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MOTH_API_TOKEN: 'a'.repeat(64),
        MOTH_API_URL: `http://127.0.0.1:${port}`
      }
    })
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      data: { id: 'agent-api-download-1' }
    })
    expect(lastAddedRequest).toMatchObject({ url: torrentUrl })
  })

  it('explains that torrent sources do not accept media-format CLI options', async () => {
    const { port } = await startApi()
    await expect(execFileAsync(process.execPath, [
      'scripts/moth.mjs',
      'add',
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
      '--format',
      'audio'
    ], {
      env: {
        ...process.env,
        MOTH_API_TOKEN: 'a'.repeat(64),
        MOTH_API_URL: `http://127.0.0.1:${port}`
      }
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('torrent downloads do not support')
    })
  })

  it('runs machine-readable health checks and a scoped recovery through the CLI', async () => {
    const { port } = await startApi()
    const env = {
      ...process.env,
      MOTH_API_TOKEN: 'a'.repeat(64),
      MOTH_API_URL: `http://127.0.0.1:${port}`
    }
    const doctor = await execFileAsync(process.execPath, ['scripts/moth.mjs', 'doctor'], { env })
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      ok: true,
      data: {
        healthy: true,
        checks: [
          { name: 'Moth API', ok: true },
          { name: 'Download records', ok: true, active: 1 }
        ]
      }
    })

    const repair = await execFileAsync(
      process.execPath,
      ['scripts/moth.mjs', 'repair', '--id', 'agent-api-download-1'],
      { env }
    )
    expect(JSON.parse(repair.stdout)).toMatchObject({
      ok: true,
      data: { repaired: ['agent-api-download-1'], failed: [] }
    })
  })

  it('rejects a non-loopback API URL from the environment', async () => {
    await expect(
      execFileAsync(process.execPath, ['scripts/moth.mjs', 'status'], {
        env: {
          ...process.env,
          MOTH_API_TOKEN: 'a'.repeat(64),
          MOTH_API_URL: 'http://example.com:24678'
        }
      })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('MOTH_API_URL must be http://127.0.0.1:<port>')
    })
  })
})
