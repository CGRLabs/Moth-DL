import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'

const TOKEN = 'a'.repeat(64)
let server: Server | null = null
let child: ChildProcessWithoutNullStreams | null = null

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise<void>((resolvePromise) => child?.once('exit', () => resolvePromise()))
  }
  child = null
  if (server) {
    await new Promise<void>((resolvePromise, reject) => {
      server?.close((error) => error ? reject(error) : resolvePromise())
    })
  }
  server = null
})

interface RpcMessage {
  jsonrpc: string
  id: number | null
  result?: {
    protocolVersion?: string
    tools?: Array<{ name: string }>
    content?: Array<{ type: string; text: string }>
    isError?: boolean
  }
  error?: { code: number; message: string }
}

function startMcp(port: number): {
  request: (message: Record<string, unknown>, id: number) => Promise<RpcMessage>
} {
  child = spawn(process.execPath, [resolve('scripts/moth-mcp.mjs')], {
    env: {
      ...process.env,
      MOTH_API_TOKEN: TOKEN,
      MOTH_API_URL: `http://127.0.0.1:${port}`
    },
    stdio: 'pipe'
  })

  let buffer = ''
  const waiting = new Map<number, (message: RpcMessage) => void>()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const message = JSON.parse(line) as RpcMessage
      if (message.id !== null) waiting.get(message.id)?.(message)
    }
  })

  return {
    request: (message, id) => new Promise<RpcMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`Timed out waiting for MCP response ${id}`))
      }, 5000)
      waiting.set(id, (response) => {
        clearTimeout(timer)
        waiting.delete(id)
        resolvePromise(response)
      })
      child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...message })}\n`)
    })
  }
}

describe('Moth MCP server', () => {
  it('negotiates MCP, lists tools, and sends validated actions to Moth’s local API', async () => {
    const requests: Array<{ method: string; path: string; body: string; token?: string }> = []
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const tokenHeader = request.headers['x-moth-token']
        requests.push({
          method: request.method ?? '',
          path: request.url ?? '',
          body,
          token: Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        if (request.url === '/api/v1/downloads' && request.method === 'POST') {
          response.end(JSON.stringify({ ok: true, data: { id: 'test-download', filename: 'test.iso' } }))
        } else if (request.url?.endsWith('/pause')) {
          response.end(JSON.stringify({ ok: true, data: { id: 'test-download', status: 'paused' } }))
        } else {
          response.end(JSON.stringify({
            ok: true,
            data: { app: 'moth-dlm', stats: { activeDownloads: 1 } }
          }))
        }
      })
    })
    await new Promise<void>((resolvePromise, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Moth API fixture has no TCP address')
    const mcp = startMcp(address.port)

    const initialized = await mcp.request({
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    }, 1)
    expect(initialized.result?.protocolVersion).toBe('2025-11-25')

    const listed = await mcp.request({ method: 'tools/list', params: {} }, 2)
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain('moth_add_download')
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain('moth_wait_for_download')

    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'
    const added = await mcp.request({
      method: 'tools/call',
      params: { name: 'moth_add_download', arguments: { url: magnet, filename: 'test.iso' } }
    }, 3)
    expect(added.result?.content?.[0]?.text).toContain('test-download')
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/v1/downloads',
      token: TOKEN,
      body: JSON.stringify({ url: magnet, filename: 'test.iso' })
    })

    const paused = await mcp.request({
      method: 'tools/call',
      params: { name: 'moth_pause_download', arguments: { id: 'test-download' } }
    }, 4)
    expect(paused.result?.content?.[0]?.text).toContain('paused')
    expect(requests.at(-1)?.path).toBe('/api/v1/downloads/test-download/pause')

    const rejected = await mcp.request({
      method: 'tools/call',
      params: { name: 'moth_add_download', arguments: { url: 'file:///private.txt' } }
    }, 5)
    expect(rejected.result?.isError).toBe(true)
    expect(rejected.result?.content?.[0]?.text).toContain('only accepts HTTP(S)')
    expect(requests).toHaveLength(2)
  })
})
