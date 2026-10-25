import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FolderWatcher } from '../../src/main/ingest/watcher.js'

let directory: string | null = null
let watcher: FolderWatcher | null = null

afterEach(async () => {
  watcher?.stop()
  watcher = null
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = null
})

describe('FolderWatcher', () => {
  it('watches the configured download folder and reports partial browser files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'moth-watch-'))
    let resolveDetected: ((value: { filename: string; size: number }) => void) | null = null
    const detected = new Promise<{ filename: string; size: number }>((resolve) => {
      resolveDetected = resolve
    })
    watcher = new FolderWatcher({
      folders: [directory],
      onDetected: ({ filename, size }) => resolveDetected?.({ filename, size })
    })

    watcher.start()
    expect(watcher.folders).toEqual([directory])
    await writeFile(join(directory, 'video.mp4.crdownload'), Buffer.from('partial video'))

    await expect(
      Promise.race([
        detected,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Watcher did not report the partial file')), 2000)
        )
      ])
    ).resolves.toEqual({ filename: 'video.mp4', size: 13 })
  })
})
