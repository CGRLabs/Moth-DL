import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { DownloadEngine } from '../../src/main/core/engine.js'
import { TorrentDownloadTask } from '../../src/main/torrent/task.js'
import {
  getTorrentMetainfoPath,
  type TransmissionClientProvider,
  type TransmissionRpc
} from '../../src/main/torrent/transmission.js'
import type { Download } from '../../src/shared/types.js'
import { createHarness, type TestHarness } from '../helpers/harness.js'

const infoHash = '0123456789abcdef0123456789abcdef01234567'
const magnetUri = `magnet:?xt=urn:btih:${infoHash}`

let harness: TestHarness | null = null
let engine: DownloadEngine | null = null
let sourceServer: Server | null = null

afterEach(async () => {
  await engine?.shutdown()
  engine = null
  if (sourceServer) {
    await new Promise<void>((resolvePromise, reject) => {
      sourceServer?.close((error) => error ? reject(error) : resolvePromise())
    })
    sourceServer = null
  }
  await harness?.cleanup()
  harness = null
})

function makeDownload(directory: string, id: string): Download {
  const now = Date.now()
  const tempPath = join(directory, '.moth-torrents', id)
  return {
    id,
    url: magnetUri,
    finalUrl: null,
    filename: 'Torrent 01234567',
    tempPath,
    finalPath: null,
    fileSize: 0,
    acceptRanges: false,
    etag: null,
    lastModified: null,
    contentType: 'application/x-bittorrent',
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
    connections: null,
    headers: {},
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null
  }
}

function clientFor(
  call: (method: string, args: Record<string, unknown>) => unknown | Promise<unknown>
): TransmissionClientProvider {
  const client: TransmissionRpc = {
    call: async (method, args = {}) => call(method, args)
  }
  return { start: async () => client }
}

describe('Transmission torrent task', () => {
  it('starts a magnet, reports peers, and completes only after piece verification', async () => {
    harness = await createHarness()
    const download = makeDownload(harness.downloadDir, 'torrent-complete')
    harness.repos.downloads.insert(download)
    const calls: string[] = []
    let initialLookup = true
    const task = new TorrentDownloadTask({
      id: download.id,
      download,
      manager: clientFor((method) => {
        calls.push(method)
        if (method === 'torrent-get' && initialLookup) {
          initialLookup = false
          return { torrents: [] }
        }
        if (method === 'torrent-add') {
          return { 'torrent-added': { id: 7, hashString: infoHash } }
        }
        if (method === 'torrent-get') {
          return {
            torrents: [{
              id: 7,
              hashString: infoHash,
              name: 'Example torrent',
              status: 4,
              percentDone: 1,
              totalSize: 100,
              sizeWhenDone: 100,
              haveValid: 100,
              rateDownload: 0,
              leftUntilDone: 0,
              downloadDir: download.tempPath,
              peersConnected: 2,
              isFinished: true
            }]
          }
        }
        return {}
      }),
      repos: harness.repos,
      emit: (event) => {
        if (event.type === 'status') expect(event.status).toBeTruthy()
      }
    })

    await task.run()

    expect(calls).toContain('torrent-start')
    expect(calls).toContain('torrent-stop')
    expect(harness.repos.downloads.get(download.id)).toMatchObject({
      status: 'completed',
      downloadedBytes: 100,
      fileSize: 100,
      finalPath: download.tempPath
    })
  })

  it('completes a selected subset using Transmission’s wanted-size accounting', async () => {
    harness = await createHarness()
    const download = makeDownload(harness.downloadDir, 'torrent-selected-complete')
    download.torrentFiles = [0]
    harness.repos.downloads.insert(download)
    let initialLookup = true
    const task = new TorrentDownloadTask({
      id: download.id,
      download,
      manager: clientFor((method, args) => {
        if (method === 'torrent-get' && initialLookup) {
          initialLookup = false
          return { torrents: [] }
        }
        if (method === 'torrent-add') {
          return { 'torrent-added': { id: 18, hashString: infoHash } }
        }
        if (method === 'torrent-get' && args['fields'] instanceof Array &&
          args['fields'].includes('fileStats')) {
          return {
            torrents: [{
              files: [
                { name: 'fixture/selected.bin', length: 4, bytesCompleted: 4 },
                { name: 'fixture/unselected.bin', length: 96, bytesCompleted: 0 }
              ],
              fileStats: [
                { bytesCompleted: 4, wanted: true, priority: 0 },
                { bytesCompleted: 0, wanted: false, priority: 0 }
              ]
            }]
          }
        }
        if (method === 'torrent-get') {
          return {
            torrents: [{
              id: 18,
              hashString: infoHash,
              name: 'Example torrent',
              status: 4,
              percentDone: 1,
              totalSize: 100,
              sizeWhenDone: 4,
              haveValid: 4,
              rateDownload: 0,
              leftUntilDone: 0,
              downloadDir: download.tempPath,
              peersConnected: 0,
              isFinished: false
            }]
          }
        }
        return {}
      }),
      repos: harness.repos,
      emit: () => {}
    })

    await task.run()

    expect(harness.repos.downloads.get(download.id)).toMatchObject({
      status: 'completed',
      downloadedBytes: 4,
      fileSize: 4,
      finalPath: download.tempPath
    })
  })

  it('stops an incomplete torrent when its task fails', async () => {
    harness = await createHarness()
    const download = makeDownload(harness.downloadDir, 'torrent-error-cleanup')
    harness.repos.downloads.insert(download)
    const calls: string[] = []
    let initialLookup = true
    const task = new TorrentDownloadTask({
      id: download.id,
      download,
      manager: clientFor((method) => {
        calls.push(method)
        if (method === 'torrent-get' && initialLookup) {
          initialLookup = false
          return { torrents: [] }
        }
        if (method === 'torrent-add') {
          return { 'torrent-added': { id: 19, hashString: infoHash } }
        }
        if (method === 'torrent-get') throw new Error('simulated Transmission status failure')
        return {}
      }),
      repos: harness.repos,
      emit: () => {}
    })

    await expect(task.run()).rejects.toThrow('simulated Transmission status failure')
    expect(calls).toContain('torrent-start')
    expect(calls).toContain('torrent-stop')
  })

  it('does not mark a magnet complete before metadata reveals any payload size', async () => {
    harness = await createHarness()
    const download = makeDownload(harness.downloadDir, 'torrent-metadata-pending')
    harness.repos.downloads.insert(download)
    let initialLookup = true
    let task!: TorrentDownloadTask
    task = new TorrentDownloadTask({
      id: download.id,
      download,
      manager: clientFor((method) => {
        if (method === 'torrent-get' && initialLookup) {
          initialLookup = false
          return { torrents: [] }
        }
        if (method === 'torrent-add') {
          return { 'torrent-added': { id: 17, hashString: infoHash } }
        }
        if (method === 'torrent-get') {
          return {
            torrents: [{
              id: 17,
              hashString: infoHash,
              name: infoHash,
              status: 4,
              percentDone: 0,
              totalSize: 0,
              sizeWhenDone: 0,
              haveValid: 0,
              rateDownload: 0,
              leftUntilDone: 0,
              downloadDir: download.tempPath,
              peersConnected: 0,
              isFinished: false
            }]
          }
        }
        return {}
      }),
      repos: harness.repos,
      emit: (event) => {
        if (event.type === 'progress') task.pause()
      }
    })

    await task.run()

    expect(harness.repos.downloads.get(download.id)).toMatchObject({
      status: 'paused',
      downloadedBytes: 0,
      fileSize: 0,
      finalPath: null
    })
  })

  it('stops and persists paused state when the user pauses an active torrent', async () => {
    harness = await createHarness()
    const download = makeDownload(harness.downloadDir, 'torrent-pause')
    harness.repos.downloads.insert(download)
    const calls: string[] = []
    let initialLookup = true
    let task!: TorrentDownloadTask
    let reportedPeerCount = false
    task = new TorrentDownloadTask({
      id: download.id,
      download,
      manager: clientFor((method) => {
        calls.push(method)
        if (method === 'torrent-get' && initialLookup) {
          initialLookup = false
          return { torrents: [] }
        }
        if (method === 'torrent-add') {
          return { 'torrent-added': { id: 8, hashString: infoHash } }
        }
        if (method === 'torrent-get') {
          return {
            torrents: [{
              id: 8,
              hashString: infoHash,
              name: 'Example torrent',
              status: 4,
              percentDone: 0.5,
              totalSize: 100,
              sizeWhenDone: 100,
              haveValid: 50,
              rateDownload: 20,
              leftUntilDone: 50,
              downloadDir: download.tempPath,
              peersConnected: 1,
              isFinished: false
            }]
          }
        }
        return {}
      }),
      repos: harness.repos,
      emit: (event) => {
        if (event.type === 'progress') {
          reportedPeerCount = event.progress.activeConnections === 1
          task.pause()
        }
      }
    })

    await task.run()

    expect(calls).toContain('torrent-stop')
    expect(reportedPeerCount).toBe(true)
    expect(harness.repos.downloads.get(download.id)?.status).toBe('paused')
  })

  it('reattaches to the matching paused Transmission torrent on resume', async () => {
    harness = await createHarness()
    const download = makeDownload(harness.downloadDir, 'torrent-resume')
    harness.repos.downloads.insert(download)
    const calls: string[] = []
    let lookupCount = 0
    let task!: TorrentDownloadTask
    task = new TorrentDownloadTask({
      id: download.id,
      download,
      manager: clientFor((method) => {
        calls.push(method)
        if (method === 'torrent-get') {
          lookupCount += 1
          return {
            torrents: [{
              id: 9,
              hashString: infoHash,
              name: 'Example torrent',
              status: lookupCount === 1 ? 0 : 4,
              percentDone: 0.25,
              totalSize: 100,
              sizeWhenDone: 100,
              haveValid: 25,
              rateDownload: 8,
              leftUntilDone: 75,
              downloadDir: download.tempPath,
              peersConnected: 1,
              isFinished: false
            }]
          }
        }
        if (method === 'torrent-start') return {}
        if (method === 'torrent-stop') return {}
        return {}
      }),
      repos: harness.repos,
      emit: (event) => {
        if (event.type === 'progress') task.pause()
      }
    })

    await task.run()

    expect(calls).toContain('torrent-start')
    expect(calls).not.toContain('torrent-add')
    expect(harness.repos.downloads.get(download.id)).toMatchObject({
      status: 'paused',
      downloadedBytes: 25,
      fileSize: 100
    })
  })

  it('queues local metainfo without starting Transmission and reuses it when the task starts', async () => {
    harness = await createHarness({ autoStartDownloads: false })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    const metainfo = Buffer.from('dGVzdA==', 'base64')
    const digest = createHash('sha256').update(metainfo).digest('hex')
    await expect(engine.add({
      url: `moth-torrent-file:${'0'.repeat(64)}`,
      torrentMetainfo: metainfo.toString('base64')
    })).rejects.toThrow('failed its integrity check')

    const { id } = await engine.add({
      url: `moth-torrent-file:${digest}`,
      torrentMetainfo: metainfo.toString('base64')
    })
    const download = harness.repos.downloads.get(id)
    if (!download) throw new Error('Torrent row was not stored')
    const metainfoPath = getTorrentMetainfoPath(id, download.tempPath)
    expect(await readFile(metainfoPath)).toEqual(metainfo)

    let initialLookup = true
    let submittedMetainfo: unknown
    const task = new TorrentDownloadTask({
      id,
      download,
      manager: clientFor((method, args) => {
        if (method === 'torrent-get' && initialLookup) {
          initialLookup = false
          return { torrents: [] }
        }
        if (method === 'torrent-add') {
          submittedMetainfo = args.metainfo
          return { 'torrent-added': { id: 10, hashString: infoHash } }
        }
        if (method === 'torrent-get') {
          return {
            torrents: [{
              id: 10,
              hashString: infoHash,
              name: 'Local torrent',
              status: 4,
              percentDone: 1,
              totalSize: 100,
              sizeWhenDone: 100,
              haveValid: 100,
              rateDownload: 0,
              leftUntilDone: 0,
              downloadDir: download.tempPath,
              peersConnected: 0,
              isFinished: true
            }]
          }
        }
        return {}
      }),
      repos: harness.repos,
      emit: () => {}
    })

    await task.run()

    expect(submittedMetainfo).toBe(metainfo.toString('base64'))
    expect(harness.repos.downloads.get(id)?.status).toBe('completed')
    await writeFile(join(download.tempPath, 'payload.bin'), 'verified payload')
    await engine.remove(id, false)
    expect(await readFile(join(download.tempPath, 'payload.bin'), 'utf8')).toBe('verified payload')
    await expect(stat(metainfoPath)).rejects.toThrow()
  })

  it('fetches a remote .torrent through Moth and stages it before starting Transmission', async () => {
    harness = await createHarness()
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    const metainfo = Buffer.from('remote torrent metainfo')
    let requestsReceived = 0
    sourceServer = createServer((_request, response) => {
      requestsReceived += 1
      response.writeHead(200, { 'content-type': 'application/x-bittorrent' })
      response.end(metainfo)
    })
    await new Promise<void>((resolvePromise, reject) => {
      sourceServer?.once('error', reject)
      sourceServer?.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = sourceServer.address()
    if (!address || typeof address === 'string') throw new Error('Torrent fixture server has no TCP address')

    const download = makeDownload(harness.downloadDir, 'torrent-remote')
    download.url = `http://127.0.0.1:${address.port}/fixture.torrent`
    harness.repos.downloads.insert(download)
    const calls: string[] = []
    let initialLookup = true
    let submittedMetainfo: unknown
    const rpc = clientFor((method, args) => {
      calls.push(method)
      if (method === 'torrent-get' && initialLookup) {
        initialLookup = false
        return { torrents: [] }
      }
      if (method === 'torrent-add') {
        submittedMetainfo = args.metainfo
        return { 'torrent-added': { id: 12, hashString: infoHash } }
      }
      if (method === 'torrent-get') {
        return {
          torrents: [{
            id: 12,
            hashString: infoHash,
            name: 'Remote torrent',
            status: 4,
            percentDone: 1,
            totalSize: 100,
            sizeWhenDone: 100,
            haveValid: 100,
            rateDownload: 0,
            leftUntilDone: 0,
            downloadDir: download.tempPath,
            peersConnected: 0,
            isFinished: true
          }]
        }
      }
      return {}
    })
    const task = new TorrentDownloadTask({
      id: download.id,
      download,
      manager: {
        start: async () => {
          expect(requestsReceived).toBe(1)
          return rpc.start()
        }
      },
      repos: harness.repos,
      emit: () => {}
    })

    await task.run()

    expect(calls).toContain('torrent-add')
    expect(submittedMetainfo).toBe(metainfo.toString('base64'))
    expect(await readFile(getTorrentMetainfoPath(download.id, download.tempPath))).toEqual(metainfo)
    await engine.remove(download.id, false)
    await expect(stat(getTorrentMetainfoPath(download.id, download.tempPath))).rejects.toThrow()
  })

  it('keeps or recursively deletes completed torrent folders according to the removal choice', async () => {
    harness = await createHarness({ autoStartDownloads: false })
    engine = new DownloadEngine(harness.repos, harness.settings, harness.db)
    await expect(engine.add({
      url: magnetUri,
      destination: join(harness.downloadDir, 'custom')
    })).rejects.toThrow('Destinations, media options')

    for (const deleteFiles of [false, true]) {
      const { id } = await engine.add({ url: magnetUri })
      const download = harness.repos.downloads.get(id)
      if (!download) throw new Error('Torrent row was not stored')
      const output = download.tempPath
      await mkdir(output, { recursive: true })
      await writeFile(join(output, 'payload.bin'), 'torrent bytes')
      harness.repos.downloads.update(id, {
        status: 'completed',
        downloadedBytes: 13,
        fileSize: 13,
        finalPath: output,
        completedAt: Date.now()
      })

      await engine.remove(id, deleteFiles)

      if (deleteFiles) {
        await expect(stat(output)).rejects.toThrow()
      } else {
        expect(await readFile(join(output, 'payload.bin'), 'utf8')).toBe('torrent bytes')
      }
    }
  })
})
