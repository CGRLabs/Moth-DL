/**
 * Generates the application and tray icons from the Moth brand source art.
 *
 * `resources/newmothicon.png` is decoded by `pngDecoder.mjs`, box-filter
 * downscaled by `iconEncoder.mjs` and re-encoded with the existing writer, so
 * every artefact is the same artwork. Run with: node scripts/makeIcons.mjs
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './pngDecoder.mjs'
import { downscaleBox, encodePng, writeIco } from './iconEncoder.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const resources = join(here, '..', 'resources')
mkdirSync(resources, { recursive: true })

const source = decodePng(readFileSync(join(resources, 'newmothicon.png')))
if (source.width !== source.height) {
  throw new Error(`makeIcons: brand source must be square (got ${source.width}x${source.height})`)
}
console.log(`source newmothicon.png (${source.width}x${source.height})`)

const targets = [
  { file: 'icon.png', size: 256 },
  { file: 'trayIcon.png', size: 32 },
  { file: 'trayIcon@2x.png', size: 64 }
]

for (const target of targets) {
  const rgba = downscaleBox(source.rgba, source.width, target.size)
  const png = encodePng(target.size, target.size, rgba)
  writeFileSync(join(resources, target.file), png)
  console.log(`wrote ${target.file} (${target.size}x${target.size}, ${png.length} bytes)`)
}

// Windows shortcut and installer icons need a real .ico container.
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const ico = writeIco(
  icoSizes.map((size) => ({ size, rgba: downscaleBox(source.rgba, source.width, size) }))
)
writeFileSync(join(resources, 'moth.ico'), ico)
console.log(`wrote moth.ico (${icoSizes.length} sizes, ${ico.length} bytes)`)

// The legacy container is superseded; leaving it would ship stale branding.
rmSync(join(resources, 'tiri.ico'), { force: true })

console.log('Icons generated in resources/')
