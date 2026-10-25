import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '4.1.3'
const MSI_SHA256 = 'c8ea492d8f46fadac26e0c05b244cabba556201d5fe348dfcf1cf036621741f8'
const SOURCE_SHA256 = 'ce7d2d8b101f7eb54bc3cf0bc55f52f7ebd4a25fa48e00bdca9a7e0fc02617da'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TRANSMISSION_DIR = join(ROOT, 'resources', 'transmission')
const RUNTIME_DIR = join(TRANSMISSION_DIR, 'win-x64')
const SOURCE_DIR = join(TRANSMISSION_DIR, 'source')
const CACHE_DIR = join(TRANSMISSION_DIR, 'cache')
const execFileAsync = promisify(execFile)
const RUNTIME_FILES = [
  'transmission-daemon.exe',
  'dbus-1.dll',
  'libcrypto-3-x64.dll',
  'libcurl.dll',
  'libssl-3-x64.dll',
  'zlib.dll'
]

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.warn('The bundled Transmission runtime is currently prepared only for Windows x64.')
  process.exit(0)
}

await Promise.all([
  mkdir(RUNTIME_DIR, { recursive: true }),
  mkdir(SOURCE_DIR, { recursive: true }),
  mkdir(CACHE_DIR, { recursive: true })
])

const msiPath = join(CACHE_DIR, `transmission-${VERSION}-x64.msi`)
const sourcePath = join(SOURCE_DIR, `transmission-${VERSION}.tar.xz`)
await ensureAsset(
  `https://github.com/transmission/transmission/releases/download/${VERSION}/transmission-${VERSION}-x64.msi`,
  msiPath,
  MSI_SHA256
)
await ensureAsset(
  `https://github.com/transmission/transmission/releases/download/${VERSION}/transmission-${VERSION}.tar.xz`,
  sourcePath,
  SOURCE_SHA256
)

const tempRoot = await mkdtemp(join(tmpdir(), 'moth-transmission-'))
try {
  const extractionDir = join(tempRoot, 'extracted')
  await mkdir(extractionDir, { recursive: true })
  await execFileAsync('msiexec.exe', [
    '/a',
    msiPath,
    '/qn',
    `TARGETDIR=${extractionDir}`
  ], { timeout: 120_000 })

  const vendorDir = join(extractionDir, 'PFiles', 'Transmission')
  for (const file of RUNTIME_FILES) {
    await copyFile(join(vendorDir, file), join(RUNTIME_DIR, file))
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

const daemonPath = join(RUNTIME_DIR, 'transmission-daemon.exe')
const { stdout, stderr } = await execFileAsync(daemonPath, ['--version'], {
  cwd: RUNTIME_DIR,
  timeout: 10_000
})
if (!`${stdout}${stderr}`.includes(`transmission-daemon ${VERSION}`)) {
  throw new Error(`Bundled Transmission did not report the expected version ${VERSION}`)
}

console.log(`Prepared Transmission ${VERSION} and its corresponding source archive for Windows x64.`)

async function ensureAsset(url, destination, expectedHash) {
  try {
    const cached = await readFile(destination)
    if (sha256(cached) === expectedHash) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actualHash = sha256(bytes)
  if (actualHash !== expectedHash) {
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedHash}, received ${actualHash}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  const partialPath = `${destination}.${process.pid}.partial`
  await writeFile(partialPath, bytes, { flag: 'w' })
  await rename(partialPath, destination)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
