import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { Download } from '@shared/types.js'
import { EngineError, isCanceled } from '../util/errors.js'
import { getLogger } from '../util/logger.js'
import { hashRange, verifyFile } from '../util/checksum.js'
import { isWithin, moveFile, resolveWithin, sanitizeFilename } from '../util/paths.js'
import { emitActivity } from '../core/activity.js'
import type { TaskContext, TaskEvent, TaskProgress } from '../core/task.js'
import type { PendingMediaResolution } from '../db/repositories.js'
import type { AudioOutputFormat, VideoQuality } from '@shared/types.js'
import { validateVideoFile } from './transcode.js'
export { isYouTubePage } from '../core/router.js'

const log = getLogger('video.download')
const PROGRESS_PREFIX = 'MOTH_PROGRESS\t'

export interface YtDlpDownloadOptions {
  binaryPath: string
  ffmpegPath: string
  pageUrl: string
  format: 'video' | 'audio'
  videoQuality: VideoQuality
  audioFormat: AudioOutputFormat
  headers: Record<string, string>
  workDir: string
  speedLimit: number | null
  ytDlpVersion: string
}

export interface YtDlpProgress {
  /** Per-file destination yt-dlp reports (e.g. media.f308.mp4); null for legacy 5-field lines. */
  filename: string | null
  downloadedBytes: number
  totalBytes: number | null
  speed: number
  eta: number | null
}

export interface YtDlpRunRequest {
  binaryPath: string
  args: string[]
  workDir: string
  onProgress: (progress: YtDlpProgress) => void
}

export type YtDlpRunner = (request: YtDlpRunRequest) => Promise<string>

let runnerOverride: YtDlpRunner | null = null

export function setYtDlpRunnerForTests(runner: YtDlpRunner | null): void {
  runnerOverride = runner
}

function ytDlpFormatSelection(options: Pick<YtDlpDownloadOptions, 'format' | 'videoQuality' | 'audioFormat'>): {
  selector: string
  formatSort: string | null
  remuxVideo: string | null
  mergeOutputFormat: string | null
  audioExtraction: { format: string; quality: string } | null
} {
  // Prefer native H.264/AAC in MP4 so yt-dlp can remux (stream copy) instead
  // of re-encoding. Fallbacks preserve old behavior for VP9/AV1/Opus sources.
  const selector =
    options.format === 'video'
      ? `bestvideo[height<=${options.videoQuality}][vcodec^=avc][ext=mp4]+bestaudio[acodec^=mp4a][ext=m4a]/bestvideo[height<=${options.videoQuality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${options.videoQuality}]+bestaudio/best[height<=${options.videoQuality}]/best`
      : 'bestaudio'
  return {
    selector,
    formatSort: options.format === 'video' ? 'res,fps,vcodec:avc,acodec:mp4a,ext' : null,
    remuxVideo: options.format === 'video' ? 'mp4' : null,
    mergeOutputFormat: options.format === 'video' ? 'mp4' : null,
    audioExtraction:
      options.format === 'audio' && options.audioFormat === 'mp3'
        ? { format: 'mp3', quality: '0' }
        : null
  }
}

export function buildYtDlpDownloadArgs(options: YtDlpDownloadOptions): string[] {
  const selection = ytDlpFormatSelection(options)
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_PREFIX}%(progress.filename)s\t%(progress.downloaded_bytes)s\t%(progress.total_bytes)s\t%(progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.eta)s`,
    '--continue',
    '--format',
    selection.selector,
    '--output',
    join(options.workDir, 'media.%(ext)s'),
    '--print',
    'after_move:filepath',
    '--ffmpeg-location',
    options.ffmpegPath
  ]
  if (selection.formatSort && selection.remuxVideo && selection.mergeOutputFormat) {
    args.push(
      '--format-sort',
      selection.formatSort,
      '--remux-video',
      selection.remuxVideo,
      '--merge-output-format',
      selection.mergeOutputFormat
    )
  }
  if (selection.audioExtraction) {
    args.push(
      '--extract-audio',
      '--audio-format',
      selection.audioExtraction.format,
      '--audio-quality',
      selection.audioExtraction.quality
    )
  }
  if (options.speedLimit !== null && options.speedLimit > 0) {
    args.push('--limit-rate', String(Math.trunc(options.speedLimit)))
  }
  for (const [name, value] of Object.entries(options.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) continue
    args.push('--add-header', `${name}:${value}`)
  }
  args.push(options.pageUrl)
  return args
}

export function parseYtDlpProgressLine(line: string): YtDlpProgress | null {
  const normalized = line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trimStart()
    .replace(/^\[download\]\s*/, '')
    .trim()
  if (!normalized.startsWith(PROGRESS_PREFIX)) return null
  const fields = normalized.slice(PROGRESS_PREFIX.length).split('\t')
  // New 6-field template includes filename first; accept legacy 5-field lines.
  let filename: string | null = null
  let rest = fields
  if (fields.length === 6) {
    const rawName = (fields[0] ?? '').trim()
    filename = rawName && rawName !== 'NA' ? rawName : null
    rest = fields.slice(1)
  } else if (fields.length !== 5) {
    return null
  }
  const downloadedBytes = Number(rest[0])
  if (!Number.isFinite(downloadedBytes) || downloadedBytes < 0) return null
  const total = Number(rest[1])
  const estimate = Number(rest[2])
  const speed = Number(rest[3])
  const eta = Number(rest[4])
  return {
    filename,
    downloadedBytes,
    totalBytes: Number.isFinite(total) && total > 0 ? total : Number.isFinite(estimate) && estimate > 0 ? estimate : null,
    speed: Number.isFinite(speed) && speed > 0 ? speed : 0,
    eta: Number.isFinite(eta) && eta >= 0 ? eta : null
  }
}

export function parseYtDlpOutputPath(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .trim()
        .replace(/^\[download\]\s*/, '')
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
    )
    .filter(Boolean)
  return lines.at(-1) ?? null
}

export function ytDlpWorkDirectory(tempPath: string): string {
  return resolveWithin(dirname(tempPath), `${basename(tempPath)}.yt-dlp`)
}

export async function clearYtDlpWorkDirectory(tempPath: string): Promise<void> {
  await rm(ytDlpWorkDirectory(tempPath), { recursive: true, force: true })
}

/**
 * Key identifying which fragments a run will produce. Pure for tests.
 * Any change means old partials are for different streams and `--continue`
 * must not touch them.
 */
export function ytDlpFragmentKey(
  options: Pick<
    YtDlpDownloadOptions,
    'pageUrl' | 'format' | 'videoQuality' | 'audioFormat' | 'headers' | 'ytDlpVersion'
  >
): string {
  const headers = Object.entries(options.headers)
    .filter(([name, value]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/[\r\n]/.test(value))
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([nameA, valueA], [nameB, valueB]) => nameA.localeCompare(nameB) || valueA.localeCompare(valueB))
  const identity = JSON.stringify({
    pageUrl: options.pageUrl,
    format: options.format,
    videoQuality: options.videoQuality,
    audioFormat: options.audioFormat,
    formatSelection: ytDlpFormatSelection(options),
    headers,
    ytDlpVersion: options.ytDlpVersion
  })
  return createHash('sha256').update(identity).digest('hex')
}

const FRAGMENT_KEY_FILENAME = '.moth-fragments.json'

/**
 * Reads the pinned fragment key, or null when the work dir is fresh/legacy.
 * Legacy dirs (no key file) with existing fragments are treated as stale:
 * they predate pinning, so their provenance is unknown.
 */
export async function readFragmentKey(workDir: string): Promise<string | null> {
  let raw: string
  try {
    raw = await readFile(join(workDir, FRAGMENT_KEY_FILENAME), 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { key?: unknown }
    return typeof parsed.key === 'string' ? parsed.key : null
  } catch {
    return null
  }
}

export async function writeFragmentKey(workDir: string, key: string): Promise<void> {
  await writeFile(join(workDir, FRAGMENT_KEY_FILENAME), JSON.stringify({ key }), 'utf8')
}

/** True when the work dir holds any yt-dlp fragment/output from a prior run. */
export async function workDirHasFragments(workDir: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(workDir)
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
  return entries.some((entry) => entry !== FRAGMENT_KEY_FILENAME)
}

export async function ensureYtDlpWorkDirectory(
  workDir: string,
  options: Pick<
    YtDlpDownloadOptions,
    'pageUrl' | 'format' | 'videoQuality' | 'audioFormat' | 'headers' | 'ytDlpVersion'
  >,
  downloadId?: string
): Promise<void> {
  await mkdir(workDir, { recursive: true })
  const key = ytDlpFragmentKey(options)
  const pinned = await readFragmentKey(workDir)
  if (pinned === key) return
  if (pinned !== null || (await workDirHasFragments(workDir))) {
    log.info(
      'Clearing stale yt-dlp fragments from a previous run',
      downloadId ? { id: downloadId } : undefined
    )
    await rm(workDir, { recursive: true, force: true })
    await mkdir(workDir, { recursive: true })
  }
  await writeFragmentKey(workDir, key)
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * yt-dlp sometimes reports its output with an extended-length prefix
 * (`\\?\C:\...`), forward slashes, or different drive-letter case. Strip and
 * normalize those before comparing so the same directory never reads as
 * "outside".
 */
export function normalizeReportedPath(raw: string): string {
  let out = raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  out = out.replace(/^\\\\\?\\(UNC\\)?/, (m) => (m.endsWith('UNC\\') ? '\\\\' : ''))
  out = out.replace(/^\\\\\.\\/, '')
  return out
}

function sameDirForComparison(parent: string, child: string): boolean {
  const norm = (p: string): string => {
    let s = resolve(p).replace(/^\\\\\?\\(UNC\\)?/, (m) => (m.endsWith('UNC\\') ? '\\\\' : ''))
    s = s.replace(/^\\\\\.\\/, '')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  const rel = relative(norm(parent), norm(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel))
}

const MEDIA_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'm4a', 'mp3', 'mov', 'm4v'])

/**
 * Resolves yt-dlp's reported output to a file inside `workDir`.
 *
 * 1. The reported path itself, when it is contained and exists.
 * 2. Otherwise the freshest playable file written into `workDir` since the
 *    transfer started (guards against stale files via `mtimeMs >= sinceMs`).
 *    yt-dlp occasionally reports merge/remux outputs in a form that compares
 *    as outside (extended-length prefix, short-name alias) while the bytes
 *    are exactly where asked.
 */
export async function resolveYtDlpOutput(
  workDir: string,
  reportedPath: string,
  sinceMs: number
): Promise<{ path: string; fellBack: boolean }> {
  const normalized = normalizeReportedPath(reportedPath)
  const direct = resolve(workDir, normalized)
  if ((isWithin(workDir, direct) || sameDirForComparison(workDir, direct)) && (await stat(direct).catch(() => null))?.isFile()) {
    return { path: direct, fellBack: false }
  }
  const entries = await readdir(workDir).catch(() => [] as string[])
  let best: { path: string; mtimeMs: number } | null = null
  for (const entry of entries) {
    const ext = extname(entry).slice(1).toLowerCase()
    if (!MEDIA_EXTENSIONS.has(ext)) continue
    const candidate = resolve(workDir, entry)
    const info = await stat(candidate).catch(() => null)
    if (!info?.isFile() || info.size <= 0 || info.mtimeMs < sinceMs - 5_000) continue
    if (!best || info.mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs: info.mtimeMs }
  }
  if (best) {
    log.warn('yt-dlp reported an unusable output path; using the freshest file in its work directory', {
      reportedPath: reportedPath.slice(0, 300),
      picked: basename(best.path)
    })
    return { path: best.path, fellBack: true }
  }
  throw new EngineError({
    code: 'FILE_IO',
    message:
      `yt-dlp reported an output path outside its work directory (${normalized.slice(0, 200)}). ` +
      `Its folder contained: ${entries.slice(0, 10).join(', ') || '(empty)'}`,
    retryable: false
  })
}

/**
 * Accumulates yt-dlp progress across its sequential files (video, then audio).
 * yt-dlp reports `downloaded_bytes` per file, resetting to 0 for the second
 * file — treating it as a single counter made the bar jump backwards. Summing
 * per-filename entries keeps bytes/total monotonic. Legacy 5-field lines
 * without a filename fall back to a single `_single` entry plus a reset guard
 * (a backwards jump starts a new implicit file).
 */
export class YtDlpProgressAccumulator {
  private readonly files = new Map<string, { downloaded: number; total: number | null }>()
  private lastAt = Date.now()
  private lastBytes = 0

  update(
    current: Download,
    progress: YtDlpProgress
  ): { download: Download; event: Extract<TaskEvent, { type: 'progress' }> } {
    const now = Date.now()
    if (progress.filename) {
      this.files.set(progress.filename, {
        downloaded: progress.downloadedBytes,
        total: progress.totalBytes
      })
    } else if (!Number.isFinite(progress.downloadedBytes)) {
      // ignore malformed
    } else {
      const existing = this.files.get('_single')
      if (existing && progress.downloadedBytes < existing.downloaded - 4096) {
        // Backward jump without filename info: previous file finished, a new
        // one started. Carry the finished total forward so bytes stay monotonic.
        const finishedTotal = existing.total ?? existing.downloaded
        this.files.set('_prev', {
          downloaded: finishedTotal,
          total: finishedTotal
        })
      }
      const prev = this.files.get('_prev')
      const prevBytes = prev?.downloaded ?? 0
      this.files.set('_single', {
        downloaded: progress.downloadedBytes,
        total: progress.totalBytes
      })
      void prevBytes
    }

    let downloaded = 0
    let total = 0
    let allKnown = this.files.size > 0
    for (const entry of this.files.values()) {
      downloaded += entry.downloaded
      if (entry.total !== null && entry.total > 0) total += entry.total
      else allKnown = false
    }
    if (!allKnown) {
      // At least one file size unknown: keep total monotonic, never below bytes.
      total = Math.max(current.fileSize, downloaded, total)
    }
    if (total <= 0) total = Math.max(current.fileSize, downloaded)
    // Monotonic guard against out-of-order lines.
    if (downloaded < this.lastBytes) downloaded = this.lastBytes
    if (total < current.fileSize && current.fileSize > 0) total = current.fileSize

    const speed =
      progress.speed ||
      (now > this.lastAt
        ? Math.max(0, (downloaded - this.lastBytes) * 1000 / (now - this.lastAt))
        : 0)
    this.lastAt = now
    this.lastBytes = downloaded

    const download: Download = {
      ...current,
      fileSize: total,
      downloadedBytes: downloaded,
      status: 'downloading'
    }
    const complete = total > 0 && downloaded >= total
    const payload: TaskProgress = {
      id: current.id,
      downloadedBytes: downloaded,
      fileSize: total,
      speed,
      eta: progress.eta,
      chunksComplete: complete ? 1 : 0,
      chunksTotal: 1,
      chunkBitmap: [complete ? 1 : 0],
      activeConnections: 1
    }
    return { download, event: { type: 'progress', progress: payload } }
  }
}

function parseProgressField(
  current: Download,
  progress: YtDlpProgress,
  accumulator: YtDlpProgressAccumulator
): { download: Download; event: Extract<TaskEvent, { type: 'progress' }> } {
  return accumulator.update(current, progress)
}

export class YtDlpDownloadTask {
  private download: Download
  private running = false
  private stopReason: 'PAUSED' | 'CANCELED' | null = null
  private readonly startedAt = Date.now()
  private workDir: string

  constructor(
    private readonly context: TaskContext,
    download: Download,
    private readonly resolution: PendingMediaResolution,
    private readonly getPaths: () => Promise<{ ytDlpPath: string; ffmpegPath: string; ytDlpVersion: string }>
  ) {
    this.download = download
    this.workDir = ytDlpWorkDirectory(download.tempPath)
  }

  pause(): void {
    this.stopReason = 'PAUSED'
    this.child?.kill()
  }

  cancel(): void {
    this.stopReason = 'CANCELED'
    this.child?.kill()
  }

  destroy(): void {
    this.child?.kill()
  }

  private child: ReturnType<typeof spawn> | null = null

  async run(): Promise<void> {
    if (this.running) throw new Error('yt-dlp task is already running')
    this.running = true
    const settings = this.context.settings.get()
    this.context.rateLimiter.setPerDownload(this.download.id, this.download.speedLimit)
    try {
      this.context.repos.youtubeVideoOutputs.remove(this.download.id)
      this.setStatus('connecting')
      const paths = await this.getPaths()
      if (this.stopReason) throw new EngineError({ code: this.stopReason, message: 'Media transfer stopped' })
      const speedLimit = this.download.speedLimit === null
        ? settings.globalSpeedLimit
        : settings.globalSpeedLimit === null
          ? this.download.speedLimit
          : Math.min(this.download.speedLimit, settings.globalSpeedLimit)
      const options: YtDlpDownloadOptions = {
        binaryPath: paths.ytDlpPath,
        ffmpegPath: paths.ffmpegPath,
        pageUrl: this.resolution.sourcePageUrl,
        format: this.resolution.format,
        videoQuality: this.resolution.videoQuality,
        audioFormat: this.resolution.audioFormat,
        headers: this.download.headers,
        workDir: this.workDir,
        speedLimit,
        ytDlpVersion: paths.ytDlpVersion
      }
      // Fragments from an older run (previous app version's format selector,
      // a different quality, or a crashed merge) must never be stitched onto
      // fresh bytes via `--continue`: mixed-format fragments merge into a
      // valid container with garbage NAL units (plays blank). The selector is
      // pinned in the work dir; any change wipes it and starts clean.
      // Same-selector resumes (pause/resume, retry) keep their partials.
      await ensureYtDlpWorkDirectory(this.workDir, options, this.download.id)
      this.setStatus('downloading')
      const accumulator = new YtDlpProgressAccumulator()
      const onProgress = (progress: YtDlpProgress): void => {
        const update = parseProgressField(this.download, progress, accumulator)
        this.download = update.download
        this.context.repos.downloads.update(this.download.id, {
          fileSize: update.download.fileSize,
          downloadedBytes: update.download.downloadedBytes
        })
        this.context.emit(update.event)
      }
      const args = buildYtDlpDownloadArgs(options)
      log.info('Starting yt-dlp media transfer', {
        id: this.download.id,
        format: options.format,
        quality: options.videoQuality
      })
      const outputPath = await (runnerOverride
        ? runnerOverride({ binaryPath: paths.ytDlpPath, args, workDir: this.workDir, onProgress })
        : this.runProcess(paths.ytDlpPath, args, onProgress))
      this.child = null
      if (this.stopReason) throw new EngineError({ code: this.stopReason, message: 'Media transfer stopped' })
      // Trust yt-dlp's reported `after_move:filepath`, contained to the work
      // dir. Hardcoding `media.mp4` promoted stale/partial files from resumed
      // or failed merges as success (blank video, no audio).
      const { path: resolvedOutputPath } = await resolveYtDlpOutput(this.workDir, outputPath, this.startedAt)
      let workingPath = resolvedOutputPath
      const preInfo = await stat(workingPath).catch(() => null)
      if (!preInfo || preInfo.size <= 0) {
        throw new EngineError({ code: 'FILE_IO', message: 'yt-dlp finished without creating a media file', retryable: true })
      }
      // VP9/AV1/Opus-in-MP4 downloads fine but plays as blank/black with no
      // sound in many players. Normalize to H.264/AAC when needed; failures
      // keep the original file rather than failing the download.
      if (this.resolution.format === 'video') {
        const { normalizeVideoToMp4 } = await import('./transcode.js')
        this.setStatus('verifying')
        const normalized = await normalizeVideoToMp4(workingPath, { ffmpegPath: paths.ffmpegPath })
        if (normalized && extname(workingPath).slice(1).toLowerCase() !== 'mp4') {
          const mp4Path = workingPath.replace(/\.[^.]+$/, '') + '.mp4'
          await moveFile(workingPath, mp4Path)
          workingPath = mp4Path
        }
        const streams = await validateVideoFile(paths.ffmpegPath, workingPath, { requireAudio: true })
        this.context.repos.youtubeVideoOutputs.set(this.download.id, {
          requestedQuality: this.resolution.videoQuality,
          width: streams.width ?? null,
          height: streams.height ?? null,
          videoCodec: streams.videoCodec,
          audioCodec: streams.audioCodec,
          validatedAt: Date.now()
        })
        log.info('YouTube video passed its full decode check', {
          id: this.download.id,
          videoCodec: streams.videoCodec,
          audioCodec: streams.audioCodec,
          width: streams.width ?? null,
          height: streams.height ?? null
        })
      }
      const info = await stat(workingPath).catch(() => null)
      if (!info || info.size <= 0) {
        throw new EngineError({ code: 'FILE_IO', message: 'yt-dlp finished without creating a media file', retryable: true })
      }
      const extension = extname(workingPath).slice(1).toLowerCase()
      if (!/^[a-z0-9]{1,8}$/.test(extension)) {
        throw new EngineError({ code: 'FILE_IO', message: 'yt-dlp produced a file with an invalid extension', retryable: false })
      }
      const filename = sanitizeFilename(
        this.resolution.format === 'audio' && this.resolution.audioFormat === 'mp3'
          ? replaceExtension(this.download.filename, 'mp3')
          : replaceExtension(this.download.filename, extension)
      )
      const outputDirectory = dirname(this.download.finalPath ?? this.download.tempPath)
      const finalPath = this.resolution.requestedDestination
        ? this.download.finalPath ?? resolveWithin(outputDirectory, filename)
        : resolveWithin(outputDirectory, filename)
      await moveFile(workingPath, this.download.tempPath)
      this.download = {
        ...this.download,
        filename,
        finalPath,
        fileSize: info.size,
        downloadedBytes: info.size
      }
      this.context.repos.downloads.update(this.download.id, {
        filename,
        finalPath,
        fileSize: info.size,
        downloadedBytes: info.size,
        status: 'verifying'
      })
      this.setStatus('verifying')

      let checksum: string
      if (settings.verifyChecksums && this.download.expectedChecksum) {
        const verified = await verifyFile(this.download.tempPath, this.download.expectedChecksum)
        if (!verified.ok) {
          throw new EngineError({
            code: 'CHECKSUM_MISMATCH',
            message: `Downloaded file failed checksum verification and was discarded: expected ${verified.expected}, got ${verified.actual}. Retry the download to fetch a fresh copy.`,
            retryable: false
          })
        }
        checksum = verified.actual
      } else {
        checksum = await hashRange(this.download.tempPath, 0, info.size - 1, 'sha256')
      }
      this.context.repos.downloads.update(this.download.id, { computedChecksum: checksum })
      const canFinalize = await this.context.beforeFinalize?.(this.download.id, this.download.tempPath)
      if (canFinalize === false) return
      await moveFile(this.download.tempPath, finalPath)
      const finishedAt = Date.now()
      this.download = { ...this.download, status: 'completed' }
      this.context.repos.downloads.update(this.download.id, {
        status: 'completed',
        completedAt: finishedAt,
        downloadedBytes: info.size,
        errorCode: null,
        errorMessage: null
      })
      emitActivityComplete(this.context, this.download)
      this.context.emit({ type: 'status', id: this.download.id, status: 'completed' })
      await this.context.onCompleted?.(this.download.id, finalPath)
      this.context.emit({
        type: 'finished',
        id: this.download.id,
        finalPath,
        size: info.size,
        durationMs: finishedAt - this.startedAt,
        averageSpeed: finishedAt > this.startedAt ? info.size * 1000 / (finishedAt - this.startedAt) : 0,
        checksum: { algorithm: 'sha256', value: checksum }
      })
      await clearYtDlpWorkDirectory(this.download.tempPath).catch((err: unknown) => {
        log.warn('Could not clean yt-dlp temporary files after completion', {
          id: this.download.id,
          error: err
        })
      })
    } catch (err) {
      if (isCanceled(err)) {
        if (this.stopReason === 'PAUSED') this.setStatus('paused')
        if (this.stopReason === 'CANCELED') {
          await clearYtDlpWorkDirectory(this.download.tempPath).catch((cleanupError: unknown) => {
            log.warn('Could not clean yt-dlp temporary files after cancel', {
              id: this.download.id,
              error: cleanupError
            })
          })
        }
        throw err
      }
      throw err
    } finally {
      this.child = null
      this.running = false
    }
  }

  private async runProcess(
    binaryPath: string,
    args: string[],
    onProgress: (progress: YtDlpProgress) => void
  ): Promise<string> {
    const child = spawn(binaryPath, args, {
      cwd: this.workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    if (!child.stdout || !child.stderr) {
      child.kill()
      throw new EngineError({ code: 'INTERNAL', message: 'Could not capture yt-dlp output', retryable: false })
    }
    return await new Promise<string>((resolve, reject) => {
      let stdout = ''
      let stderrTail = ''
      const stdoutLines = createInterface({ input: child.stdout })
      const stderrLines = createInterface({ input: child.stderr })
      stdoutLines.on('line', (line) => {
        const progress = parseYtDlpProgressLine(line)
        if (progress) {
          onProgress(progress)
          return
        }
        stdout = `${stdout}\n${line}`.slice(-16_384)
      })
      stderrLines.on('line', (line) => {
        stderrTail = `${stderrTail}\n${line}`.slice(-16_384)
        const progress = parseYtDlpProgressLine(line)
        if (progress) onProgress(progress)
      })
      child.once('error', reject)
      child.once('close', (code) => {
        stdoutLines.close()
        stderrLines.close()
        const outputPath = parseYtDlpOutputPath(stdout)
        if (code === 0 && outputPath) {
          resolve(outputPath)
          return
        }
        const detail = stderrTail
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !parseYtDlpProgressLine(line))
          .at(-1)
        reject(
          new EngineError({
            code: this.stopReason ?? 'NETWORK',
            message: this.stopReason ? 'Media transfer stopped' : detail ? `yt-dlp failed: ${detail.replace(/https?:\/\/[^\s"'<>]+/gi, '[media URL]')}` : `yt-dlp exited with code ${code ?? 'unknown'}`,
            retryable: !this.stopReason
          })
        )
      })
    })
  }

  private setStatus(status: Download['status']): void {
    this.download = { ...this.download, status }
    this.context.repos.downloads.update(this.download.id, { status })
    this.context.emit({ type: 'status', id: this.download.id, status })
  }
}

function replaceExtension(filename: string, extension: string): string {
  const dot = filename.lastIndexOf('.')
  return `${dot > 0 ? filename.slice(0, dot) : filename}.${extension}`
}

function emitActivityComplete(context: TaskContext, download: Download): void {
  emitActivity(context.repos, download.id, 'info', `Completed: ${download.filename}`)
}
