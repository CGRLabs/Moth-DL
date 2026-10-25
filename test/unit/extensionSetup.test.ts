import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareExtensionSetup } from '../../src/main/ingest/extensionSetup.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createSetupSources(root: string): Promise<void> {
  await mkdir(join(root, 'browser-extension', 'chrome'), { recursive: true })
  await mkdir(join(root, 'browser-extension', 'setup-guide'), { recursive: true })
  await writeFile(join(root, 'browser-extension', 'chrome', 'manifest.json'), '{"name":"Moth"}')
  await writeFile(join(root, 'browser-extension', 'chrome', 'service-worker.js'), 'worker')
  for (const name of ['INSTALL.html', 'step-1.svg', 'step-2.svg', 'step-3.svg']) {
    await writeFile(join(root, 'browser-extension', 'setup-guide', name), name)
  }
}

describe('prepareExtensionSetup', () => {
  it('copies the unpacked extension and illustrated guide into a Desktop folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moth-extension-setup-'))
    temporaryDirectories.push(root)
    const resources = join(root, 'resources')
    const desktop = join(root, 'Desktop')
    await createSetupSources(resources)

    const folder = await prepareExtensionSetup(desktop, resources)

    expect(folder).toBe(join(desktop, 'Moth Chrome Extension Setup'))
    expect(await readFile(join(folder, 'extension', 'manifest.json'), 'utf8')).toBe('{"name":"Moth"}')
    expect(await readFile(join(folder, 'extension', 'service-worker.js'), 'utf8')).toBe('worker')
    expect(await readFile(join(folder, 'INSTALL.html'), 'utf8')).toBe('INSTALL.html')
    await expect(access(join(folder, 'step-1.svg'))).resolves.toBeUndefined()
    await expect(access(join(folder, 'step-2.svg'))).resolves.toBeUndefined()
    await expect(access(join(folder, 'step-3.svg'))).resolves.toBeUndefined()
  })

  it('refreshes generated setup files but preserves other user files in the folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moth-extension-setup-'))
    temporaryDirectories.push(root)
    const resources = join(root, 'resources')
    const desktop = join(root, 'Desktop')
    await createSetupSources(resources)
    const folder = join(desktop, 'Moth Chrome Extension Setup')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'keep.txt'), 'user data')

    await prepareExtensionSetup(desktop, resources)

    expect(await readFile(join(folder, 'keep.txt'), 'utf8')).toBe('user data')
  })

  it('fails clearly when the app build does not contain the extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moth-extension-setup-'))
    temporaryDirectories.push(root)

    await expect(prepareExtensionSetup(join(root, 'Desktop'), join(root, 'missing')))
      .rejects.toThrow('The Chrome extension files are missing from this app build.')
  })
})
