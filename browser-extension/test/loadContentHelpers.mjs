import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = dirname(fileURLToPath(import.meta.url))

export function loadContentHelpers(browser = 'chrome') {
  const extensionDirectory = join(testDirectory, '..', browser)
  const scripts = [
    'metaText.js',
    'pageMeta.js',
    'mediaProbe.js',
    'badge.js',
    'transferPolicy.js',
    'badgePrefs.js'
  ]
  for (const filename of scripts) {
    const path = join(extensionDirectory, filename)
    vm.runInThisContext(readFileSync(path, 'utf8'), { filename: path })
  }
  return {
    ...globalThis.MothMetaText,
    ...globalThis.MothPageMeta,
    ...globalThis.MothMediaProbe,
    ...globalThis.MothBadge,
    ...globalThis.MothBadgePrefs
  }
}
