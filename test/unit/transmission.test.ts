import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getBundledTransmissionExecutable,
  parseTransmissionAddedTorrent,
  parseTransmissionFiles,
  parseTransmissionTorrents,
  TransmissionManager,
  TransmissionRpcClient
} from '../../src/main/torrent/transmission.js'

const validTorrent = {
  id: 1,
  hashString: '0123456789abcdef0123456789abcdef01234567',
  name: 'example',
  status: 4,
  percentDone: 0.5,
  totalSize: 100,
  sizeWhenDone: 100,
  haveValid: 50,
  rateDownload: 12,
  leftUntilDone: 50,
  downloadDir: 'C:\\downloads\\example',
  peersConnected: 3,
  isFinished: false
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

describe('Transmission RPC and response validation', () => {
  it('completes the 409 session handshake while retaining local authentication', async () => {
    const requests: Array<{ auth?: string; sessionId?: string; body: string }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        requests.push({
          auth: request.headers.authorization,
          sessionId: Array.isArray(request.headers['x-transmission-session-id'])
            ? request.headers['x-transmission-session-id'][0]
            : request.headers['x-transmission-session-id'],
          body: Buffer.concat(chunks).toString('utf8')
        })
        if (!request.headers['x-transmission-session-id']) {
          response.writeHead(409, { 'x-transmission-session-id': 'test-session' }).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ arguments: { version: 'test' }, result: 'success' }))
      })
    })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })

    try {
      const { port } = server.address() as AddressInfo
      const username = 'moth'
      const password = 'a'.repeat(64)
      const client = new TransmissionRpcClient({ port, username, password })
      await expect(client.call('session-get')).resolves.toEqual({ version: 'test' })

      expect(requests).toHaveLength(2)
      expect(requests[0]?.sessionId).toBeUndefined()
      expect(requests[1]?.sessionId).toBe('test-session')
      expect(requests.every((request) => request.auth === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`)).toBe(true)
      expect(JSON.parse(requests[1]!.body)).toMatchObject({ method: 'session-get' })
    } finally {
      await closeServer(server)
    }
  })

  it('rejects malformed torrent snapshots rather than trusting daemon JSON', () => {
    expect(parseTransmissionTorrents({ torrents: [validTorrent] })).toEqual([validTorrent])
    expect(() => parseTransmissionTorrents({
      torrents: [{ ...validTorrent, haveValid: -1 }]
    })).toThrow('Transmission returned malformed torrent status data')
  })

  it('validates returned identifiers for added and duplicate torrents', () => {
    expect(parseTransmissionAddedTorrent({
      'torrent-duplicate': { id: 2, hashString: validTorrent.hashString }
    })).toEqual({ id: 2, hashString: validTorrent.hashString })
    expect(() => parseTransmissionAddedTorrent({ 'torrent-added': { id: -1 } })).toThrow(
      'Transmission did not return a valid torrent identifier'
    )
  })

  it('parses untrusted file lists and rejects misaligned file statistics', () => {
    expect(parseTransmissionFiles({
      torrents: [{
        files: [
          { name: 'folder/one.bin', length: 12, bytesCompleted: 4 },
          { name: 'two.bin', length: 8, bytesCompleted: 0 }
        ],
        fileStats: [
          { bytesCompleted: 4, wanted: true, priority: 0 },
          { bytesCompleted: 0, wanted: false, priority: 0 }
        ]
      }]
    })).toEqual([
      { index: 0, name: 'folder/one.bin', size: 12, downloaded: 4, wanted: true, priority: 0 },
      { index: 1, name: 'two.bin', size: 8, downloaded: 0, wanted: false, priority: 0 }
    ])
    expect(() => parseTransmissionFiles({
      torrents: [{
        files: [{ name: 'one.bin', length: 12, bytesCompleted: 4 }],
        fileStats: []
      }]
    })).toThrow('Transmission returned malformed torrent file data')
  })

  it('requires an executable path before starting the managed daemon', async () => {
    const manager = new TransmissionManager({
      executablePath: '',
      configDirectory: 'unused',
      downloadDirectory: 'unused'
    })
    await expect(manager.start()).rejects.toThrow(
      'The bundled Transmission engine is not available for this platform'
    )
  })

  it('resolves a bundled executable only for supported Windows x64 builds', () => {
    expect(getBundledTransmissionExecutable('C:\\Moth\\assets', 'win32', 'x64')).toBe(
      resolve('C:\\Moth\\assets', 'transmission', 'win-x64', 'transmission-daemon.exe')
    )
    expect(getBundledTransmissionExecutable('C:\\Moth\\assets', 'win32', 'arm64')).toBeNull()
    expect(getBundledTransmissionExecutable('C:\\Moth\\assets', 'linux', 'x64')).toBeNull()
  })
})
