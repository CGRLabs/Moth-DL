/**
 * Moth domain model.
 *
 * This module is the single source of truth for the vocabulary of the whole
 * application. It is imported by the main process, the preload bridge and the
 * renderer, therefore it must stay free of any runtime dependency on Node
 * built-ins or Electron.
 */

/** Identifies a download across every layer of the system. */
export type DownloadId = string

/** Identifies a logical byte range ("piece") of a download. */
export type ChunkId = string

/**
 * Lifecycle of a download.
 *
 * `connecting`   DNS/TLS/probe in flight, size not yet known.
 * `downloading`  at least one chunk is transferring.
 * `paused`       intentionally halted by the user or the scheduler; resumable.
 * `verifying`    all bytes are on disk, checksum is being computed.
 * `scheduled`    queued to auto-start at `scheduledStartAt`.
 */
export type DownloadStatus =
  | 'queued'
  | 'connecting'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'scheduled'
  | 'review'

/** Status of a single piece of the file. */
export type ChunkStatus = 'pending' | 'active' | 'complete'

/** Auto-routing buckets derived from the file extension. */
export type DownloadCategory =
  | 'video'
  | 'audio'
  | 'document'
  | 'archive'
  | 'executable'
  | 'image'
  | 'installer'
  | 'other'

/**
 * UI theme preset.
 *
 * Legacy stored appearance preference. The renderer now uses one fixed Moth
 * Midnight palette; these values remain readable for settings compatibility.
 */
export type ThemePreset = 'graphite' | 'amber' | 'light' | 'system'

/** Custom accent as `#rrggbb`, or `null` to use the preset's own accent. */
export type AccentColor = string | null

/** Hash algorithms Moth can verify. `fast` is a non-cryptographic integrity check. */
export type ChecksumAlgorithm = 'fast' | 'md5' | 'sha1' | 'sha256' | 'sha512'

export type DownloadVerificationResult =
  | {
      outcome: 'verified' | 'mismatch' | 'unverified'
      algorithm: ChecksumAlgorithm
      actual: string
      expected: string | null
    }
  | { outcome: 'unavailable' }

export interface ChecksumSpec {
  algorithm: ChecksumAlgorithm
  /** Lowercase hex digest. */
  value: string
}

/**
 * A requested integrity check. `expected` may be absent when the user did not
 * supply a hash, in which case Moth still records a computed digest so that
 * later runs can detect on-disk corruption.
 */
export interface IntegritySpec {
  algorithm: ChecksumAlgorithm
  expected: string | null
}

/** What the HTTP layer learned while probing a URL. */
export interface RemoteMetadata {
  /** Final URL after redirects. */
  finalUrl: string
  /** Total size in bytes, or `null` when the server does not disclose it. */
  size: number | null
  /** Whether the server advertised `Accept-Ranges: bytes`. */
  acceptRanges: boolean
  etag: string | null
  lastModified: string | null
  /** Content type header, used as a hint when the URL has no file extension. */
  contentType: string | null
  /** Server-suggested filename, parsed from Content-Disposition when present. */
  contentDisposition: string | null
  /** Present when the server refused ranges, e.g. HTTP 200 for a range request. */
  rangeUnsupported: boolean
}

/** An error that carries a stable machine-readable code plus retry semantics. */
export type ErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'HTTP_CLIENT_ERROR'
  | 'HTTP_SERVER_ERROR'
  | 'HTTP_TOO_MANY_REQUESTS'
  | 'RANGE_UNSUPPORTED'
  | 'FILE_IO'
  | 'DISK_FULL'
  | 'CHECKSUM_MISMATCH'
  | 'CANCELED'
  | 'PAUSED'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL'

export interface EngineErrorShape {
  code: ErrorCode
  message: string
  /** Whether the engine is expected to retry automatically. */
  retryable: boolean
  /** HTTP status when the failure came from the network layer. */
  httpStatus?: number
  cause?: string
}

/** Persisted per-download record. Mirrors the `downloads` table. */
export interface Download {
  id: DownloadId
  url: string
  /** URL after redirects; persisted so resume never re-follows a dead hop. */
  finalUrl: string | null
  filename: string
  /** Where bytes are written while in flight. Always suffixed `.mothpart`. */
  tempPath: string
  /** Destination after verification; `null` until the file is finalised. */
  finalPath: string | null
  /** Total size in bytes. `0` means "unknown, discover via range probe". */
  fileSize: number
  acceptRanges: boolean
  etag: string | null
  lastModified: string | null
  contentType: string | null
  category: DownloadCategory
  status: DownloadStatus
  /** Sum of the byte lengths of all completed chunks. */
  downloadedBytes: number
  /** Digest of the whole file, computed incrementally while downloading. */
  expectedChecksum: ChecksumSpec | null
  computedChecksum: string | null
  /** 0 = highest. Drives the scheduler. */
  priority: number
  retryCount: number
  maxRetries: number
  errorCode: ErrorCode | null
  errorMessage: string | null
  /** Per-download throttle in bytes/second; `null` = unlimited. */
  speedLimit: number | null
  /** Per-torrent upload throttle in bytes/second; `null` = unlimited. */
  uploadSpeedLimit?: number | null
  /** Selected torrent file indexes; `null` means all files are wanted. */
  torrentFiles?: number[] | null
  /** Maximum bytes to save for this download; `null` = no quota. */
  quotaBytes: number | null
  /** Epoch millis; the scheduler auto-starts the download at this time. */
  scheduledStartAt: number | null
  /** Number of parallel range connections. `null` = use the global setting. */
  connections: number | null
  headers: Record<string, string>
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
}

/** Persisted piece record. Mirrors the `chunks` table. */
export interface Chunk {
  id: ChunkId
  downloadId: DownloadId
  index: number
  /** Inclusive start offset in the final file. */
  start: number
  /** Inclusive end offset in the final file. */
  end: number
  size: number
  status: ChunkStatus
  /** Bytes durably written for this chunk. `0` when pending. */
  bytesWritten: number
  attempts: number
  lastError: string | null
  /** Digest of the chunk's bytes, recorded on completion. */
  checksum: string | null
  updatedAt: number
}

/** Aggregated view of one chunk's progress while it is being served. */
export interface ChunkProgress {
  chunkId: ChunkId
  bytesWritten: number
  size: number
  /** Instantaneous rate for this chunk, bytes/second. */
  speed: number
}

/** Everything the UI needs to draw a row. */
export interface DownloadSnapshot extends Download {
  /** Current aggregate rate in bytes/second. */
  speed: number
  /** Seconds remaining, or `null` when not computable. */
  eta: number | null
  /** Number of chunks finished / total. */
  chunksComplete: number
  chunksTotal: number
  /** Compact chunk bitmap for the progress bar heat map. */
  chunkBitmap: number[]
  /** Resolved media metadata, when the file has been tagged. */
  metadata?: import('./media.js').MediaMetadataView
  /** Requested media settings while a media-page transfer is pending. */
  mediaRequest?: {
    format: VideoCaptureFormat
    videoQuality: VideoQuality
    audioFormat: AudioOutputFormat
  }
  /** Persisted actual output and full-decode validation for YouTube videos. */
  youtubeVideoOutput?: YouTubeVideoOutput
}

export interface YouTubeVideoOutput {
  requestedQuality: VideoQuality
  width: number | null
  height: number | null
  videoCodec: string | null
  audioCodec: string | null
  validatedAt: number
}

export interface EngineStats {
  activeDownloads: number
  queuedDownloads: number
  completedDownloads: number
  failedDownloads: number
  /** Aggregate rate across every active download, bytes/second. */
  totalSpeed: number
  /** Sum of bytes written this session. */
  sessionBytes: number
  /** Bytes/second cap in force, or `null` when unlimited. */
  globalSpeedLimit: number | null
  uptimeMs: number
}

export type QueuePlanStrategy = 'queue-order' | 'smallest-first'
export type QueuePlanEndAction = 'pause' | 'continue'
export type QueuePlanStatus = 'scheduled' | 'running' | 'completed' | 'canceled'

/** One user-configured, one-off queue run. Times are persisted as epoch milliseconds. */
export interface QueuePlan {
  id: string
  name: string
  downloadIds: DownloadId[]
  startsAt: number
  durationMinutes: number
  strategy: QueuePlanStrategy
  endAction: QueuePlanEndAction
  status: QueuePlanStatus
  createdAt: number
  endedAt: number | null
}

export type CreateQueuePlanRequest = Pick<
  QueuePlan,
  'name' | 'downloadIds' | 'startsAt' | 'durationMinutes' | 'strategy' | 'endAction'
>

export interface AppSettings {
  downloadDirectory: string
  /** Per-category folder names under the download root, or absolute destinations. */
  categoryFolders: Record<DownloadCategory, string>
  autoCategorize: boolean
  globalSpeedLimit: number | null
  /** Hard cap on simultaneous downloads. */
  maxConcurrentDownloads: number
  defaultConnections: number
  /** Size of each piece in bytes. */
  chunkSize: number
  maxRetries: number
  /** Verify the file digest after every download. */
  verifyChecksums: boolean
  autoStartDownloads: boolean
  minimizeToTray: boolean
  closeToTray: boolean
  notificationsEnabled: boolean
  /** Show a desktop notification when one or more downloads complete. */
  notifyOnDownloadComplete: boolean
  theme: ThemePreset
  /** Custom accent override, `#rrggbb`. `null` means the preset default. */
  accentColor: AccentColor
  logLevel: LogLevel
  /** Ask before clearing completed downloads from the list. */
  confirmOnRemove: boolean
  maxSpeedHistoryPoints: number
  /** Accept download requests from the companion browser extension. */
  browserIntegration: boolean
  /** Loopback port the extension posts to. */
  ingestPort: number
  /** Shared secret the extension must present. Generated on first run. */
  ingestToken: string
  /** Watch the download folder for browser downloads to adopt. */
  watchDownloadFolder: boolean
  /** Write resolved tags into the downloaded audio file on completion. */
  writeMediaTags: boolean
  /** Read tags already embedded in a downloaded file. */
  readEmbeddedTags: boolean
  /**
   * Directory that holds download-on-demand helper binaries (resolver +
   * transcoder). Empty means `<userData>/bin`. A non-empty value must be an
   * absolute path; it is contained with `resolveWithin` before use.
   */
  helperDir: string
  /** Pinned resolver version fetched on first use (see `src/main/video/`). */
  ytDlpVersion: string
  /** Pinned transcoder version label fetched on first use. */
  ffmpegVersion: string
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

export interface LogLine {
  timestamp: number
  level: LogLevel
  scope: string
  message: string
  data?: Record<string, unknown>
}

/** One sample of the aggregate transfer rate, for the UI graph. */
export interface SpeedSample {
  /** Epoch millis. */
  t: number
  bytesPerSecond: number
}

/** Per-grab media choice forwarded by the companion extension (absent = video). */
export type VideoCaptureFormat = 'video' | 'audio'
export type VideoQuality = 360 | 480 | 720 | 1080 | 1440 | 2160
export type AudioOutputFormat = 'source' | 'mp3'

export interface MediaSubtitleTrack {
  language: string
  url: string
  extension: 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml'
  automatic: boolean
  headers: Record<string, string>
}

export interface AddDownloadRequest {
  url: string
  filename?: string
  category?: DownloadCategory
  destination?: string
  expectedChecksum?: string
  checksumAlgorithm?: ChecksumAlgorithm
  speedLimit?: number | null
  uploadSpeedLimit?: number | null
  /** Selected Transmission file indexes; omitted means all files. */
  torrentFiles?: number[] | null
  /** Base64 metainfo returned by the native .torrent file picker. */
  torrentMetainfo?: string
  scheduledStartAt?: number | null
  connections?: number
  headers?: Record<string, string>
  /**
   * Requested media shape for page-URL grabs. When present, the engine
   * resolves the page to a direct file URL first and then runs the normal
   * chunk pipeline on it. Audio pages default to MP3 for compatibility;
   * source format can be requested to avoid lossy conversion. Absent behaves
   * exactly as before (legacy direct file fetch).
   */
  format?: VideoCaptureFormat
  /**
   * How the caller already classified the source, including an explicit
   * override from the dialog's "send as a direct file instead" escape. Absent
   * means the engine decides from the URL and, when the URL text is
   * ambiguous, from the server's own response.
   */
  sourceKind?: 'direct' | 'page'
  /** Maximum video height requested for media-page captures. Defaults to 720p. */
  videoQuality?: VideoQuality
  /** Audio output choice for audio-page grabs. Defaults to MP3. */
  audioFormat?: AudioOutputFormat
  /** Optional subtitle languages to save as sidecar files (for example ["en"]). */
  subtitleLanguages?: string[]
  /** Optional filename pattern. Supported fields are {title}, {id}, {host}, {ext}. */
  namingTemplate?: string
  /** When false, read metadata but do not write embedded tags or fetch artwork. */
  embedMetadata?: boolean
}

export interface AddDownloadResult {
  id: DownloadId
  /** Resolved as soon as the URL has been probed; useful for immediate UI feedback. */
  filename: string
  fileSize: number
  acceptRanges: boolean
}

export interface TorrentFileView {
  index: number
  name: string
  size: number
  downloaded: number
  wanted: boolean
  priority: number
}

/** What the app thinks a pasted URL is, before any download starts. */
export type PreviewKind = 'direct' | 'page' | 'torrent'

export interface PreviewDownloadRequest {
  url: string
}

export interface MediaPlaylistEntry {
  id: string
  sourceKey: string | null
  title: string
  url: string
  thumbnailUrl?: string | null
  durationSeconds: number | null
  alreadyDownloaded: boolean
}

export interface MediaPlaylistPreview {
  title: string
  entries: MediaPlaylistEntry[]
  truncated: boolean
}

export interface DuplicateMediaResult {
  duplicate: boolean
  title: string | null
  filename: string | null
}

export interface PreviewDownloadResult {
  kind: PreviewKind
  /** Final URL after redirects (equals the input when no redirect happened). */
  finalUrl: string
  /** Host of the final URL, for the "from youtube.com" line. */
  host: string
  /** Suggested filename (page title is unknown here — direct files only). */
  filename: string
  /** Total size in bytes, or `null` when the server does not disclose it. */
  fileSize: number | null
  contentType: string | null
  acceptRanges: boolean
  /** Whether a direct HTTP source can be resumed without mixing versions. */
  resumeSupport: 'safe' | 'restart' | 'unknown'
  category: DownloadCategory
  /**
   * True when the probe failed or disclosed nothing: the dialog still lets
   * the user queue the URL, it just says so honestly instead of guessing.
   */
  undetermined: boolean
}

export interface SystemPaths {
  userData: string
  downloads: string
  logs: string
  database: string
}
