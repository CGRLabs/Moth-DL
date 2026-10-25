import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveWithin } from '../util/paths.js'

const FOLDER_NAME = 'Moth Chrome Extension Setup'
const EXTENSION_FOLDER_NAME = 'extension'
const GUIDE_FILES = ['INSTALL.html', 'step-1.svg', 'step-2.svg', 'step-3.svg'] as const

function extensionRoots(resourcesDir: string): string[] {
  return [
    join(resourcesDir, 'browser-extension'),
    join(resourcesDir, '..', 'browser-extension')
  ]
}

async function readGuideFile(resourcesDir: string, filename: string): Promise<Buffer> {
  for (const root of extensionRoots(resourcesDir)) {
    try {
      return await readFile(join(root, 'setup-guide', filename))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(`The Chrome extension setup guide is missing: ${filename}`)
}

async function findSourceRoot(resourcesDir: string): Promise<string | null> {
  for (const root of extensionRoots(resourcesDir)) {
    try {
      await access(join(root, 'chrome', 'manifest.json'))
      return root
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return null
}

export async function prepareExtensionSetup(
  desktopDir: string,
  resourcesDir: string
): Promise<string> {
  const sourceRoot = await findSourceRoot(resourcesDir)
  if (!sourceRoot) throw new Error('The Chrome extension files are missing from this app build.')

  const targetRoot = resolveWithin(desktopDir, FOLDER_NAME)
  const extensionTarget = resolveWithin(targetRoot, EXTENSION_FOLDER_NAME)
  await mkdir(targetRoot, { recursive: true })
  await cp(join(sourceRoot, 'chrome'), extensionTarget, { recursive: true, force: true })
  for (const filename of GUIDE_FILES) {
    await writeFile(resolveWithin(targetRoot, filename), await readGuideFile(resourcesDir, filename))
  }
  return targetRoot
}
