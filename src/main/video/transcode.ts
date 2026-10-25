/**
 * Single-pass MP3 transcode.
 *
 * `ffmpeg -i <grab> -vn -map 0:a:0 -c:a libmp3lame -q:a 2 <out>` — one
 * process, demux straight into the encoder (never a copy-then-encode chain).
 * Default VBR q2 (~190 kbps); official FFmpeg builds only.
 *
 * Safety discipline (same as tag writes in `media/write.ts`): encode to a
 * staged `<out>.mothconvert` temp file, verify it is non-empty, then
 * atomically replace the original. Any failure deletes the temp and leaves
 * the grabbed file byte-identical.
 */

import { spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { rm, stat } from 'node:fs/promises'
import { z } from 'zod'
import { MP3_VBR_QUALITY } from '@shared/constants.js'
import { EngineError } from '../util/errors.js'
import { getLogger } from '../util/logger.js'
import { moveFile, resolveWithin } from '../util/paths.js'
import { TRANSCODE_TIMEOUT_MS } from './constants.js'
import { sanitizeResolverMessage } from './resolve.js'

const log = getLogger('video.transcode')

const pathSchema = z.string().min(1).max(4096)

function sanitizeMuxMessage(raw: string): string {
  return sanitizeResolverMessage(raw).replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl)
      return `${url.origin}${url.pathname}`
    } catch {
      return '[media URL]'
    }
  })
}

export interface TranscodeOptions {
  ffmpegPath: string
  /** VBR quality level, default `2` (~190 kbps). */
  quality?: string
  timeoutMs?: number
}

export interface MuxOptions {
  ffmpegPath: string
  audioUrl: string
  container: 'mp4' | 'webm' | 'mkv'
  headers?: Record<string, string>
  timeoutMs?: number
}

export type VideoMuxer = (
  videoPath: string,
  outputPath: string,
  options: MuxOptions
) => Promise<string>

let videoMuxerOverride: VideoMuxer | null = null

export function setVideoMuxerForTests(muxer: VideoMuxer | null): void {
  videoMuxerOverride = muxer
}

/**
 * Builds the single-pass argv. Pure (and unit-tested): one process,
 * audio-only, libmp3lame VBR — never a remux-then-encode chain.
 */
export function buildFfmpegArgs(inputPath: string, stagedPath: string, quality: string): string[] {
  return [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-map',
    '0:a:0',
    '-c:a',
    'libmp3lame',
    '-q:a',
    quality,
    '-f',
    'mp3',
    stagedPath
  ]
}

/** Forces an `.mp3` file name while keeping the stem intact. */
export function withMp3Extension(name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${stem}.mp3`
}

export function withVideoExtension(name: string, extension: 'mp4' | 'webm' | 'mkv'): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${stem}.${extension}`
}

/** Builds a safe stream-copy mux command for a local video and remote audio. */
export function buildFfmpegMuxArgs(
  videoPath: string,
  audioUrl: string,
  stagedPath: string,
  container: 'mp4' | 'webm' | 'mkv',
  headers: Record<string, string> = {}
): string[] {
  const args = [
    '-y',
    '-protocol_whitelist',
    'file,http,https,tcp,tls,crypto,data',
    '-i',
    videoPath
  ]
  const forwardedHeaders: string[] = []
  for (const name of ['cookie', 'referer', 'user-agent']) {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
    if (!entry || /[\r\n]/.test(entry[1])) continue
    const headerName = name === 'user-agent' ? 'User-Agent' : name === 'referer' ? 'Referer' : 'Cookie'
    forwardedHeaders.push(`${headerName}: ${entry[1]}\r\n`)
  }

  if (forwardedHeaders.length) args.push('-headers', forwardedHeaders.join(''))
  args.push(
    '-protocol_whitelist',
    'http,https,tcp,tls,crypto',
    '-rw_timeout',
    '30000000',
    '-i',
    audioUrl,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c',
    'copy'
  )
  if (container === 'mp4') args.push('-movflags', '+faststart')
  args.push('-f', container, stagedPath)
  return args
}

/**
 * Muxes a separate remote audio track into the completed local video track.
 * FFmpeg writes a staged file; the original remains untouched on failure.
 */
export async function muxAudioIntoVideo(
  videoPath: string,
  outputPath: string,
  options: MuxOptions
): Promise<string> {
  if (videoMuxerOverride) return videoMuxerOverride(videoPath, outputPath, options)

  const videoParsed = pathSchema.safeParse(videoPath)
  const outputParsed = pathSchema.safeParse(outputPath)
  const binaryParsed = pathSchema.safeParse(options.ffmpegPath)
  const audioParsed = z.string().url().safeParse(options.audioUrl)
  if (
    !videoParsed.success ||
    !outputParsed.success ||
    !binaryParsed.success ||
    !audioParsed.success ||
    !['http:', 'https:'].includes(new URL(options.audioUrl).protocol)
  ) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Invalid media mux inputs',
      retryable: false
    })
  }

  const stagedPath = resolveWithin(dirname(outputParsed.data), `${basename(outputParsed.data)}.mothmerge`)
  let sourceSize = 0
  try {
    sourceSize = (await stat(videoParsed.data)).size
  } catch {
    throw new EngineError({
      code: 'FILE_IO',
      message: 'The grabbed video is missing, so its audio cannot be merged',
      retryable: false
    })
  }
  if (sourceSize === 0) {
    throw new EngineError({
      code: 'FILE_IO',
      message: 'The grabbed video is empty, so its audio cannot be merged',
      retryable: false
    })
  }

  log.info('Merging a separate audio track into the video', { input: videoParsed.data, container: options.container })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      binaryParsed.data,
      buildFfmpegMuxArgs(videoParsed.data, audioParsed.data, stagedPath, options.container, options.headers),
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new EngineError({ code: 'TIMEOUT', message: 'Merging the audio track took too long', retryable: false }))
    }, options.timeoutMs ?? TRANSCODE_TIMEOUT_MS)
    timer.unref?.()
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(-2000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(
        new EngineError({
          code: 'INTERNAL',
          message: `Could not start the media muxer: ${err.message}`,
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
            code: 'INTERNAL',
            message: `Could not merge the audio track${stderr ? `: ${sanitizeMuxMessage(stderr.slice(-500))}` : ''}`,
            retryable: false
          })
        )
        return
      }
      resolve()
    })
  }).catch(async (err: unknown) => {
    await rm(stagedPath, { force: true }).catch(() => {})
    throw err
  })

  try {
    const stagedSize = (await stat(stagedPath)).size
    if (stagedSize === 0) {
      throw new EngineError({
        code: 'INTERNAL',
        message: 'The audio merge produced an empty file; the grabbed video was left unchanged',
        retryable: false
      })
    }
    await moveFile(stagedPath, outputParsed.data, true)
  } catch (err) {
    await rm(stagedPath, { force: true }).catch(() => {})
    if (err instanceof EngineError) throw err
    throw new EngineError({
      code: 'FILE_IO',
      message: `Could not replace the grab with its merged version: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
      cause: err
    })
  }
  log.info('Separate audio track merged', { output: outputParsed.data })
  return outputParsed.data
}

export interface VideoStreamInfo {
  videoCodec: string | null
  audioCodec: string | null
  hasAudio: boolean
  width?: number | null
  height?: number | null
}

export interface VideoValidationOptions {
  timeoutMs?: number
  requireAudio?: boolean
}

export type VideoValidator = (
  ffmpegPath: string,
  filePath: string,
  options?: VideoValidationOptions
) => Promise<VideoStreamInfo>

let videoValidatorOverride: VideoValidator | null = null

export function setVideoValidatorForTests(validator: VideoValidator | null): void {
  videoValidatorOverride = validator
}

function parseCodecToken(line: string, kind: 'Video' | 'Audio'): string | null {
  // e.g. "Stream #0:0: Video: h264 (High) ..." -> "h264"
  const match = new RegExp(`Stream #\\d+:\\d+.*?: ${kind}:\\s*([^\\s,(]+)`).exec(line)
  return match?.[1]?.toLowerCase() ?? null
}

/** Probes codecs via `ffmpeg -i` stderr (no ffprobe binary needed). */
export async function probeVideoCodecs(
  ffmpegPath: string,
  filePath: string,
  timeoutMs = 30_000
): Promise<VideoStreamInfo> {
  if (videoValidatorOverride) return videoValidatorOverride(ffmpegPath, filePath, { timeoutMs })
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new EngineError({ code: 'TIMEOUT', message: 'Probing the video took too long', retryable: false }))
    }, timeoutMs)
    timer.unref?.()
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8').slice(-8000)
      if (output.length > 32_000) output = output.slice(-32_000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(
        new EngineError({
          code: 'INTERNAL',
          message: `Could not start the media prober: ${err.message}`,
          retryable: false,
          cause: err
        })
      )
    })
    // ffmpeg exits non-zero for `-i` with no output — streams are still in stderr.
    child.on('close', () => {
      clearTimeout(timer)
      resolve(output)
    })
  })
  let videoCodec: string | null = null
  let audioCodec: string | null = null
  let width: number | null = null
  let height: number | null = null
  for (const line of stderr.split(/\r?\n/)) {
    if (videoCodec === null && /:\s*Video:/.test(line)) {
      videoCodec = parseCodecToken(line, 'Video')
      const dimensions = /(?:^|,\s*)(\d{2,5})x(\d{2,5})(?=[,\s\[]|$)/.exec(line)
      if (dimensions) {
        width = Number(dimensions[1])
        height = Number(dimensions[2])
      }
    }
    else if (audioCodec === null && /:\s*Audio:/.test(line)) audioCodec = parseCodecToken(line, 'Audio')
  }
  return { videoCodec, audioCodec, hasAudio: audioCodec !== null, width, height }
}

/** Rejects missing streams and files that cannot be fully decoded by FFmpeg. */
export async function validateVideoFile(
  ffmpegPath: string,
  filePath: string,
  options: VideoValidationOptions = {}
): Promise<VideoStreamInfo> {
  if (videoValidatorOverride) return videoValidatorOverride(ffmpegPath, filePath, options)
  const timeoutMs = options.timeoutMs ?? 30_000
  const info = await probeVideoCodecs(ffmpegPath, filePath, timeoutMs).catch((error: unknown) => {
    throw new EngineError({
      code: 'FILE_IO',
      message: `Could not inspect the downloaded video: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
      cause: error
    })
  })
  if (!info.videoCodec) {
    throw new EngineError({
      code: 'FILE_IO',
      message: 'The downloaded file does not contain a readable video stream',
      retryable: false
    })
  }
  if (options.requireAudio !== false && !info.hasAudio) {
    throw new EngineError({
      code: 'FILE_IO',
      message: 'The downloaded video is missing its expected audio stream',
      retryable: false
    })
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-v',
      'error',
      '-xerror',
      '-i',
      filePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-f',
      'null',
      '-'
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new EngineError({
        code: 'TIMEOUT',
        message: 'Decoding the downloaded video took too long',
        retryable: false
      }))
    }, timeoutMs)
    timer.unref?.()
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new EngineError({
        code: 'INTERNAL',
        message: `Could not start video validation: ${error.message}`,
        retryable: false,
        cause: error
      }))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      reject(new EngineError({
        code: 'FILE_IO',
        message: `The downloaded video failed its full decode check${stderr ? `: ${sanitizeMuxMessage(stderr.slice(-500))}` : ''}`,
        retryable: false
      }))
    })
  })
  return info
}

function isH264(codec: string | null): boolean {
  return codec === 'h264' || codec === 'avc' || codec === 'avc1' || codec === 'avc3'
}

function isAac(codec: string | null): boolean {
  return codec === 'aac' || codec === 'mp4a'
}

/** True when the file is already broadly playable (H.264 video + AAC/no audio). */
export function isPlayableMp4(info: VideoStreamInfo): boolean {
  if (!isH264(info.videoCodec)) return false
  if (info.hasAudio && !isAac(info.audioCodec)) return false
  return true
}

/** Builds an H.264/AAC normalize command; pure for tests. */
export function buildVideoNormalizeArgs(
  inputPath: string,
  stagedPath: string,
  info: VideoStreamInfo
): string[] {
  const args = ['-y', '-i', inputPath, '-map', '0:v:0']
  if (info.hasAudio) args.push('-map', '0:a:0')
  if (isH264(info.videoCodec)) args.push('-c:v', 'copy')
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p')
  if (!info.hasAudio) args.push('-an')
  else if (isAac(info.audioCodec)) args.push('-c:a', 'copy')
  else args.push('-c:a', 'aac', '-b:a', '192k')
  args.push('-movflags', '+faststart', '-f', 'mp4', stagedPath)
  return args
}

/**
 * Re-encodes only when needed so the final MP4 plays everywhere
 * (H.264 + AAC). VP9/AV1/Opus-in-MP4 downloads fine but shows as
 * blank/black with no sound in many players — this is that fix.
 * Returns true when a transcode ran, false when already playable.
 */
export async function normalizeVideoToMp4(
  filePath: string,
  options: { ffmpegPath: string; timeoutMs?: number }
): Promise<boolean> {
  const inputParsed = pathSchema.safeParse(filePath)
  const binaryParsed = pathSchema.safeParse(options.ffmpegPath)
  if (!inputParsed.success || !binaryParsed.success) {
    throw new EngineError({ code: 'INTERNAL', message: 'Invalid video normalize paths', retryable: false })
  }
  const info = await probeVideoCodecs(binaryParsed.data, inputParsed.data)
  if (!info.videoCodec) {
    throw new EngineError({
      code: 'FILE_IO',
      message: 'The downloaded file does not contain a readable video stream',
      retryable: false
    })
  }
  if (isPlayableMp4(info)) return false

  const stagedPath = resolveWithin(dirname(inputParsed.data), `${basename(inputParsed.data)}.mothnormalize`)
  log.info('Normalizing video to H.264/AAC', {
    input: inputParsed.data,
    videoCodec: info.videoCodec,
    audioCodec: info.audioCodec
  })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      binaryParsed.data,
      buildVideoNormalizeArgs(inputParsed.data, stagedPath, info),
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new EngineError({ code: 'TIMEOUT', message: 'Normalizing the video took too long', retryable: false }))
    }, options.timeoutMs ?? TRANSCODE_TIMEOUT_MS)
    timer.unref?.()
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(-2000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(
        new EngineError({
          code: 'INTERNAL',
          message: `Could not start the video normalizer: ${err.message}`,
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
            code: 'INTERNAL',
            message: `Could not normalize the video to H.264/AAC${stderr ? `: ${sanitizeMuxMessage(stderr.slice(-500))}` : ''}`,
            retryable: false
          })
        )
        return
      }
      resolve()
    })
  }).catch(async (err: unknown) => {
    await rm(stagedPath, { force: true }).catch(() => {})
    throw err
  })

  const stagedSize = (await stat(stagedPath).catch(() => null))?.size ?? 0
  if (stagedSize === 0) {
    await rm(stagedPath, { force: true }).catch(() => {})
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Video normalization produced an empty file; the download was left unchanged',
      retryable: false
    })
  }
  await validateVideoFile(binaryParsed.data, stagedPath, { requireAudio: info.hasAudio, timeoutMs: options.timeoutMs })
  await moveFile(stagedPath, inputParsed.data, true).catch(async (err: unknown) => {
    await rm(stagedPath, { force: true }).catch(() => {})
    throw new EngineError({
      code: 'FILE_IO',
      message: `Could not replace the video with its normalized version: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
      cause: err
    })
  })
  log.info('Video normalized to H.264/AAC', { output: inputParsed.data })
  return true
}

/** Single-pass transcode of a grabbed file to MP3, in place. */
export async function transcodeToMp3(
  inputPath: string,
  outputPath: string,
  options: TranscodeOptions
): Promise<string> {
  const inputParsed = pathSchema.safeParse(inputPath)
  const outputParsed = pathSchema.safeParse(outputPath)
  const binaryParsed = pathSchema.safeParse(options.ffmpegPath)
  if (!inputParsed.success || !outputParsed.success || !binaryParsed.success) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Invalid transcode paths',
      retryable: false
    })
  }
  const quality = options.quality ?? MP3_VBR_QUALITY
  if (!/^[0-9]$/.test(quality)) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Invalid MP3 quality — expected a single VBR level 0-9',
      retryable: false
    })
  }

  // Both paths resolve inside the same directory: the temp can never escape it.
  const stagedPath = resolveWithin(dirname(outputParsed.data), `${basename(outputParsed.data)}.mothconvert`)

  let sourceSize = 0
  try {
    sourceSize = (await stat(inputParsed.data)).size
  } catch {
    throw new EngineError({
      code: 'FILE_IO',
      message: 'The grabbed file is missing, so it cannot be converted to MP3',
      retryable: false
    })
  }
  if (sourceSize === 0) {
    throw new EngineError({
      code: 'FILE_IO',
      message: 'The grabbed file is empty, so it cannot be converted to MP3',
      retryable: false
    })
  }

  log.info('Converting grab to MP3', { input: inputParsed.data, quality })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryParsed.data, buildFfmpegArgs(inputParsed.data, stagedPath, quality), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new EngineError({
          code: 'TIMEOUT',
          message: 'Converting the grab to MP3 took too long',
          retryable: false
        })
      )
    }, options.timeoutMs ?? TRANSCODE_TIMEOUT_MS)
    timer.unref?.()
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(-2000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(
        new EngineError({
          code: 'INTERNAL',
          message: `Could not start the converter: ${err.message}`,
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
            code: 'INTERNAL',
            message: `Could not convert the grab to MP3${stderr ? `: ${sanitizeResolverMessage(stderr.slice(-500))}` : ''}`,
            retryable: false
          })
        )
        return
      }
      resolve()
    })
  }).catch(async (err: unknown) => {
    await rm(stagedPath, { force: true }).catch(() => {})
    throw err
  })

  // Verify before replacing: a zero-byte encode must never clobber the grab.
  try {
    const stagedSize = (await stat(stagedPath)).size
    if (stagedSize === 0) {
      await rm(stagedPath, { force: true }).catch(() => {})
      throw new EngineError({
        code: 'INTERNAL',
        message: 'The MP3 conversion produced an empty file; the grab was left unchanged',
        retryable: false
      })
    }
    await moveFile(stagedPath, outputParsed.data, true)
  } catch (err) {
    await rm(stagedPath, { force: true }).catch(() => {})
    if (err instanceof EngineError) throw err
    throw new EngineError({
      code: 'FILE_IO',
      message: `Could not replace the grab with its MP3 version: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
      cause: err
    })
  }
  log.info('Grab converted to MP3', { output: outputParsed.data })
  return outputParsed.data
}
