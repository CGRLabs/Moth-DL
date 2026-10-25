/**
 * Shared integration-test scaffolding: an isolated temp workspace, a real
 * database, and settings wired to that workspace.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { openDatabase, type Database } from '../../src/main/db/driver.js'
import { migrate } from '../../src/main/db/schema.js'
import { createRepositories, type Repositories } from '../../src/main/db/repositories.js'
import { SettingsStore } from '../../src/main/core/settingsStore.js'
import type { AppSettings } from '../../src/shared/types.js'

export interface TestHarness {
  root: string
  downloadDir: string
  db: Database
  repos: Repositories
  settings: SettingsStore
  cleanup: () => Promise<void>
}

/** Creates an isolated directory tree with a migrated, empty database. */
export async function createHarness(overrides: Partial<AppSettings> = {}): Promise<TestHarness> {
  const root = await mkdtemp(join(tmpdir(), 'moth-test-'))
  const downloadDir = join(root, 'downloads')
  await mkdir(downloadDir, { recursive: true })

  const db = openDatabase({ location: join(root, 'test.db'), synchronous: 'OFF' })
  migrate(db)
  const repos = createRepositories(db)
  const settings = new SettingsStore(repos)
  settings.update({
    downloadDirectory: downloadDir,
    autoCategorize: false,
    maxConcurrentDownloads: 2,
    defaultConnections: 4,
    chunkSize: 64 * 1024,
    maxRetries: 2,
    ...overrides
  })

  return {
    root,
    downloadDir,
    db,
    repos,
    settings,
    cleanup: async () => {
      db.close()
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Random-but-deterministic id generator for tests. */
export function testId(): string {
  return randomBytes(8).toString('hex')
}

/** Polls `predicate` until it is true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const intervalMs = options.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) {
      throw new Error(options.message ?? `waitFor timed out after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Waits for a download to reach one of the given statuses. */
export async function waitForStatus(
  repos: Repositories,
  id: string,
  statuses: readonly string[],
  timeoutMs = 20_000
): Promise<void> {
  await waitFor(
    () => {
      const download = repos.downloads.get(id)
      return download !== null && statuses.includes(download.status)
    },
    { timeoutMs, message: `download ${id} never reached ${statuses.join('|')} (last: ${repos.downloads.get(id)?.status})` }
  )
}
