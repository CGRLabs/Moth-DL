import { describe, it, expect, afterEach } from 'vitest'
import { startIngestServer, type IngestServer } from '../../src/main/ingest/server.js'

const TOKEN = 't'.repeat(64)
let servers: IngestServer[] = []

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
})

async function listen(options?: {
  onDownload?: Parameters<typeof startIngestServer>[0]['onDownload']
  onList?: () => Promise<unknown>
  onGet?: (id: string) => Promise<unknown>
}): Promise<{ port: number }> {
  const server = await startIngestServer({
    port: 0,
    token: TOKEN,
    onDownload: async () => ({ id: 'new-id' }),
    onPort: () => {},
    ...options
  })
  servers.push(server)
  expect(server.port).toBeGreaterThan(0)
  return { port: server.port }
}

async function get(port: number, path: string, token = TOKEN): Promise<{ status: number; body: never }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'x-moth-token': token }
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as never }
}

describe('ingest read routes', () => {
  it('pairs only the shipped extension origin and returns the live loopback port', async () => {
    const extensionId = 'legoanmlgfmocgoghjnacbgejbnifjmk'
    const server = await startIngestServer({
      port: 0,
      token: TOKEN,
      extensionId,
      onDownload: async () => ({ id: 'new-id' }),
      onPort: () => {}
    })
    servers.push(server)

    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/pair`, {
      headers: { Origin: `chrome-extension://${extensionId}` }
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(`chrome-extension://${extensionId}`)
    expect(await response.json()).toEqual({
      ok: true,
      data: { port: server.port, token: TOKEN }
    })
  })

  it('does not disclose the pairing token to a web-page origin', async () => {
    const extensionId = 'legoanmlgfmocgoghjnacbgejbnifjmk'
    const server = await startIngestServer({
      port: 0,
      token: TOKEN,
      extensionId,
      onDownload: async () => ({ id: 'new-id' }),
      onPort: () => {}
    })
    servers.push(server)

    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/pair`, {
      headers: { Origin: 'https://example.com' }
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Pairing is only available to the signed browser extension'
    })
  })

  it('rejects /downloads without a token', async () => {
    const { port } = await listen({ onList: async () => [] })
    const response = await fetch(`http://127.0.0.1:${port}/downloads`)
    expect(response.status).toBe(401)
  })

  it('lists downloads through onList', async () => {
    const rows = [{ id: 'a', status: 'downloading' }]
    const { port } = await listen({ onList: async () => rows })
    const { status, body } = await get(port, '/downloads')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, downloads: rows })
  })

  it('answers 404 when no query callbacks are wired', async () => {
    const { port } = await listen()
    const { status } = await get(port, '/downloads')
    expect(status).toBe(404)
    const one = await get(port, '/downloads/abc-123')
    expect(one.status).toBe(404)
  })

  it('returns one download and 404s unknown ids', async () => {
    const { port } = await listen({
      onGet: async (id: string) => (id === 'known-id' ? { id, status: 'completed' } : null)
    })
    const hit = await get(port, '/downloads/known-id')
    expect(hit.status).toBe(200)
    expect(hit.body).toEqual({ ok: true, download: { id: 'known-id', status: 'completed' } })
    const miss = await get(port, '/downloads/no-such-id')
    expect(miss.status).toBe(404)
  })

  it('refuses malformed ids without reaching onGet', async () => {
    let called = 0
    const { port } = await listen({
      onGet: async () => {
        called += 1
        return null
      }
    })
    const { status } = await get(port, '/downloads/../../moth.db')
    expect(status).toBe(404)
    expect(called).toBe(0)
  })

  it('accepts the highest supported video quality through ingest', async () => {
    let receivedQuality: number | undefined
    const { port } = await listen({
      onDownload: async (request) => {
        receivedQuality = request.videoQuality
        return { id: 'new-id' }
      }
    })
    const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-moth-token': TOKEN },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=test', videoQuality: 2160 })
    })

    expect(response.status).toBe(200)
    expect(receivedQuality).toBe(2160)
  })
})
