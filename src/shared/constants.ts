import type { AppSettings, DownloadCategory } from './types.js'

/** Suffix used for the in-flight partial file. */
export const PARTIAL_SUFFIX = '.mothpart'

/** Every partial file in one directory belongs to one download; a UUID isolates them. */
export const PARTIAL_DIR_NAME = '.moth'

export const DB_FILE_NAME = 'moth.db'
export const LOG_DIR_NAME = 'logs'
export const LOG_FILE_NAME = 'moth.log'
export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const LOG_MAX_FILES = 5

/** Below this a file is treated as "tiny" and fetched with a single connection. */
export const MIN_CHUNK_SIZE = 64 * 1024
export const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024
export const MAX_CONNECTIONS = 32

/** Speed samples are emitted on this cadence. */
export const TELEMETRY_INTERVAL_MS = 500
export const SPEED_SAMPLE_WINDOW_MS = 60_000

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MothDownloader/1.0'

export const REQUEST_TIMEOUT_MS = 30_000
export const CONNECT_TIMEOUT_MS = 15_000
export const IDLE_SOCKET_TIMEOUT_MS = 20_000

export const DEFAULT_CATEGORY_FOLDERS: Record<DownloadCategory, string> = {
  video: 'Video',
  audio: 'Music',
  document: 'Documents',
  archive: 'Archives',
  executable: 'Executables',
  image: 'Images',
  installer: 'Installers',
  other: 'Other'
}

/** Extension -> category. Longest-suffix wins; see `categorizer.ts`. */
export const CATEGORY_EXTENSIONS: Record<DownloadCategory, readonly string[]> = {
  video: [
    'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg',
    'ts', 'm2ts', 'vob', 'ogv', '3gp', 'rmvb'
  ],
  audio: [
    'mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff', 'alac', 'dsf', 'ape'
  ],
  document: [
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
    'txt', 'rtf', 'md', 'epub', 'mobi', 'csv', 'djvu', 'tex'
  ],
  archive: [
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso', 'cab', 'lz', 'lzma', 'tgz', 'dmg'
  ],
  executable: ['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'appimage', 'deb', 'rpm', 'apk'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tiff', 'tif', 'ico', 'avif', 'heic'],
  installer: ['msix', 'msixbundle', 'appx', 'appxbundle', 'pkg', 'msu', 'run', 'img'],
  other: []
}

export const HELPER_BIN_DIR_NAME = 'bin'

/** Pinned resolver version. Bump together with the asset URLs in `src/main/video/constants.ts`. */
export const DEFAULT_YT_DLP_VERSION = '2026.08.19'

/**
 * Pinned transcoder version label. The Windows/macOS vendors do not embed a
 * stable version in every download URL, so this label documents which build
 * was last verified; bump it when the vendor URLs are re-verified.
 */
export const DEFAULT_FFMPEG_VERSION = '7.1'

/** Slice 1 cap: never pick a video stream taller than this. No merge logic yet. */
export const VIDEO_MAX_HEIGHT = 720

/** Default MP3 encode quality: VBR q2 (~190 kbps). */
export const MP3_VBR_QUALITY = '2'

export const DEFAULT_SETTINGS: AppSettings = {
  downloadDirectory: '',
  categoryFolders: { ...DEFAULT_CATEGORY_FOLDERS },
  autoCategorize: true,
  globalSpeedLimit: null,
  maxConcurrentDownloads: 3,
  defaultConnections: 8,
  chunkSize: DEFAULT_CHUNK_SIZE,
  maxRetries: 5,
  verifyChecksums: true,
  autoStartDownloads: true,
  minimizeToTray: true,
  closeToTray: false,
  notificationsEnabled: true,
  notifyOnDownloadComplete: true,
  theme: 'graphite',
  accentColor: null,
  logLevel: 'info',
  confirmOnRemove: true,
  maxSpeedHistoryPoints: 120,
  browserIntegration: true,
  ingestPort: 24678,
  // Replaced with real CSPRNG output on first run; see ensureIngestToken.
  ingestToken: '',
  watchDownloadFolder: false,
  writeMediaTags: true,
  readEmbeddedTags: true,
  helperDir: '',
  ytDlpVersion: DEFAULT_YT_DLP_VERSION,
  ffmpegVersion: DEFAULT_FFMPEG_VERSION
}
