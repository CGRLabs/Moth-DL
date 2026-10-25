/**
 * Download-on-demand helper binaries.
 *
 * The resolver (yt-dlp) and the transcoder (FFmpeg) are fetched into the
 * user-data `bin/` directory on first use, with progress, and pinned to the
 * versions in settings. Failure is never naked: every error names the manual
 * fallback (vendor page + destination path).
 *
 * Update policy: explicit only. The `HelperUpdateChecker` interface stubs the
 * prompt-on-breakage flow ("grabs are failing — check for a resolver
 * update?"); the full policy UI is out of scope for slice 1.
 */

import { chmod } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { HELPER_BIN_DIR_NAME } from '@shared/constants.js'
import { EngineError } from '../util/errors.js'
import { getLogger } from '../util/logger.js'
import { ensureDir, moveFile, pathExists, resolveWithin } from '../util/paths.js'
import {
  HELPER_DOWNLOAD_CAP_BYTES,
  HELPER_DOWNLOAD_TIMEOUT_MS,
  ffmpegAssetFor,
  ytDlpAssetFor,
  type HelperAsset
} from './constants.js'
import { extractFfmpegArchive, verifyFfmpegBinary } from './extract.js'

const log = getLogger('video.helpers')
const ffmpegSetupTasks = new Map<string, Promise<FfmpegHelperPath>>()

const versionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.\-]+$/, 'Version must be a plain version label')

const ensureHelpersSchema = z.object({
  userDataDir: z.string().min(1).max(4096),
  helperDir: z.string().min(1).max(4096).optional(),
  ytDlpVersion: versionSchema,
  ffmpegVersion: versionSchema
})

export interface HelperProgress {
  asset: 'yt-dlp' | 'ffmpeg'
  downloadedBytes: number
  totalBytes: number | null
}

export interface EnsureHelpersOptions {
  /** App user-data directory; `bin/` lives underneath it by default. */
  userDataDir: string
  /** Absolute override (the `helperDir` setting); empty/undefined = default. */
  helperDir?: string
  ytDlpVersion: string
  ffmpegVersion: string
  onProgress?: (progress: HelperProgress) => void
  platform?: NodeJS.Platform
}

export interface HelperPaths {
  binDir: string
  ytDlpPath: string
  ffmpegPath: string
}

export interface YtDlpHelperPath {
  binDir: string
  ytDlpPath: string
}

export interface FfmpegHelperPath {
  binDir: string
  ffmpegPath: string
}

/** Prompt-on-breakage update policy behind an interface (full UI out of scope). */
export interface HelperUpdateStatus {
  updateAvailable: boolean
  latestVersion: string | null
}

export interface HelperUpdateChecker {
  checkForUpdates(current: { ytDlpVersion: string; ffmpegVersion: string }): Promise<HelperUpdateStatus>
}

/** Stub: always reports "no update". The real checker lands with the policy UI. */
export class StubHelperUpdateChecker implements HelperUpdateChecker {
  async checkForUpdates(_current: {
    ytDlpVersion: string
    ffmpegVersion: string
  }): Promise<HelperUpdateStatus> {
    return { updateAvailable: false, latestVersion: null }
  }
}

/** Generic prompt shown when repeated resolver failures suggest site drift. */
export function promptOnBreakageMessage(): string {
  return 'Media grabs keep failing — the site may have changed its format. Check for a resolver update in Settings.'
}

/**
 * Resolves the helper directory. The default lives under user-data; an
 * explicit override must be absolute. Every path goes through `resolveWithin`.
 */
export function resolveBinDir(userDataDir: string, helperDir?: string): string {
  if (helperDir !== undefined && helperDir !== '') {
    if (!isAbsolute(helperDir)) {
      throw new EngineError({
        code: 'INTERNAL',
        message: 'The helper directory override must be an absolute path',
        retryable: false
      })
    }
    return resolveWithin(resolve(helperDir), '.')
  }
  return resolveWithin(userDataDir, HELPER_BIN_DIR_NAME)
}

/** Downloads a URL to memory with progress, enforcing a size cap. */
async function fetchBytes(
  url: string,
  asset: 'yt-dlp' | 'ffmpeg',
  onProgress: ((progress: HelperProgress) => void) | undefined
): Promise<{ bytes: Uint8Array; totalBytes: number | null }> {
  let response: Response
  try {
    response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(HELPER_DOWNLOAD_TIMEOUT_MS)
    })
  } catch (err) {
    throw new EngineError({
      code: 'NETWORK',
      message: `Could not reach the helper download (${asset}): ${err instanceof Error ? err.message : String(err)}`,
      cause: err
    })
  }
  if (!response.ok || !response.body) {
    if (response.status === 404) {
      throw new EngineError({
        code: 'HTTP_CLIENT_ERROR',
        // The caller (`ensureHelpers`) wraps this with the manual fallback
        // (vendor page + destination path), so this only names the cause:
        // a stale or never-existent version pin, not a network blip.
        message: `Helper download not found at ${url} (HTTP 404) — the pinned version does not exist`,
        httpStatus: response.status,
        retryable: false
      })
    }
    throw new EngineError({
      code: 'HTTP_SERVER_ERROR',
      message: `Helper download failed (${asset}): HTTP ${response.status}`,
      httpStatus: response.status,
      retryable: response.status >= 500
    })
  }
  const totalBytes = Number(response.headers.get('content-length') ?? NaN)
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let downloaded = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    downloaded += next.value.byteLength
    if (downloaded > HELPER_DOWNLOAD_CAP_BYTES) {
      await reader.cancel().catch(() => {})
      throw new EngineError({
        code: 'INTERNAL',
        message: `Helper download exceeded the ${HELPER_DOWNLOAD_CAP_BYTES} byte cap (${asset})`,
        retryable: false
      })
    }
    chunks.push(next.value)
    onProgress?.({ asset, downloadedBytes: downloaded, totalBytes: total })
  }
  const bytes = new Uint8Array(downloaded)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, totalBytes: total }
}

function verifySha256(bytes: Uint8Array, expectedHex: string, asset: HelperAsset): void {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new EngineError({
      code: 'CHECKSUM_MISMATCH',
      message:
        `The downloaded helper failed verification (${asset.fileName}); ` +
        `it was discarded. Fetch it by hand from ${asset.manualPage}.`,
      retryable: false
    })
  }
}

/**
 * Fetches a single-file helper into `destPath` via a staged temp file plus
 * atomic replace (the same discipline as tag writes). No-op when present.
 */
async function ensureSingleFile(
  asset: HelperAsset,
  destPath: string,
  binDir: string,
  kind: 'yt-dlp' | 'ffmpeg',
  onProgress: ((progress: HelperProgress) => void) | undefined
): Promise<void> {
  if (await pathExists(destPath)) {
    await makeExecutable(destPath)
    return
  }
  log.info('Fetching helper on first use', { asset: asset.fileName, url: asset.url })
  const { bytes } = await fetchBytes(asset.url, kind, onProgress).catch((err: unknown) => {
    throw withManualFallback(err, asset, destPath)
  })
  if (asset.sha256) {
    verifySha256(bytes, asset.sha256, asset)
  } else {
    log.warn('No pinned checksum for helper; skipping verification', { asset: asset.fileName })
  }
  const staged = resolveWithin(binDir, `${asset.fileName}.download`)
  const { writeFile } = await import('node:fs/promises')
  try {
    await writeFile(staged, bytes)
    await moveFile(staged, destPath, true)
  } catch (err) {
    const { rm } = await import('node:fs/promises')
    await rm(staged, { force: true }).catch(() => {})
    throw withManualFallback(err, asset, destPath)
  }
  await makeExecutable(destPath)
  log.info('Helper ready', { path: destPath })
}

/** Wraps any fetch/write failure with the manual fallback the user needs. */
function withManualFallback(err: unknown, asset: HelperAsset, destPath: string): EngineError {
  if (err instanceof EngineError && err.code === 'CHECKSUM_MISMATCH') return err
  const detail = err instanceof Error ? err.message : String(err)
  return new EngineError({
    code: 'INTERNAL',
    message:
      `Could not fetch the media helper (${asset.fileName}): ${detail}. ` +
      `Fetch it by hand from ${asset.manualPage} and place it at ${destPath}, then retry.`,
    retryable: false,
    cause: err
  })
}

/** Best-effort executable bit; Windows ignores it harmlessly. */
async function makeExecutable(path: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    await chmod(path, 0o755)
  } catch (err) {
    log.warn('Could not set the executable bit on a helper', { path, error: err })
  }
}

/**
 * Ensures both helpers exist, downloading pinned builds on first use.
 * Returns absolute paths contained in the bin directory.
 */
export async function ensureHelpers(options: EnsureHelpersOptions): Promise<HelperPaths> {
  const [ytDlp, ffmpeg] = await Promise.all([ensureYtDlpHelper(options), ensureFfmpegHelper(options)])
  return { binDir: ytDlp.binDir, ytDlpPath: ytDlp.ytDlpPath, ffmpegPath: ffmpeg.ffmpegPath }
}

function parseHelperOptions(options: EnsureHelpersOptions): {
  userDataDir: string
  helperDir?: string
  ytDlpVersion: string
  ffmpegVersion: string
  platform: NodeJS.Platform
  binDir: string
} {
  const parsed = ensureHelpersSchema.safeParse({
    userDataDir: options.userDataDir,
    ...(options.helperDir !== undefined ? { helperDir: options.helperDir } : {}),
    ytDlpVersion: options.ytDlpVersion,
    ffmpegVersion: options.ffmpegVersion
  })
  if (!parsed.success) {
    throw new EngineError({
      code: 'INTERNAL',
      message: `Invalid helper configuration — ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      retryable: false
    })
  }
  return {
    ...parsed.data,
    platform: options.platform ?? process.platform,
    binDir: resolveBinDir(parsed.data.userDataDir, parsed.data.helperDir)
  }
}

/** Ensures only the page resolver exists; ordinary media resolution does not need FFmpeg. */
export async function ensureYtDlpHelper(options: EnsureHelpersOptions): Promise<YtDlpHelperPath> {
  const config = parseHelperOptions(options)
  const { platform, binDir } = config
  await ensureDir(binDir)

  const ytDlp = ytDlpAssetFor(platform, config.ytDlpVersion)
  const ytDlpPath = resolveWithin(binDir, ytDlp.fileName)
  await ensureSingleFile(ytDlp, ytDlpPath, binDir, 'yt-dlp', options.onProgress)
  return { binDir, ytDlpPath }
}

/** Ensures FFmpeg only when a conversion or separate-track mux actually needs it. */
export async function ensureFfmpegHelper(options: EnsureHelpersOptions): Promise<FfmpegHelperPath> {
  const config = parseHelperOptions(options)
  const targetPath = resolveWithin(config.binDir, ffmpegAssetFor(config.platform, config.ffmpegVersion).binaryName)
  const existing = ffmpegSetupTasks.get(targetPath)
  if (existing) return existing

  const setup = ensureFfmpegHelperAt(config, options)
  ffmpegSetupTasks.set(targetPath, setup)
  try {
    return await setup
  } finally {
    if (ffmpegSetupTasks.get(targetPath) === setup) ffmpegSetupTasks.delete(targetPath)
  }
}

async function ensureFfmpegHelperAt(
  config: ReturnType<typeof parseHelperOptions>,
  options: EnsureHelpersOptions
): Promise<FfmpegHelperPath> {
  const { platform, binDir } = config
  await ensureDir(binDir)

  const ffmpeg = ffmpegAssetFor(platform, config.ffmpegVersion)
  const ffmpegPath = resolveWithin(binDir, ffmpeg.binaryName)
  if (!(await pathExists(ffmpegPath))) {
    if (platform === process.platform) {
      for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
        const systemPath = join(directory, ffmpeg.binaryName)
        if (!(await pathExists(systemPath))) continue
        try {
          await verifyFfmpegBinary(systemPath)
          log.info('Using FFmpeg found on PATH', { path: systemPath })
          return { binDir, ffmpegPath: systemPath }
        } catch (err) {
          log.warn('Ignoring an unusable FFmpeg found on PATH', { path: systemPath, error: err })
        }
      }
    }
    // The vendor ships an archive, not a bare binary. Download it once, then
    // extract just the transcoder binary next to it (system tar first,
    // built-in zip reader as fallback — see `extract.ts`).
    const archivePath = resolveWithin(binDir, ffmpeg.fileName)
    if (!(await pathExists(archivePath))) {
      log.info('Fetching transcoder archive on first use', { url: ffmpeg.url })
      await fetchBytes(ffmpeg.url, 'ffmpeg', options.onProgress)
        .then(async ({ bytes }) => {
          if (ffmpeg.sha256) verifySha256(bytes, ffmpeg.sha256, ffmpeg)
          const { writeFile } = await import('node:fs/promises')
          await writeFile(archivePath, bytes)
        })
        .catch((err: unknown) => {
          throw withManualFallback(err, ffmpeg, ffmpegPath)
        })
    }
    if (!(await pathExists(ffmpegPath))) {
      try {
        log.info('Extracting transcoder binary', { archive: archivePath })
        await extractFfmpegArchive(archivePath, binDir, ffmpeg.binaryName)
      } catch (err) {
        throw withManualFallback(err, ffmpeg, ffmpegPath)
      }
    }
    if (!(await pathExists(ffmpegPath))) {
      throw withManualFallback(
        `Extraction finished but ${ffmpeg.binaryName} was not found in the archive.`,
        ffmpeg,
        ffmpegPath
      )
    }
    try {
      await verifyFfmpegBinary(ffmpegPath)
    } catch (err) {
      throw withManualFallback(err, ffmpeg, ffmpegPath)
    }
  }
  await makeExecutable(ffmpegPath)

  return { binDir, ffmpegPath }
}
