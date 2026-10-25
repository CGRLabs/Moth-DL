/**
 * Built-application self test.
 *
 * Enabled only when the `MOTH_SMOKE_URL` environment variable is set, and used
 * by `scripts/smoke.mjs` to prove that the *packaged* code path works: real
 * Electron, real preload/IPC wiring, real SQLite file, real HTTP, real disk.
 * The unit and integration suites cannot cover bundle resolution or the
 * `contextBridge` surface, so this closes that gap.
 *
 * It runs after the engine has booted and writes a JSON verdict to
 * `MOTH_SMOKE_RESULT` (or the user-data directory) before quitting.
 */

import { open as openFile, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { DownloadEngine } from './core/engine.js'
import type { Repositories } from './db/repositories.js'
import type { SettingsStore } from './core/settingsStore.js'
import { getLogger } from './util/logger.js'
import { planChunks } from './core/planner.js'
import { runRecovery } from './core/recovery.js'

const log = getLogger('smoke')

export interface SmokeStep {
  message: string
  ok: boolean
  detail?: string
}

export interface SmokeResult {
  steps: SmokeStep[]
  ok: boolean
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitForStatus(repos: Repositories, id: string, statuses: string[], timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  let last = 'unknown'
  while (Date.now() < deadline) {
    const download = repos.downloads.get(id)
    last = download?.status ?? 'missing'
    if (download && statuses.includes(download.status)) return download
    await wait(150)
  }
  throw new Error(`timed out waiting for ${statuses.join('|')}; last status was ${last}`)
}

export async function runSmokeTest(options: {
  url: string
  resultPath: string
  expectedDigest: string | null
  /** Sandbox for downloaded files. Must be set BEFORE any download. */
  downloadDir: string
  engine: DownloadEngine
  repos: Repositories
  settings: SettingsStore
}): Promise<SmokeResult> {
  const { url, resultPath, engine, repos, settings } = options
  const steps: SmokeStep[] = []
  const record = (message: string, ok: boolean, detail?: string): void => {
    steps.push({ message, ok, ...(detail ? { detail } : {}) })
    log.info(ok ? 'SMOKE PASS' : 'SMOKE FAIL', { message, detail })
  }

  try {
    // 0. Sandbox the download directory first. Without this the test writes
    //    into the real OS Downloads folder, because `--user-data-dir` only
    //    redirects app data, not `app.getPath('downloads')`.
    settings.update({ downloadDirectory: options.downloadDir, autoCategorize: false })
    record(
      'download directory is sandboxed away from the real Downloads folder',
      settings.get().downloadDirectory === options.downloadDir,
      `downloadDirectory=${settings.get().downloadDirectory}`
    )

    // 1. Settings round-trip through the real repository.
    const before = settings.get()
    settings.update({ defaultConnections: 6, verifyChecksums: true })
    const reloaded = new (settings.constructor as new (r: Repositories) => SettingsStore)(repos).get()
    record(
      'settings persist to SQLite and reload',
      reloaded.defaultConnections === 6,
      `expected 6, got ${reloaded.defaultConnections}`
    )
    settings.update({ defaultConnections: before.defaultConnections })

    // 2. Add a real download through the engine's public API.
    const added = await engine.add({
      url,
      expectedChecksum: options.expectedDigest ?? undefined,
      connections: 4
    })
    record('engine.add() probed the URL and created a download', Boolean(added.id))
    record(
      'remote size was discovered from the HTTP probe',
      added.fileSize > 0,
      `fileSize=${added.fileSize}`
    )
    record(
      'server advertised range support',
      added.acceptRanges === true,
      `acceptRanges=${added.acceptRanges}`
    )

    // 3. It should reach completion on its own.
    const finished = await waitForStatus(repos, added.id, ['completed', 'failed'])
    record(
      'download completed',
      finished.status === 'completed',
      `status=${finished.status} error=${finished.errorMessage ?? 'none'}`
    )
    if (finished.status === 'completed') {
      const info = await stat(finished.finalPath as string)
      record(
        'final file exists with the full size',
        info.size === added.fileSize,
        `on disk ${info.size}, expected ${added.fileSize}`
      )
      record(
        'no partial file was left behind',
        !(await stat(finished.tempPath).then(
          () => true,
          () => false
        )),
        'the .mothpart file should have been promoted'
      )
      if (options.expectedDigest) {
        const actual = createHash('sha256').update(await readFile(finished.finalPath as string)).digest('hex')
        record(
          'finished file matches the expected SHA-256',
          actual === options.expectedDigest,
          `expected ${options.expectedDigest}, got ${actual}`
        )
      }
    }

    // 4. Crash simulation. A *fresh* download is created with auto-start off, a
    //    real partial file is written with the first 70% of the bytes, the chunk
    //    map is marked accordingly, and recovery must keep that 70%.
    const autoStart = settings.get().autoStartDownloads
    settings.update({ autoStartDownloads: false })
    try {
      const crash = await engine.add({ url, connections: 4 })
      const crashRow = repos.downloads.get(crash.id)
      if (!crashRow || crashRow.fileSize <= 0) {
        record('crash fixture download has a known size', false, 'size was not discovered')
      } else {
        const chunkSize = settings.get().chunkSize
        const chunks = planChunks({
          downloadId: crash.id,
          fileSize: crashRow.fileSize,
          desiredChunkSize: chunkSize
        })
        const completeCount = Math.floor(chunks.length * 0.7)
        const expectedKept = chunks
          .slice(0, completeCount)
          .reduce((sum, chunk) => sum + chunk.size, 0)

        // Write real bytes for the completed prefix, then preallocate the rest,
        // exactly as a hard kill mid-transfer would leave behind.
        const source = await readFile(finished.finalPath as string)
        const handle = await openFile(crashRow.tempPath, 'w')
        try {
          await handle.truncate(crashRow.fileSize)
          let written = 0
          for (let i = 0; i < completeCount; i += 1) {
            const chunk = chunks[i]
            if (!chunk) continue
            await handle.write(
              source.subarray(chunk.start, chunk.end + 1),
              0,
              chunk.size,
              chunk.start
            )
            written += chunk.size
          }
          await handle.sync()
          void written
        } finally {
          await handle.close()
        }

        repos.chunks.replaceAll(
          crash.id,
          chunks.map((chunk, index) => ({
            ...chunk,
            status: index < completeCount ? ('complete' as const) : ('pending' as const),
            bytesWritten: index < completeCount ? chunk.size : 0
          }))
        )
        repos.downloads.update(crash.id, {
          status: 'downloading',
          downloadedBytes: expectedKept
        })

        const report = await runRecovery(repos, {
          verify: 'all',
          desiredChunkSize: chunkSize
        })
        const detail = report.details.find((entry) => entry.id === crash.id)
        record(
          'crash recovery kept the completed 70% instead of restarting',
          detail !== undefined && detail.bytesKept >= expectedKept * 0.95,
          `kept ${detail?.bytesKept ?? 0} of ${expectedKept} expected bytes; action=${detail?.action}`
        )
        record(
          'crash recovery left the incomplete tail pending',
          detail !== undefined && detail.action !== 'reset',
          `action=${detail?.action}`
        )
      }
    } finally {
      settings.update({ autoStartDownloads: autoStart })
    }
  } catch (err) {
    record('smoke test completed without throwing', false, err instanceof Error ? err.message : String(err))
  }

  const result: SmokeResult = { steps, ok: steps.every((step) => step.ok) }
  await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8')
  return result
}
