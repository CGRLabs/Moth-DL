import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TorrentDownloadTask } from '../../src/main/torrent/task.js'
import {
  getBundledTransmissionExecutable,
  getTorrentMetainfoPath,
  parseTransmissionAddedTorrent,
  parseTransmissionFiles,
  TransmissionManager
} from '../../src/main/torrent/transmission.js'
import type { Download } from '../../src/shared/types.js'
import { createHarness, waitFor, type TestHarness } from '../helpers/harness.js'

const resourcesDirectory = resolve(process.env.MOTH_TEST_RESOURCES_DIR ?? 'resources')
const executablePath = getBundledTransmissionExecutable(resourcesDirectory)
const canRunBundledDaemon = process.platform === 'win32' &&
  executablePath !== null &&
  existsSync(executablePath)

let manager: TransmissionManager | null = null
let workspace: string | null = null
let harness: TestHarness | null = null

function bencodeString(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
}

function bencodeInteger(value: number): Buffer {
  return Buffer.from(`i${value}e`)
}

function bencodeList(values: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from('l'), ...values, Buffer.from('e')])
}

function bencodeDictionary(entries: Array<[string, Buffer]>): Buffer {
  const sorted = [...entries].sort(([left], [right]) => left.localeCompare(right))
  return Buffer.concat([
    Buffer.from('d'),
    ...sorted.flatMap(([key, value]) => [bencodeString(key), value]),
    Buffer.from('e')
  ])
}

afterEach(async () => {
  await manager?.shutdown()
  manager = null
  await harness?.cleanup()
  harness = null
  if (workspace) await rm(workspace, { recursive: true, force: true })
  workspace = null
})

describe('bundled Transmission runtime', () => {
  it.runIf(canRunBundledDaemon)('starts, adds torrent metainfo, selects files, and applies transfer caps', async () => {
    if (!executablePath) throw new Error('Bundled Transmission executable path was not resolved')
    workspace = await mkdtemp(join(tmpdir(), 'moth-transmission-test-'))
    manager = new TransmissionManager({
      executablePath,
      configDirectory: join(workspace, 'config'),
      downloadDirectory: join(workspace, 'downloads')
    })

    const client = await manager.start()
    const session = await client.call('session-get')
    expect(session).toMatchObject({
      version: expect.stringContaining('4.1.3'),
      'rpc-version': expect.any(Number)
    })

    const firstFile = Buffer.from('one!')
    const secondFile = Buffer.from('two-file')
    const files = [
      bencodeDictionary([
        ['length', bencodeInteger(firstFile.length)],
        ['path', bencodeList([bencodeString('one.bin')])]
      ]),
      bencodeDictionary([
        ['length', bencodeInteger(secondFile.length)],
        ['path', bencodeList([bencodeString('two.bin')])]
      ])
    ]
    const pieceHash = createHash('sha1')
      .update(Buffer.concat([firstFile, secondFile]))
      .digest()
    const info = bencodeDictionary([
      ['files', bencodeList(files)],
      ['name', bencodeString('fixture')],
      ['piece length', bencodeInteger(16_384)],
      ['pieces', bencodeString(pieceHash)]
    ])
    const metainfo = bencodeDictionary([['info', info]]).toString('base64')
    const added = parseTransmissionAddedTorrent(await client.call('torrent-add', {
      metainfo,
      'download-dir': join(workspace, 'downloads'),
      paused: true
    }))

    try {
      const snapshot = await client.call('torrent-get', {
        ids: [added.id],
        fields: ['files', 'fileStats']
      })
      expect(parseTransmissionFiles(snapshot).map((file) => [file.name, file.size])).toEqual([
        ['fixture/one.bin', firstFile.length],
        ['fixture/two.bin', secondFile.length]
      ])
      await client.call('torrent-set', {
        ids: [added.id],
        'files-wanted': [0],
        'files-unwanted': [1],
        downloadLimited: true,
        downloadLimit: 128,
        uploadLimited: true,
        uploadLimit: 256
      })
      const selection = parseTransmissionFiles(await client.call('torrent-get', {
        ids: [added.id],
        fields: ['files', 'fileStats']
      }))
      expect(selection.map((file) => file.wanted)).toEqual([true, false])
      const limits = await client.call('torrent-get', {
        ids: [added.id],
        fields: ['downloadLimited', 'downloadLimit', 'uploadLimited', 'uploadLimit']
      })
      expect(limits).toMatchObject({
        torrents: [{
          downloadLimited: true,
          downloadLimit: 128,
          uploadLimited: true,
          uploadLimit: 256
        }]
      })
    } finally {
      await client.call('torrent-remove', { ids: [added.id], 'delete-local-data': true })
    }
  })

  it.runIf(canRunBundledDaemon)('verifies a generated torrent from a locally seeded synthetic payload', async () => {
    if (!executablePath) throw new Error('Bundled Transmission executable path was not resolved')
    workspace = await mkdtemp(join(tmpdir(), 'moth-seeded-torrent-'))
    harness = await createHarness({ autoStartDownloads: false })
    const payload = Buffer.alloc(256 * 1024)
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (index * 37 + 11) % 256
    }
    const filename = 'synthetic-moth-seed.bin'
    const pieceLength = 32 * 1024
    const pieceHashes: Buffer[] = []
    for (let offset = 0; offset < payload.length; offset += pieceLength) {
      pieceHashes.push(createHash('sha1').update(payload.subarray(offset, offset + pieceLength)).digest())
    }
    const info = bencodeDictionary([
      ['length', bencodeInteger(payload.length)],
      ['name', bencodeString(filename)],
      ['piece length', bencodeInteger(pieceLength)],
      ['pieces', bencodeString(Buffer.concat(pieceHashes))]
    ])
    const metainfoBytes = bencodeDictionary([['info', info]])
    const id = 'synthetic-seeded-torrent'
    const tempPath = join(harness.downloadDir, '.moth-torrents', id)
    await mkdir(tempPath, { recursive: true })
    await writeFile(join(tempPath, filename), payload)
    await writeFile(getTorrentMetainfoPath(id, tempPath), metainfoBytes)

    const now = Date.now()
    const download: Download = {
      id,
      url: `moth-torrent-file:${createHash('sha256').update(metainfoBytes).digest('hex')}`,
      finalUrl: null,
      filename,
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
      maxRetries: 0,
      errorCode: null,
      errorMessage: null,
      speedLimit: null,
      uploadSpeedLimit: null,
      torrentFiles: null,
      quotaBytes: null,
      scheduledStartAt: null,
      connections: null,
      headers: {},
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    }
    harness.repos.downloads.insert(download)
    manager = new TransmissionManager({
      executablePath,
      configDirectory: join(workspace, 'config'),
      downloadDirectory: tempPath
    })

    const task = new TorrentDownloadTask({
      id,
      download,
      manager,
      repos: harness.repos,
      emit: () => {}
    })
    let taskError: unknown
    const taskRun = task.run().catch((error: unknown) => {
      taskError = error
    })
    try {
      await waitFor(
        () => taskError !== undefined || harness?.repos.downloads.get(id)?.status === 'completed',
        { timeoutMs: 10_000, message: 'Moth did not complete seeded-torrent verification' }
      )
    } catch (error) {
      const client = await manager.start()
      const status = await client.call('torrent-get', {
        fields: [
          'id', 'status', 'error', 'errorString', 'percentDone', 'leftUntilDone',
          'downloadDir', 'files', 'fileStats', 'isFinished', 'haveValid', 'totalSize'
        ]
      })
      task.cancel()
      await taskRun
      throw new Error(
        `Seed verification status: ${JSON.stringify(status)}; ` +
        `stored=${JSON.stringify(harness.repos.downloads.get(id))}; taskError=${String(taskError)}`,
        { cause: error }
      )
    }
    await taskRun
    if (taskError !== undefined) throw taskError

    const seededBytes = await readFile(join(tempPath, filename))
    expect(seededBytes).toEqual(payload)
    expect(createHash('sha256').update(seededBytes).digest('hex'))
      .toBe(createHash('sha256').update(payload).digest('hex'))
    expect(harness.repos.downloads.get(id)).toMatchObject({
      status: 'completed',
      fileSize: payload.length,
      downloadedBytes: payload.length,
      finalPath: tempPath
    })
  }, 60_000)
})
