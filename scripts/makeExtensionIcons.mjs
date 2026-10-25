/**
 * Generates the browser extension's icon set from the Moth brand source art.
 * Resamples `resources/newmothicon.png` with the shared box-filter resampler,
 * so the extension ships exactly the same artwork as the app.
 *
 * Run with: node scripts/makeExtensionIcons.mjs
 */

import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extRoot = join(here, '..', 'browser-extension')
const resources = join(here, '..', 'resources')

const { decodePng } = await import('./pngDecoder.mjs')
const { downscaleBox, encodePng, SIZES } = await import('./iconEncoder.mjs')

const source = decodePng(readFileSync(join(resources, 'newmothicon.png')))
if (source.width !== source.height) {
  throw new Error(
    `makeExtensionIcons: brand source must be square (got ${source.width}x${source.height})`
  )
}

for (const target of ['chrome', 'firefox']) {
  for (const size of SIZES) {
    const png = encodePng(size, size, downscaleBox(source.rgba, source.width, size))
    const file = join(extRoot, target, `icon${size}.png`)
    writeFileSync(file, png)
    console.log(`wrote ${target}/icon${size}.png (${png.length} bytes)`)
  }
}

console.log('Extension icons generated.')
