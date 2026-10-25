import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadEngine } from '../../src/main/core/engine.js'
import { closeAgents } from '../../src/main/net/httpClient.js'
import { makeBody, startTestServer, type TestServer } from '../helpers/testServer.js'
import { createHarness, waitForStatus, type TestHarness } from '../helpers/harness.js'

const MIB = 1024 * 1024
const CHUNK_SIZE = 2 * MIB
const DEFAULT_SIZE_MIB = 128
const DEFAULT_INTERRUPTION_COUNT = 40

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

function configuredInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

describe('repeatable local resume benchmark', () => {
  it.skipIf(process.env.MOTH_RUN_RESUME_BENCHMARK !== '1')(
    'survives repeated dropped range responses and verifies the final SHA-256',
    async () => {
      const sizeMiB = configuredInteger('MOTH_BENCH_SIZE_MIB', DEFAULT_SIZE_MIB, 16, 1024)
      const interruptionCount = configuredInteger(
        'MOTH_BENCH_INTERRUPTION_COUNT',
        DEFAULT_INTERRUPTION_COUNT,
        1,
        Math.floor((sizeMiB * MIB) / CHUNK_SIZE) - 1
      )
      const body = makeBody(sizeMiB * MIB, 7022)
      const expectedSha256 = createHash('sha256').update(body).digest('hex')
      server = await startTestServer({
        body,
        dropFirstRangeChunks: {
          count: interruptionCount,
          chunkSize: CHUNK_SIZE,
          afterBytes: 16 * 1024
        }
      })
      harness = await createHarness({
        chunkSize: CHUNK_SIZE,
        defaultConnections: 8,
        maxConcurrentDownloads: 1,
        maxRetries: 5,
        verifyChecksums: true
      })
      engine = new DownloadEngine(harness.repos, harness.settings, harness.db)

      const startedAt = performance.now()
      const added = await engine.add({
        url: server.url,
        expectedChecksum: expectedSha256,
        checksumAlgorithm: 'sha256'
      })
      await waitForStatus(harness.repos, added.id, ['completed', 'failed'], 10 * 60_000)
      const elapsedSeconds = (performance.now() - startedAt) / 1000
      const completed = harness.repos.downloads.get(added.id)
      expect(completed?.status, completed?.errorMessage ?? 'download record missing').toBe('completed')

      const output = await readFile(completed!.finalPath!)
      const actualSha256 = createHash('sha256').update(output).digest('hex')
      expect(actualSha256).toBe(expectedSha256)
      expect(server.droppedResponseCount()).toBe(interruptionCount)
      const retransmittedBytes = server.bytesServed() - body.length
      expect(retransmittedBytes).toBeGreaterThan(0)
      expect(retransmittedBytes).toBeLessThan(interruptionCount * CHUNK_SIZE)

      console.info(JSON.stringify({
        benchmark: 'http-resume',
        fileBytes: body.length,
        forcedConnectionDrops: server.droppedResponseCount(),
        retransmittedBytes,
        elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
        sha256: actualSha256
      }))
    },
    10 * 60_000
  )
})
