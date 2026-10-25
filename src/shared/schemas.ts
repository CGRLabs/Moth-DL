/**
 * Runtime validation for everything crossing the IPC boundary.
 *
 * The renderer is treated as untrusted input: a compromised or buggy renderer
 * must never be able to hand the main process a malformed path, a negative
 * byte count, or an unbounded header map. Handlers parse with these schemas
 * before touching the filesystem or the database.
 */

import { z } from 'zod'
import { CATEGORY_EXTENSIONS } from './constants.js'
import { MAX_CHUNK_SIZE, MIN_CHUNK_SIZE, MAX_CONNECTIONS } from './constants.js'
import { isImportedTorrentFileUri, parseMagnetUri } from './torrent.js'

const CATEGORY_KEYS = Object.keys(CATEGORY_EXTENSIONS) as [
  'video',
  'audio',
  'document',
  'archive',
  'executable',
  'image',
  'installer',
  'other'
]

export const downloadIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)
export const diagnosticReportSaveSchema = z.object({
  id: z.string().uuid(),
  reviewed: z.literal(true)
})
export const diagnosticReportIdSchema = z.object({ id: z.string().uuid() })

export const checksumAlgorithmSchema = z.enum(['fast', 'md5', 'sha1', 'sha256', 'sha512'])

export const categorySchema = z.enum([
  'video',
  'audio',
  'document',
  'archive',
  'executable',
  'image',
  'installer',
  'other'
])

export const downloadStatusSchema = z.enum([
  'queued',
  'connecting',
  'downloading',
  'paused',
  'verifying',
  'completed',
  'failed',
  'canceled',
  'scheduled'
])

/**
 * Per-grab media choice. Absent means video (backward compatible); an
 * invalid value is a 400, never a silent default.
 */
export const videoFormatSchema = z.enum(['video', 'audio'])
export const videoQualitySchema = z.union([
  z.literal(360),
  z.literal(480),
  z.literal(720),
  z.literal(1080),
  z.literal(1440),
  z.literal(2160)
])
export const audioOutputFormatSchema = z.enum(['source', 'mp3'])
export const subtitleLanguagesSchema = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{1,35}$/))
  .max(8)
  .optional()
export const mediaNamingTemplateSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((template) => !/[\\/]/.test(template), 'Naming templates cannot contain path separators')
  .refine((template) => !/[{}]/.test(template.replace(/\{(?:title|id|host|ext)\}/g, '')), 'Naming templates contain an invalid token')
  .refine(
    (template) => [...template.matchAll(/\{([^{}]+)\}/g)].every((match) => ['title', 'id', 'host', 'ext'].includes(match[1] ?? '')),
    'Naming templates support only {title}, {id}, {host}, and {ext}'
  )

export const themeSchema = z.enum(['graphite', 'amber', 'light', 'system'])

/** A custom accent from the native color input: always `#rrggbb`. */
export const accentColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Accent must be a #rrggbb hex color')
  .nullable()
export const httpUrlSchema = z
  .string()
  .min(8)
  .max(4096)
  .url()
  .refine((value) => {
    // Zod runs refinements even when an earlier check on the same string has
    // already failed, so `value` is not guaranteed to be parseable here.
    // Unguarded, `new URL()` would throw out of `safeParse` and take down
    // the IPC handler for any malformed input.
    try {
      const protocol = new URL(value).protocol
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  }, 'Only http and https URLs are supported')

export const torrentMagnetSchema = z.string().min(20).max(4096).refine(
  (value) => parseMagnetUri(value) !== null,
  'A valid BitTorrent v1 or v2 magnet link is required'
)

const importedTorrentFileUriSchema = z.string().regex(/^moth-torrent-file:[a-f\d]{64}$/i)
const torrentMetainfoSchema = z.string().max(11_184_812).regex(/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/)

/** Conservative header allow-list; hop-by-hop and length-bearing headers are dropped. */
export const headerMapSchema = z
  .record(z.string().max(256), z.string().max(2048))
  .default({})
  .transform((headers) => {
    const blocked = new Set([
      'host',
      'content-length',
      'connection',
      'transfer-encoding',
      'upgrade',
      'range',
      'if-range',
      'proxy-authorization',
      'proxy-authenticate',
      'te',
      'trailer',
      'expect'
    ])
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      if (!blocked.has(key.toLowerCase())) out[key] = value
    }
    return out
  })

/** Rejects traversal, absolute roots, reserved Windows device names and control chars. */
export const filenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('/') && !name.includes('\\'), 'Filename must not contain path separators')
  .refine((name) => !name.includes('..'), 'Filename must not contain parent references')
  .refine((name) => !/[\x00-\x1f<>:"|?*]/.test(name), 'Filename contains illegal characters')
  .refine((name) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name), 'Reserved device name')
  .refine((name) => !/^\.+$/.test(name), 'Filename must not be dots only')
  .refine((name) => !name.endsWith('.'), 'Filename must not end with a dot')

export const bytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const bytesPerSecondSchema = z.number().int().nonnegative().max(1024 * 1024 * 1024 * 1024)
export const epochSchema = z.number().int().nonnegative().max(8.64e15)

export const connectionsSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_CONNECTIONS)

export const chunkSizeSchema = z
  .number()
  .int()
  .min(MIN_CHUNK_SIZE)
  .max(MAX_CHUNK_SIZE)

export const addDownloadSchema = z.object({
  url: z.union([httpUrlSchema, torrentMagnetSchema, importedTorrentFileUriSchema]),
  filename: filenameSchema.optional(),
  category: categorySchema.optional(),
  destination: z.string().min(1).max(4096).optional(),
  expectedChecksum: z
    .string()
    .regex(/^[a-fA-F0-9]{8,128}$/, 'Checksum must be a hex digest')
    .optional(),
  checksumAlgorithm: checksumAlgorithmSchema.optional(),
  speedLimit: bytesPerSecondSchema.nullable().optional(),
  uploadSpeedLimit: bytesPerSecondSchema.nullable().optional(),
  torrentFiles: z.array(z.number().int().nonnegative().max(100_000)).max(100_000)
    .refine((files) => new Set(files).size === files.length, 'Torrent file indexes must be unique')
    .nullable().optional(),
  torrentMetainfo: torrentMetainfoSchema.optional(),
  scheduledStartAt: epochSchema.nullable().optional(),
  connections: connectionsSchema.optional(),
  headers: headerMapSchema.optional(),
  format: videoFormatSchema.optional(),
  sourceKind: z.enum(['direct', 'page']).optional(),
  videoQuality: videoQualitySchema.optional(),
  audioFormat: audioOutputFormatSchema.optional(),
  subtitleLanguages: subtitleLanguagesSchema,
  namingTemplate: mediaNamingTemplateSchema.optional(),
  embedMetadata: z.boolean().optional()
}).superRefine((request, context) => {
  const importedFile = isImportedTorrentFileUri(request.url)
  if (importedFile !== (request.torrentMetainfo !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['torrentMetainfo'],
      message: 'A selected .torrent file requires its validated file data'
    })
  }
})

/**
 * What the companion extension POSTs to the loopback ingest endpoint.
 * `format` is optional for backward compatibility: absent means video.
 * Generic wording throughout — no site names in user-visible strings.
 */
export const ingestRequestSchema = z.object({
  url: httpUrlSchema,
  filename: filenameSchema.optional(),
  referer: z.string().min(1).max(2048).optional(),
  cookies: z.string().min(1).max(8192).optional(),
  userAgent: z.string().min(1).max(512).optional(),
  autoStart: z.boolean().optional(),
  format: videoFormatSchema.optional(),
  videoQuality: videoQualitySchema.optional(),
  audioFormat: audioOutputFormatSchema.optional(),
  subtitleLanguages: subtitleLanguagesSchema
})

export const previewDownloadSchema = z.object({ url: httpUrlSchema })
export const playlistThumbnailSchema = z.object({
  url: z.string().url().max(2048).refine((value) => {
    try {
      const parsed = new URL(value)
      const host = parsed.hostname.toLowerCase()
      return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password &&
        (host === 'ytimg.com' || host.endsWith('.ytimg.com') ||
          host === 'ggpht.com' || host.endsWith('.ggpht.com') ||
          host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com'))
    } catch {
      return false
    }
  }, 'Playlist thumbnails must use a trusted HTTPS image host')
})
export const refreshDownloadUrlSchema = z.object({
  id: downloadIdSchema,
  url: httpUrlSchema
})

export const idOnlySchema = z.object({ id: downloadIdSchema })

export const configureReviewSchema = z.object({
  id: downloadIdSchema,
  request: addDownloadSchema
})

export const removeDownloadSchema = z.object({
  id: downloadIdSchema,
  deleteFile: z.boolean().default(false)
})

export const setPrioritySchema = z.object({
  id: downloadIdSchema,
  priority: z.number().int().min(0).max(1000)
})

export const setSpeedLimitSchema = z.object({
  id: downloadIdSchema,
  speedLimit: bytesPerSecondSchema.nullable()
})

export const setUploadSpeedLimitSchema = z.object({
  id: downloadIdSchema,
  speedLimit: bytesPerSecondSchema.nullable()
})

export const setTorrentFilesSchema = z.object({
  id: downloadIdSchema,
  indexes: z.array(z.number().int().nonnegative().max(100_000)).min(1).max(100_000)
    .refine((files) => new Set(files).size === files.length, 'Torrent file indexes must be unique')
})

export const setDownloadQuotaSchema = z.object({
  id: downloadIdSchema,
  quotaBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable()
})

/**
 * A manual metadata edit.
 *
 * Every field is optional and nullable: omitting a field leaves it alone, while
 * an explicit null clears it. That distinction is what lets the user remove a
 * wrong title without having to retype the correct one.
 */
export const setMediaMetadataSchema = z.object({
  id: downloadIdSchema,
  patch: z
    .object({
      title: z.string().max(512).nullable(),
      artist: z.string().max(512).nullable(),
      albumArtist: z.string().max(512).nullable(),
      album: z.string().max(512).nullable(),
      track: z.number().int().min(1).max(9999).nullable(),
      disc: z.number().int().min(1).max(9999).nullable(),
      year: z.number().int().min(0).max(3000).nullable(),
      genre: z.string().max(512).nullable()
    })
    .partial()
})

export const setStatusSchema = z.object({
  id: downloadIdSchema,
  status: downloadStatusSchema
})

export const createQueuePlanSchema = z.object({
  name: z.string().trim().min(1).max(80),
  downloadIds: z.array(downloadIdSchema).min(1).max(2000).refine(
    (ids) => new Set(ids).size === ids.length,
    'A download can appear only once in a plan'
  ),
  startsAt: epochSchema,
  durationMinutes: z.number().int().min(1).max(43_200),
  strategy: z.enum(['queue-order', 'smallest-first']),
  endAction: z.enum(['pause', 'continue'])
})

export const queuePlanIdSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)
})

export const reorderSchema = z.object({
  orderedIds: z.array(downloadIdSchema).max(10_000)
})

export const rescanSchema = z.object({
  id: downloadIdSchema.optional()
})

export const selectDirectorySchema = z.object({
  title: z.string().max(200).optional()
})

export const extensionBrowserSchema = z.enum(['chrome', 'edge', 'brave'])

export const installExtensionSchema = z.object({
  browsers: z.array(extensionBrowserSchema).max(3).optional()
})

export const windowActionSchema = z.object({
  action: z.enum(['minimize', 'maximize', 'restore', 'close', 'hide'])
})

export const settingsPatchSchema = z
  .object({
    downloadDirectory: z.string().min(1).max(4096),
    categoryFolders: z.record(categorySchema, z.string().min(1).max(4096)),
    autoCategorize: z.boolean(),
    globalSpeedLimit: bytesPerSecondSchema.nullable(),
    maxConcurrentDownloads: z.number().int().min(1).max(MAX_CONNECTIONS),
    defaultConnections: connectionsSchema,
    chunkSize: chunkSizeSchema,
    maxRetries: z.number().int().min(0).max(50),
    verifyChecksums: z.boolean(),
    autoStartDownloads: z.boolean(),
    minimizeToTray: z.boolean(),
    closeToTray: z.boolean(),
    notificationsEnabled: z.boolean(),
    notifyOnDownloadComplete: z.boolean(),
    theme: themeSchema,
    accentColor: accentColorSchema,
    logLevel: z.enum(['error', 'warn', 'info', 'debug', 'trace']),
    confirmOnRemove: z.boolean(),
    maxSpeedHistoryPoints: z.number().int().min(10).max(5000),
    browserIntegration: z.boolean(),
    ingestPort: z.number().int().min(1024).max(65535),
    // A 64-character hex token; the schema must never widen this.
    ingestToken: z.string().regex(/^[a-f0-9]{64}$/i, 'Ingest token must be 64 hex characters'),
    watchDownloadFolder: z.boolean(),
    writeMediaTags: z.boolean(),
    readEmbeddedTags: z.boolean(),
    helperDir: z.string().min(1).max(4096),
    ytDlpVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w.\-]+$/, 'Version must be a plain version label'),
    ffmpegVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w.\-]+$/, 'Version must be a plain version label')
  })
  .partial()

export type AddDownloadInput = z.infer<typeof addDownloadSchema>
export type SettingsPatch = z.infer<typeof settingsPatchSchema>
export type IngestRequestInput = z.infer<typeof ingestRequestSchema>

export const CATEGORIES: readonly (typeof CATEGORY_KEYS)[number][] = CATEGORY_KEYS

/** Parses `input` with `schema`, returning a plain error message on failure. */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid ${label} - ${detail}`)
  }
  return result.data
}
