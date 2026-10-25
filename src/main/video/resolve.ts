/**
 * Page-URL resolver (video-capture slice 1).
 *
 * The resolver tier uses a pinned yt-dlp binary in resolver-only mode:
 * `-J` lists page metadata and available streams without downloading media.
 * YouTube transfers are later delegated to yt-dlp; other supported pages
 * select a direct URL for Moth's normal chunk pipeline.
 *
 * Hard rules:
 *  - the selected quality is a maximum; Moth chooses the best stream at or
 *    below it and muxes a separate audio track when that yields higher video
 *    quality than an available single-file stream;
 *  - audio direct-copy happens only when `acodec` is actually MP3 — an AAC
 *    or Opus track renamed `.mp3` breaks tags and players, so those transcode;
 *  - cookies travel only as extension-forwarded headers (`--add-header`).
 *    `--cookies-from-browser` is NEVER used: the app process must not reach
 *    into the user's browser profile.
 *  - protected playback is not refused by format flag; streams are passed
 */

import { spawn } from 'node:child_process'
import { z } from 'zod'
import type {
  AudioOutputFormat,
  MediaPlaylistEntry,
  MediaPlaylistPreview,
  MediaSubtitleTrack,
  VideoCaptureFormat,
  VideoQuality
} from '@shared/types.js'
import type { MediaHint } from '@shared/media.js'
import { VIDEO_MAX_HEIGHT } from '@shared/constants.js'
import { httpUrlSchema, videoFormatSchema } from '@shared/schemas.js'
import { EngineError } from '../util/errors.js'
import { getLogger } from '../util/logger.js'
import { sanitizeFilename } from '../util/paths.js'
import { RESOLVER_OUTPUT_CAP_BYTES, RESOLVER_TIMEOUT_MS } from './constants.js'

const log = getLogger('video.resolve')

const ytDlpFormatSchema = z.object({
  url: z.string().optional(),
  protocol: z.string().optional(),
  ext: z.string().optional(),
  vcodec: z.string().nullable().optional(),
  acodec: z.string().nullable().optional(),
  height: z.number().nullable().optional(),
  abr: z.number().nullable().optional(),
  vbr: z.number().nullable().optional(),
  tbr: z.number().nullable().optional(),
  format_id: z.string().optional(),
  has_drm: z.boolean().nullable().optional(),
  thumbnail: z.string().optional(),
  http_headers: z.record(z.string(), z.string()).optional()
})

const ytDlpSubtitleSchema = z.object({
  url: z.string().optional(),
  ext: z.string().optional(),
  name: z.string().optional()
})
type YtDlpSubtitle = z.infer<typeof ytDlpSubtitleSchema>

const ytDlpDumpSchema = z.object({
  id: z.string().optional(),
  extractor_key: z.string().optional(),
  title: z.string().optional(),
  thumbnail: z.string().optional(),
  thumbnails: z.array(z.object({
    url: z.string().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional()
  })).optional(),
  http_headers: z.record(z.string(), z.string()).optional(),
  formats: z.array(ytDlpFormatSchema).optional(),
  subtitles: z.record(z.string(), z.array(ytDlpSubtitleSchema)).optional(),
  automatic_captions: z.record(z.string(), z.array(ytDlpSubtitleSchema)).optional(),
  entries: z.array(z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    webpage_url: z.string().optional(),
    thumbnail: z.string().optional(),
    duration: z.number().nullable().optional(),
    extractor_key: z.string().optional()
  }).passthrough()).nullable().optional()
})

export type YtDlpDump = z.infer<typeof ytDlpDumpSchema>
export type YtDlpFormat = z.infer<typeof ytDlpFormatSchema>

export interface VideoHint {
  /** True when the grabbed file must still be transcoded to MP3. */
  needsTranscode: boolean
  acodec: string | null
  vcodec: string | null
  height: number | null
}

export interface ResolvedVideo {
  /** Direct file URL for the chunk engine. */
  url: string
  filename?: string
  hint?: VideoHint
  /** Separate audio URL to mux after the video track completes. */
  audioUrl?: string
  /** Safe request headers supplied by yt-dlp for the selected stream. */
  headers?: Record<string, string>
  /** Headers supplied for a separately resolved audio stream. */
  audioHeaders?: Record<string, string>
  mergeContainer?: 'mp4' | 'webm' | 'mkv'
  mediaHint?: MediaHint
  sourceKey?: string
  subtitleTracks?: MediaSubtitleTrack[]
}

export interface ResolveVideoOptions {
  /** Extension-forwarded `Cookie` header value (never a browser profile). */
  cookies?: string
  userAgent?: string
  referer?: string
  /** Absolute path to the pinned resolver binary. Required outside tests. */
  ytDlpPath?: string
  timeoutMs?: number
  videoQuality?: VideoQuality
  audioFormat?: AudioOutputFormat
  subtitleLanguages?: string[]
  /** Return page metadata without selecting direct URLs when yt-dlp owns transfer. */
  transferWithYtDlp?: boolean
}

/** Spawns the resolver binary; swapped for a stub in tests (no spawning). */
export type YtDlpRunner = (binary: string, args: string[], timeoutMs: number) => Promise<string>

let runnerOverride: YtDlpRunner | null = null

/** Injects a stub resolver for tests. Pass `null` to restore spawning. */
export function setVideoResolverForTests(runner: YtDlpRunner | null): void {
  runnerOverride = runner
}

/** True while a test stub is installed (callers skip helper downloads then). */
export function isVideoResolverStubbed(): boolean {
  return runnerOverride !== null
}

/**
 * Builds the resolver argv. Pure (and unit-tested) so the
 * never-`--cookies-from-browser` rule is pinned by a test, not by review.
 */
export function buildYtDlpArgs(pageUrl: string, options: ResolveVideoOptions = {}): string[] {
  const args = ['-J', '--no-warnings', '--no-playlist']
  if (options.userAgent) args.push('--user-agent', options.userAgent)
  if (options.referer) args.push('--referer', options.referer)
  if (options.cookies) args.push('--add-header', `Cookie: ${options.cookies}`)
  args.push(pageUrl)
  return args
}

function canonicalSourceKey(extractor: string | undefined, id: string | undefined, url: string): string | null {
  if (!id) return null
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  const source = (extractor || host).toLowerCase().replace(/[^a-z0-9._-]/g, '')
  const item = id.replace(/[^a-zA-Z0-9._-]/g, '')
  return source && item ? `${source}:${item}`.slice(0, 512) : null
}

/** Resolves playlist metadata only; item bytes always use Moth's chunk engine. */
export async function resolvePlaylist(
  pageUrl: string,
  options: ResolveVideoOptions = {}
): Promise<MediaPlaylistPreview> {
  const parsed = httpUrlSchema.safeParse(pageUrl)
  if (!parsed.success) {
    throw new EngineError({
      code: 'HTTP_CLIENT_ERROR',
      message: 'Not a supported playlist URL — only http and https pages can be resolved',
      retryable: false
    })
  }
  const runner = runnerOverride ?? spawnRunner
  if (runnerOverride === null && options.ytDlpPath === undefined) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Media capture is not ready yet — restart the app and try again',
      retryable: false
    })
  }
  const args = ['-J', '--flat-playlist', '--no-warnings']
  if (options.userAgent) args.push('--user-agent', options.userAgent)
  if (options.referer) args.push('--referer', options.referer)
  if (options.cookies) args.push('--add-header', `Cookie: ${options.cookies}`)
  args.push(parsed.data)

  let stdout: string
  try {
    stdout = await runner(options.ytDlpPath ?? 'yt-dlp', args, options.timeoutMs ?? RESOLVER_TIMEOUT_MS)
  } catch (err) {
    if (err instanceof EngineError) throw err
    throw new EngineError({
      code: 'INTERNAL',
      message: `Could not list this playlist: ${err instanceof Error ? sanitizeResolverMessage(err.message) : String(err)}`,
      retryable: false,
      cause: err
    })
  }
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch (err) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'The resolver returned invalid playlist data',
      retryable: false,
      cause: err
    })
  }
  const parsedDump = ytDlpDumpSchema.safeParse(raw)
  if (!parsedDump.success) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'The resolver returned unsupported playlist data',
      retryable: false,
      cause: parsedDump.error
    })
  }
  const rawEntries = parsedDump.data.entries ?? []
  const entries: MediaPlaylistEntry[] = []
  for (const [index, entry] of rawEntries.slice(0, 500).entries()) {
    const url = entry.webpage_url ?? (isHttpUrl(entry.url) ? entry.url : undefined)
    if (!url || !isHttpUrl(url)) continue
    entries.push({
      id: entry.id ?? String(index + 1),
      sourceKey: canonicalSourceKey(entry.extractor_key ?? parsedDump.data.extractor_key, entry.id, url),
      title: (entry.title ?? `Item ${index + 1}`).slice(0, 512),
      url,
      thumbnailUrl: isHttpsUrl(entry.thumbnail) ? entry.thumbnail : null,
      durationSeconds:
        typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration >= 0
          ? entry.duration
          : null,
      alreadyDownloaded: false
    })
  }
  if (entries.length === 0) {
    throw new EngineError({
      code: 'HTTP_CLIENT_ERROR',
      message: 'No downloadable items were found in this playlist',
      retryable: false
    })
  }
  return {
    title: parsedDump.data.title?.slice(0, 512) ?? 'Playlist',
    entries,
    truncated: rawEntries.length > 500
  }
}

function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Default runner: spawn the binary, capture stdout, enforce a timeout. */
function spawnRunner(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new EngineError({
          code: 'TIMEOUT',
          message: 'The resolver took too long to list the page streams',
          retryable: true
        })
      )
    }, timeoutMs)
    // A late timer must never keep the app alive on its own.
    timer.unref?.()
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > RESOLVER_OUTPUT_CAP_BYTES) {
        clearTimeout(timer)
        child.kill('SIGKILL')
        reject(
          new EngineError({
            code: 'INTERNAL',
            message: 'The resolver response was too large to parse',
            retryable: false
          })
        )
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 2000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(
        new EngineError({
          code: 'INTERNAL',
          message: `Could not start the resolver: ${err.message}`,
          retryable: false,
          cause: err
        })
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(
          new EngineError({
            code: 'HTTP_CLIENT_ERROR',
            message: `Could not resolve a downloadable file from this page${stderr ? `: ${sanitizeResolverMessage(stderr.slice(-500))}` : ''}`,
            retryable: false
          })
        )
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

/**
 * Keeps resolver diagnostics generic: vendor error lines name extractors and
 * sites, which must never reach user-visible strings verbatim.
 */
export function sanitizeResolverMessage(raw: string): string {
  return raw.replace(/\byoutube\b/gi, 'the media page').trim()
}

/** Parses and validates a `yt-dlp -J` dump. Throws a clear error, never raw JSON. */
export function parseYtDlpDump(input: unknown): YtDlpDump {
  let json: unknown
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input) as unknown
    } catch {
      throw new EngineError({
        code: 'INTERNAL',
        message: 'The resolver returned an unreadable response for this page',
        retryable: false
      })
    }
  } else {
    json = input
  }
  const parsed = ytDlpDumpSchema.safeParse(json)
  if (!parsed.success) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'The resolver returned a response this version does not understand',
      retryable: false
    })
  }
  return parsed.data
}

function hasAudio(codec: string | null | undefined): boolean {
  return Boolean(
    codec &&
      /^(?:aac|mp[123]|mp4a|opus|vorbis|flac|alac|ac-?3|e-?ac-?3|dts|truehd|pcm|speex|amr|wma|atrac|cook|gsm|nellymoser|ra|wavpack)/i.test(
        codec
      )
  )
}

function hasVideo(codec: string | null | undefined): boolean {
  return Boolean(
    codec &&
      /^(?:avc|h\.?26[345]|hevc|hvc1|hev1|vp0?[89]|vp10|av01|theora|mpeg[124](?:video)?|prores|dvvideo|wmv|vc-?1|realvideo|h263|ffv1|mjpeg|rawvideo|cinepak|indeo|av1)/i.test(
        codec
      )
  )
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** The chunk engine can fetch only complete direct HTTP resources, not manifests or fragments. */
function isDirectMediaFormat(format: YtDlpFormat): boolean {
  if (!isHttpUrl(format.url)) return false
  const protocol = format.protocol?.toLowerCase()
  if (protocol && protocol !== 'http' && protocol !== 'https') return false

  const parsed = new URL(format.url)
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname.toLowerCase()
  if (host === 'manifest.googlevideo.com' || host.endsWith('.manifest.googlevideo.com')) return false
  if (/\.(?:m3u8|mpd)(?:$|\/)/i.test(path) || /\/api\/manifest\//i.test(path)) return false
  return true
}

function rateOf(format: YtDlpFormat): number {
  return format.abr ?? format.tbr ?? 0
}

function videoRateOf(format: YtDlpFormat): number {
  return format.vbr ?? format.tbr ?? 0
}

/** Avoid forwarding page cookies to a different host's signed media URL. */
export function headersForResolvedAudio(
  headers: Record<string, string>,
  pageUrl: string,
  audioUrl: string,
  streamHeaders: Record<string, string> = {}
): Record<string, string> {
  const output: Record<string, string> = {}
  for (const name of ['referer', 'user-agent', 'accept', 'accept-language', 'origin']) {
    const entry =
      Object.entries(streamHeaders).find(([key]) => key.toLowerCase() === name) ??
      Object.entries(headers).find(([key]) => key.toLowerCase() === name)
    if (entry) output[entry[0]] = entry[1]
  }
  if (new URL(pageUrl).hostname === new URL(audioUrl).hostname) {
    const cookie = Object.entries(headers).find(([key]) => key.toLowerCase() === 'cookie')
    if (cookie) output[cookie[0]] = cookie[1]
  }
  return output
}

function isMp4Family(ext: string | undefined): boolean {
  return ext === 'mp4' || ext === 'm4v' || ext === 'm4a'
}

function muxContainer(videoExt: string | undefined, audioExt: string | undefined): 'mp4' | 'webm' | 'mkv' {
  if (isMp4Family(videoExt) && isMp4Family(audioExt)) return 'mp4'
  if (videoExt === 'webm' && audioExt === 'webm') return 'webm'
  return 'mkv'
}

function getMediaHint(dump: YtDlpDump): MediaHint {
  const thumbnail = dump.thumbnail ?? dump.thumbnails
    ?.slice()
    .sort(
      (a, b) =>
        (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0)
    )
    .find((candidate) => candidate.url)?.url
  let pageImage: string | undefined
  if (thumbnail) {
    try {
      const parsed = new URL(thumbnail)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') pageImage = parsed.href
    } catch {
      // Malformed thumbnail metadata is optional and must not fail resolution.
    }
  }
  return {
    ...(dump.title ? { title: dump.title } : {}),
    ...(pageImage ? { pageImage } : {})
  }
}

function streamHeaders(dump: YtDlpDump, format: YtDlpFormat): Record<string, string> {
  const supplied = format.http_headers ?? dump.http_headers ?? {}
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(supplied)) {
    if (['user-agent', 'referer', 'accept', 'accept-language', 'origin'].includes(name.toLowerCase())) {
      headers[name] = value
    }
  }
  return headers
}

/**
 * Picks stream URL(s) from a validated dump.
 * Video: tallest single stream with audio at or below the selected quality, or a compatible
 * video/audio pair that FFmpeg can mux after the video download.
 * Audio: highest-bitrate audio-only stream.
 */
export function pickFormat(
  dump: YtDlpDump,
  format: VideoCaptureFormat,
  quality: VideoQuality = VIDEO_MAX_HEIGHT,
  audioFormat: AudioOutputFormat = 'mp3'
): ResolvedVideo {
  const httpFormats = (dump.formats ?? []).filter((candidate) => isHttpUrl(candidate.url))
  const artworkHint = getMediaHint(dump)

  const formats = httpFormats.filter(isDirectMediaFormat)
  if (httpFormats.length > 0 && formats.length === 0) {
    throw new EngineError({
      code: 'HTTP_CLIENT_ERROR',
      message: 'The page only exposed segmented or manifest streams; no direct media file is available',
      retryable: false
    })
  }
  const playable = formats
  if (playable.length === 0) {
    throw new EngineError({
      code: 'HTTP_CLIENT_ERROR',
      message: 'The resolver returned no downloadable streams for this page',
      retryable: false
    })
  }

  if (format === 'audio') {
    const audioOnly = playable
      .filter((candidate) => !hasVideo(candidate.vcodec) && hasAudio(candidate.acodec))
      .sort((a, b) => rateOf(b) - rateOf(a))
    const best = audioOnly[0]
    if (!best?.url) {
      throw new EngineError({
        code: 'HTTP_CLIENT_ERROR',
        message: 'No audio stream is available for this page yet',
        retryable: false
      })
    }
    const acodec = best.acodec ?? null
    const sourceKey = canonicalSourceKey(dump.extractor_key, dump.id, best.url)
    return {
      url: best.url,
      filename: buildFilename(dump.title, best.ext ?? 'm4a'),
      ...(sourceKey ? { sourceKey } : {}),
      headers: streamHeaders(dump, best),
      hint: {
        needsTranscode: audioFormat === 'mp3' && !isDirectCopyAudio(acodec),
        acodec,
        vcodec: best.vcodec ?? null,
        height: null
      },
      mediaHint: artworkHint
    }
  }

  const video = playable
    .filter(
      (candidate) =>
        hasVideo(candidate.vcodec) &&
        hasAudio(candidate.acodec) &&
        candidate.height !== undefined &&
        candidate.height !== null &&
        candidate.height <= quality
    )
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || videoRateOf(b) - videoRateOf(a))
  const bestMuxed = video[0]
  const videoOnly = playable
    .filter(
      (candidate) =>
        hasVideo(candidate.vcodec) &&
        !hasAudio(candidate.acodec) &&
        candidate.height !== undefined &&
        candidate.height !== null &&
        candidate.height <= quality
    )
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || videoRateOf(b) - videoRateOf(a))
  const audioOnly = playable
    .filter((candidate) => !hasVideo(candidate.vcodec) && hasAudio(candidate.acodec))
    .sort((a, b) => rateOf(b) - rateOf(a))
  const bestVideo = videoOnly[0]
  const compatibleAudio = bestVideo
    ? audioOnly
        .slice()
        .sort((a, b) => {
          const aCompatible =
            (isMp4Family(bestVideo.ext) && isMp4Family(a.ext)) ||
            (bestVideo.ext === 'webm' && a.ext === 'webm')
              ? 1
              : 0
          const bCompatible =
            (isMp4Family(bestVideo.ext) && isMp4Family(b.ext)) ||
            (bestVideo.ext === 'webm' && b.ext === 'webm')
              ? 1
              : 0
          return bCompatible - aCompatible || rateOf(b) - rateOf(a)
        })[0]
    : undefined

  const separateVideoWins =
    bestVideo?.url !== undefined &&
    compatibleAudio?.url !== undefined &&
    (!bestMuxed ||
      (bestVideo.height ?? 0) > (bestMuxed.height ?? 0) ||
      ((bestVideo.height ?? 0) === (bestMuxed.height ?? 0) &&
        videoRateOf(bestVideo) > videoRateOf(bestMuxed)))

  if (!separateVideoWins && bestMuxed?.url) {
    const sourceKey = canonicalSourceKey(dump.extractor_key, dump.id, bestMuxed.url)
    return {
      url: bestMuxed.url,
      filename: buildFilename(dump.title, bestMuxed.ext ?? 'mp4'),
      ...(sourceKey ? { sourceKey } : {}),
      headers: streamHeaders(dump, bestMuxed),
      hint: {
        needsTranscode: false,
        acodec: bestMuxed.acodec ?? null,
        vcodec: bestMuxed.vcodec ?? null,
        height: bestMuxed.height ?? null
      },
      mediaHint: artworkHint
    }
  }

  if (!separateVideoWins || !bestVideo?.url || !compatibleAudio?.url) {
    throw new EngineError({
      code: 'HTTP_CLIENT_ERROR',
      message: `No video and audio streams suitable for muxing at or below ${quality}p are available for this page yet`,
      retryable: false
    })
  }
  const container = muxContainer(bestVideo.ext, compatibleAudio.ext)
  const sourceKey = canonicalSourceKey(dump.extractor_key, dump.id, bestVideo.url)
  return {
    url: bestVideo.url,
    ...(sourceKey ? { sourceKey } : {}),
    audioUrl: compatibleAudio.url,
    headers: streamHeaders(dump, bestVideo),
    audioHeaders: streamHeaders(dump, compatibleAudio),
    mergeContainer: container,
    filename: buildFilename(dump.title, container),
    hint: {
      needsTranscode: false,
      acodec: compatibleAudio.acodec ?? null,
      vcodec: bestVideo.vcodec ?? null,
      height: bestVideo.height ?? null
    },
    mediaHint: artworkHint
  }
}

function resolveSubtitleTracks(
  dump: YtDlpDump,
  languages: string[],
  pageUrl: string,
  options: ResolveVideoOptions
): MediaSubtitleTrack[] {
  const supportedExtensions = new Set(['vtt', 'srt', 'ass', 'ssa', 'ttml'])
  const baseHeaders: Record<string, string> = { ...(dump.http_headers ?? {}) }
  if (options.userAgent) baseHeaders['user-agent'] = options.userAgent
  if (options.referer) baseHeaders.referer = options.referer
  if (options.cookies) baseHeaders.cookie = options.cookies
  const output: MediaSubtitleTrack[] = []
  for (const language of [...new Set(languages)].slice(0, 8)) {
    const requested = language.toLowerCase()
    const candidates = (source: Record<string, YtDlpSubtitle[]>, automatic: boolean) =>
      Object.entries(source)
        .filter(([code]) => code.toLowerCase() === requested || code.toLowerCase().startsWith(`${requested}-`))
        .flatMap(([code, tracks]) =>
          tracks.flatMap((track) => {
            if (!track.url || !isHttpUrl(track.url) || !track.ext || !supportedExtensions.has(track.ext.toLowerCase())) {
              return []
            }
            return [{
              language: code,
              url: track.url,
              extension: track.ext.toLowerCase() as MediaSubtitleTrack['extension'],
              automatic,
              headers: headersForResolvedAudio(baseHeaders, pageUrl, track.url)
            }]
          })
        )
        .sort((a, b) => Number(a.extension !== 'vtt') - Number(b.extension !== 'vtt'))
    const available = candidates(dump.subtitles ?? {}, false)
    const track = available[0] ?? candidates(dump.automatic_captions ?? {}, true)[0]
    if (track) output.push(track)
  }
  return output
}

/**
 * True only when the source audio is already MP3 and can be kept as-is.
 * AAC/Opus/M4A tracks always transcode: copying them under an `.mp3` name
 * breaks tags and players.
 */
export function isDirectCopyAudio(acodec: string | null | undefined): boolean {
  if (!acodec) return false
  return acodec.toLowerCase() === 'mp3' || acodec.toLowerCase().startsWith('mp3.')
}

function buildFilename(title: string | undefined, ext: string): string | undefined {
  if (!title) return undefined
  const cleanExt = /^[a-z0-9]{1,8}$/i.test(ext) ? ext : 'bin'
  return sanitizeFilename(`${title}.${cleanExt}`)
}

/**
 * Resolves page metadata and, unless yt-dlp will own the transfer, selects
 * direct file URL(s) for the caller's transfer path.
 */
export async function resolveVideo(
  pageUrl: string,
  format: VideoCaptureFormat = 'video',
  options: ResolveVideoOptions = {}
): Promise<ResolvedVideo> {
  const urlParsed = httpUrlSchema.safeParse(pageUrl)
  if (!urlParsed.success) {
    throw new EngineError({
      code: 'HTTP_CLIENT_ERROR',
      message: 'Not a supported page URL — only http and https pages can be grabbed',
      retryable: false
    })
  }
  const formatParsed = videoFormatSchema.safeParse(format)
  if (!formatParsed.success) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Invalid "format" — expected "video" or "audio"',
      retryable: false
    })
  }

  const runner = runnerOverride ?? spawnRunner
  const binary = options.ytDlpPath ?? 'yt-dlp'
  if (runnerOverride === null && options.ytDlpPath === undefined) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Media capture is not ready yet — restart the app and try again',
      retryable: false
    })
  }
  const args = buildYtDlpArgs(urlParsed.data, options)
  log.info('Resolving page streams', { pageUrl: urlParsed.data, format: formatParsed.data })
  let stdout: string
  try {
    stdout = await runner(binary, args, options.timeoutMs ?? RESOLVER_TIMEOUT_MS)
  } catch (err) {
    if (err instanceof EngineError) throw err
    throw new EngineError({
      code: 'INTERNAL',
      message: `Could not resolve a downloadable file from this page: ${err instanceof Error ? sanitizeResolverMessage(err.message) : String(err)}`,
      retryable: false,
      cause: err
    })
  }
  const dump = parseYtDlpDump(stdout)
  if (options.transferWithYtDlp) {
    const audioExtension = (options.audioFormat ?? 'mp3') === 'mp3' ? 'mp3' : 'm4a'
    const extension = formatParsed.data === 'audio' ? audioExtension : 'mp4'
    const sourceKey = canonicalSourceKey(dump.extractor_key, dump.id, urlParsed.data)
    const subtitleTracks = options.subtitleLanguages?.length
      ? resolveSubtitleTracks(dump, options.subtitleLanguages, urlParsed.data, options)
      : []
    return {
      url: urlParsed.data,
      filename: buildFilename(dump.title, extension),
      ...(sourceKey ? { sourceKey } : {}),
      mediaHint: getMediaHint(dump),
      ...(subtitleTracks.length > 0 ? { subtitleTracks } : {})
    }
  }
  const selected = pickFormat(dump, formatParsed.data, options.videoQuality, options.audioFormat)
  if (!options.subtitleLanguages?.length) return selected
  const subtitleTracks = resolveSubtitleTracks(dump, options.subtitleLanguages, urlParsed.data, options)
  return subtitleTracks.length > 0 ? { ...selected, subtitleTracks } : selected
}
