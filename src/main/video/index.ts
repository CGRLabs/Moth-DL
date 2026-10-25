/**
 * Media capture: non-YouTube pages use Moth's direct-file pipeline; YouTube
 * media transfers are delegated to yt-dlp.
 *
 * The orchestrator (which owns `index.ts`) wires this module:
 *   1. call `configureVideoCapture({ userDataDir })` once at bootstrap;
 *   2. forward `format` from the ingest request into `engine.add()`.
 *
 * Until `configureVideoCapture` runs, any `format`-bearing add fails with a
 * clear message instead of touching the network. Absent `format` always takes
 * the legacy direct-file path.
 */

import { z } from 'zod'
import { EngineError } from '../util/errors.js'
import { resolveWithin } from '../util/paths.js'

export {
  ensureHelpers,
  ensureFfmpegHelper,
  ensureYtDlpHelper,
  StubHelperUpdateChecker,
  promptOnBreakageMessage
} from './helpers.js'
export type { EnsureHelpersOptions, HelperPaths, HelperProgress } from './helpers.js'
export { extractBinaryFromZipBuffer, extractFfmpegArchive, verifyFfmpegBinary } from './extract.js'
export {
  buildYtDlpArgs,
  headersForResolvedAudio,
  isDirectCopyAudio,
  isVideoResolverStubbed,
  parseYtDlpDump,
  pickFormat,
  resolveVideo,
  sanitizeResolverMessage,
  setVideoResolverForTests
} from './resolve.js'
export type { ResolveVideoOptions, ResolvedVideo, VideoHint, YtDlpDump } from './resolve.js'
export {
  buildFfmpegArgs,
  buildFfmpegMuxArgs,
  buildVideoNormalizeArgs,
  isPlayableMp4,
  muxAudioIntoVideo,
  normalizeVideoToMp4,
  probeVideoCodecs,
  setVideoValidatorForTests,
  setVideoMuxerForTests,
  transcodeToMp3,
  validateVideoFile,
  withMp3Extension,
  withVideoExtension
} from './transcode.js'
export type { MuxOptions, TranscodeOptions, VideoMuxer, VideoValidationOptions, VideoValidator } from './transcode.js'

let userDataDir: string | null = null

/** One-time bootstrap wiring. Must run before any `format`-bearing add. */
export function configureVideoCapture(config: { userDataDir: string }): void {
  const parsed = z.string().min(1).max(4096).safeParse(config.userDataDir)
  if (!parsed.success) {
    throw new EngineError({
      code: 'INTERNAL',
      message: 'Invalid user-data directory for media capture',
      retryable: false
    })
  }
  // Contained against itself: honestly an absolute path, never relative drift.
  userDataDir = resolveWithin(parsed.data, '.')
}

/** User-data root for helper binaries, or `null` before bootstrap wiring. */
export function getVideoCaptureUserDataDir(): string | null {
  return userDataDir
}

/** Resets bootstrap wiring. Tests only. */
export function resetVideoCaptureForTests(): void {
  userDataDir = null
}
