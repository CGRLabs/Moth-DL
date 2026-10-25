/**
 * FFmpeg archive extraction with zero new dependencies.
 *
 * Vendor builds ship as archives, not bare binaries:
 *   - Windows (Gyan) + macOS (evermeet): `.zip`
 *   - Linux (johnvansickle): `.tar.xz`
 *
 * Strategy, in order:
 *   1. System `tar -xf` (ships with Win10 1803+, macOS, most Linux).
 *      bsdtar handles `.zip` and `.tar.xz`; GNU tar handles `.tar.xz`.
 *   2. Pure-JS `.zip` fallback (`node:zlib` inflate) for machines where
 *      `tar` cannot read zips. No xz fallback — `node:zlib` has no LZMA —
 *      so a `.tar.xz` without a working `tar` stays a manual-install error.
 *
 * Every extracted path is contained with `resolveWithin` (ZipSlip guard),
 * symlinks are never followed, and sizes are capped before decompression.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { basename } from 'node:path'
import { EngineError } from '../util/errors.js'
import { getLogger } from '../util/logger.js'
import { ensureDir, moveFile, resolveWithin } from '../util/paths.js'

const log = getLogger('video.extract')

const EXTRACT_TIMEOUT_MS = 120_000
/** Largest single decompressed binary accepted (FFmpeg is ~30-80 MB). */
const MAX_ENTRY_BYTES = 300 * 1024 * 1024
const MAX_CENTRAL_ENTRIES = 10_000

export interface ExtractOptions {
  timeoutMs?: number
  /** Override the system `tar` binary (tests). */
  tarBinary?: string
}

interface ZipEntry {
  fileName: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  isDirectory: boolean
  isSymlink: boolean
}

function fail(message: string, cause?: unknown): EngineError {
  return new EngineError({ code: 'INTERNAL', message, retryable: false, cause })
}

/** Basename match, case-sensitive except `.exe` on Windows-style names. */
function isBinaryName(entryName: string, binaryName: string): boolean {
  const base = basename(entryName.replace(/\\/g, '/'))
  if (base === binaryName) return true
  return base.toLowerCase() === binaryName.toLowerCase() && binaryName.toLowerCase().endsWith('.exe')
}

async function runTar(
  tarBinary: string,
  args: string[],
  timeoutMs: number
): Promise<{ ok: boolean; stderr: string; spawnFailed: boolean }> {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const done = (value: { ok: boolean; stderr: string; spawnFailed: boolean }): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    let child
    try {
      child = spawn(tarBinary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch {
      done({ ok: false, stderr: '', spawnFailed: true })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      done({ ok: false, stderr: `${stderr} (timed out)`, spawnFailed: false })
    }, timeoutMs)
    timer.unref?.()
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 2000)
    })
    child.on('error', () => {
      clearTimeout(timer)
      done({ ok: false, stderr, spawnFailed: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ ok: code === 0, stderr, spawnFailed: false })
    })
  })
}

async function findBinaryRecursive(dir: string, binaryName: string): Promise<string | null> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = resolveWithin(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = await findBinaryRecursive(full, binaryName)
      if (hit) return hit
    } else if (entry.isFile() && isBinaryName(entry.name, binaryName)) {
      return full
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (stored + deflated). Enough for vendor FFmpeg zips.
// ---------------------------------------------------------------------------

function findEocd(buffer: Buffer): number {
  const minStart = Math.max(0, buffer.length - 22 - 65536)
  for (let i = buffer.length - 22; i >= minStart; i -= 1) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      return i
    }
  }
  return -1
}

export function parseZipCentralDirectory(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw fail('The helper archive is not a readable zip file')
  const centralCount = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralCount > MAX_CENTRAL_ENTRIES) throw fail('The helper archive lists too many files')
  if (centralOffset >= buffer.length) throw fail('The helper archive is corrupt')

  const entries: ZipEntry[] = []
  let offset = centralOffset
  for (let i = 0; i < centralCount; i += 1) {
    if (offset + 46 > buffer.length) throw fail('The helper archive is corrupt')
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw fail('The helper archive is corrupt')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const fileNameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const externalAttrs = buffer.readUInt32LE(offset + 38)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    if (offset + 46 + fileNameLen > buffer.length) throw fail('The helper archive is corrupt')
    const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLen)
    const isDirectory = fileName.endsWith('/')
    // Unix file-type bits live in the high 16 bits: 0120000 = symlink.
    const unixMode = (externalAttrs >>> 16) & 0o170000
    entries.push({
      fileName,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory,
      isSymlink: unixMode === 0o120000
    })
    offset += 46 + fileNameLen + extraLen + commentLen
  }
  return entries
}

function inflateZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw fail(`The helper archive entry is too large (${entry.fileName})`)
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw fail(`Unsupported compression in the helper archive (${entry.fileName})`)
  }
  const headerAt = entry.localHeaderOffset
  if (headerAt + 30 > buffer.length || buffer.readUInt32LE(headerAt) !== 0x04034b50) {
    throw fail('The helper archive is corrupt')
  }
  const fileNameLen = buffer.readUInt16LE(headerAt + 26)
  const extraLen = buffer.readUInt16LE(headerAt + 28)
  const dataStart = headerAt + 30 + fileNameLen + extraLen
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buffer.length) throw fail('The helper archive is corrupt')
  const compressed = buffer.subarray(dataStart, dataEnd)
  if (entry.method === 0) return Buffer.from(compressed)
  try {
    const out = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES })
    return Buffer.isBuffer(out) ? out : Buffer.from(out)
  } catch (err) {
    throw fail(`Could not decompress the helper archive (${entry.fileName})`, err)
  }
}

/**
 * Extracts the single `binaryName` file from a `.zip` buffer into `destDir`,
 * contained via `resolveWithin`. Returns the absolute path written.
 */
export async function extractBinaryFromZipBuffer(
  buffer: Buffer,
  binaryName: string,
  destDir: string
): Promise<string> {
  const entries = parseZipCentralDirectory(buffer)
  const candidates = entries.filter(
    (entry) => !entry.isDirectory && !entry.isSymlink && isBinaryName(entry.fileName, binaryName)
  )
  if (candidates.length === 0) {
    throw fail(`The helper archive does not contain ${binaryName}`)
  }
  // Prefer the shallowest match (root-level vendor zips over nested extras).
  candidates.sort((a, b) => a.fileName.length - b.fileName.length)
  const entry = candidates[0] as ZipEntry
  const bytes = inflateZipEntry(buffer, entry)
  const destPath = resolveWithin(destDir, basename(binaryName))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(destPath, bytes)
  return destPath
}

async function extractZipManual(archivePath: string, binaryName: string, binDir: string): Promise<string> {
  const buffer = await readFile(archivePath)
  if (buffer.length > MAX_ENTRY_BYTES * 2) throw fail('The helper archive is too large')
  return extractBinaryFromZipBuffer(buffer, binaryName, binDir)
}

/**
 * Extracts `binaryName` from `archivePath` into `binDir/binaryName`.
 * System `tar` first, pure-JS zip fallback for `.zip`. Throws EngineError
 * with the manual fallback still named when nothing works.
 */
export async function extractFfmpegArchive(
  archivePath: string,
  binDir: string,
  binaryName: string,
  options: ExtractOptions = {}
): Promise<string> {
  const destPath = resolveWithin(binDir, binaryName)
  const lower = archivePath.toLowerCase()
  const isZip = lower.endsWith('.zip')
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS
  const tarBinary = options.tarBinary ?? 'tar'

  const stagedDir = resolveWithin(binDir, `.extract-${randomBytes(8).toString('hex')}`)
  await ensureDir(stagedDir)
  try {
    const tar = await runTar(tarBinary, ['-xf', archivePath, '-C', stagedDir], timeoutMs)
    if (tar.ok) {
      const found = await findBinaryRecursive(stagedDir, binaryName)
      if (found) {
        await moveFile(found, destPath, true)
        return destPath
      }
      log.warn('System tar extracted but the binary was not found', { archivePath, binaryName })
    } else if (!tar.spawnFailed) {
      log.warn('System tar could not read the helper archive', { archivePath, stderr: tar.stderr.slice(-300) })
    }

    if (isZip) {
      try {
        return await extractZipManual(archivePath, binaryName, binDir)
      } catch (err) {
        if (!tar.spawnFailed && tar.ok) throw err
        if (tar.spawnFailed) {
          log.warn('System tar unavailable, trying built-in zip reader', { archivePath })
          return await extractZipManual(archivePath, binaryName, binDir)
        }
        throw err
      }
    }

    throw fail(
      `Could not extract ${binaryName} from the helper archive at ${archivePath}` +
        `${tar.stderr ? `: ${tar.stderr.slice(-300).trim()}` : ''}`
    )
  } finally {
    await rm(stagedDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Smoke-checks the extracted binary (`ffmpeg -version` must exit 0). */
export async function verifyFfmpegBinary(ffmpegPath: string, timeoutMs = 15_000): Promise<void> {
  const info = await stat(ffmpegPath).catch(() => null)
  if (!info || info.size === 0) throw fail('The extracted helper is empty')
  const result = await new Promise<{ ok: boolean }>((resolve) => {
    let child
    try {
      child = spawn(ffmpegPath, ['-version'], { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve({ ok: false })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* gone */
      }
      resolve({ ok: false })
    }, timeoutMs)
    timer.unref?.()
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 })
    })
  })
  if (!result.ok) throw fail('The extracted helper does not run')
  log.info('Helper verified', { path: ffmpegPath })
}
