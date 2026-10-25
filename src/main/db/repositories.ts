/**
 * Repositories: the only place that knows SQL, and the only place that maps
 * between SQLite rows and domain objects.
 *
 * Mapping is defensive on purpose. A database file that was truncated, edited
 * by hand, or written by a future version must not be able to produce a
 * half-populated `Download` that crashes the engine — every column is coerced
 * to its declared type with an explicit fallback.
 */

import type {
  Chunk,
  ChecksumAlgorithm,
  ChecksumSpec,
  Download,
  DownloadCategory,
  DownloadId,
  DownloadStatus,
  ErrorCode,
  QueuePlan,
  QueuePlanEndAction,
  QueuePlanStatus,
  QueuePlanStrategy,
  YouTubeVideoOutput,
  VideoQuality
} from '@shared/types.js'
import type { Database, Row, SqlValue } from './driver.js'
import { getLogger } from '../util/logger.js'
import { MediaRepository } from './mediaRepository.js'

const log = getLogger('db.repo')

// --- defensive coercion ----------------------------------------------------

const str = (value: SqlValue | undefined, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const num = (value: SqlValue | undefined, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const numOrNull = (value: SqlValue | undefined): number | null => {
  if (value === null || value === undefined) return null
  const parsed = num(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : null
}

const strOrNull = (value: SqlValue | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const bool = (value: SqlValue | undefined): boolean => num(value, 0) !== 0

const VALID_STATUSES: ReadonlySet<string> = new Set<DownloadStatus>([
  'queued',
  'connecting',
  'downloading',
  'paused',
  'verifying',
  'completed',
  'failed',
  'canceled',
  'scheduled',
  'review'
])

const VALID_CATEGORIES: ReadonlySet<string> = new Set<DownloadCategory>([
  'video',
  'audio',
  'document',
  'archive',
  'executable',
  'image',
  'installer',
  'other'
])

const VALID_ALGORITHMS: ReadonlySet<string> = new Set<ChecksumAlgorithm>([
  'fast',
  'md5',
  'sha1',
  'sha256',
  'sha512'
])

const parseHeaders = (raw: SqlValue | undefined): Record<string, string> => {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value
      }
      return out
    }
  } catch {
    log.warn('Corrupt headers JSON; falling back to empty map')
  }
  return {}
}

const parseTorrentFiles = (raw: SqlValue | undefined): number[] | null => {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      Array.isArray(parsed) &&
      parsed.every((value) => Number.isSafeInteger(value) && value >= 0) &&
      new Set(parsed).size === parsed.length
    ) return parsed
  } catch {
    log.warn('Corrupt torrent file selection JSON; using all files')
    return null
  }
  log.warn('Malformed torrent file selection JSON; using all files')
  return null
}

export function rowToDownload(row: Row): Download {
  const status = str(row.status, 'queued')
  const category = str(row.category, 'other')
  const algorithm = strOrNull(row.expected_algorithm)
  const expectedChecksum = strOrNull(row.expected_checksum)

  return {
    id: str(row.id),
    url: str(row.url),
    finalUrl: strOrNull(row.final_url),
    filename: str(row.filename, 'download'),
    tempPath: str(row.temp_path),
    finalPath: strOrNull(row.final_path),
    fileSize: num(row.file_size, 0),
    acceptRanges: bool(row.accept_ranges),
    etag: strOrNull(row.etag),
    lastModified: strOrNull(row.last_modified),
    contentType: strOrNull(row.content_type),
    category: (VALID_CATEGORIES.has(category) ? category : 'other') as DownloadCategory,
    status: (VALID_STATUSES.has(status) ? status : 'queued') as DownloadStatus,
    downloadedBytes: num(row.downloaded_bytes, 0),
    expectedChecksum:
      expectedChecksum && algorithm && VALID_ALGORITHMS.has(algorithm)
        ? { algorithm: algorithm as ChecksumAlgorithm, value: expectedChecksum }
        : null,
    computedChecksum: strOrNull(row.computed_checksum),
    priority: num(row.priority, 0),
    retryCount: num(row.retry_count, 0),
    maxRetries: num(row.max_retries, 5),
    errorCode: strOrNull(row.error_code) as ErrorCode | null,
    errorMessage: strOrNull(row.error_message),
    speedLimit: numOrNull(row.speed_limit),
    uploadSpeedLimit: numOrNull(row.upload_speed_limit),
    torrentFiles: parseTorrentFiles(row.torrent_files),
    quotaBytes: numOrNull(row.quota_bytes),
    scheduledStartAt: numOrNull(row.scheduled_start_at),
    connections: numOrNull(row.connections),
    headers: parseHeaders(row.headers),
    createdAt: num(row.created_at, 0),
    updatedAt: num(row.updated_at, 0),
    startedAt: numOrNull(row.started_at),
    completedAt: numOrNull(row.completed_at)
  }
}

export function rowToChunk(row: Row): Chunk {
  const status = str(row.status, 'pending')
  return {
    id: str(row.id),
    downloadId: str(row.download_id),
    index: num(row.idx, 0),
    start: num(row.start_byte, 0),
    end: num(row.end_byte, 0),
    size: num(row.size, 0),
    status: (status === 'active' || status === 'complete' ? status : 'pending') as Chunk['status'],
    bytesWritten: num(row.bytes_written, 0),
    attempts: num(row.attempts, 0),
    lastError: strOrNull(row.last_error),
    checksum: strOrNull(row.checksum),
    updatedAt: num(row.updated_at, 0)
  } as Chunk
}

// --- downloads --------------------------------------------------------------

/**
 * Column list as an array, so the placeholder string can be *derived* from it.
 * Hand-counting `?` markers is exactly the kind of thing that silently breaks
 * when a column is added.
 */
const DOWNLOAD_COLUMN_LIST = [
  'id', 'url', 'final_url', 'filename', 'temp_path', 'final_path', 'file_size',
  'accept_ranges', 'etag', 'last_modified', 'content_type', 'category', 'status',
  'downloaded_bytes', 'expected_algorithm', 'expected_checksum', 'computed_checksum',
  'priority', 'retry_count', 'max_retries', 'error_code', 'error_message',
  'speed_limit', 'upload_speed_limit', 'torrent_files', 'quota_bytes',
  'scheduled_start_at', 'connections', 'headers', 'created_at',
  'updated_at', 'started_at', 'completed_at'
] as const

const DOWNLOAD_COLUMNS = DOWNLOAD_COLUMN_LIST.join(', ')
const DOWNLOAD_PLACEHOLDERS = DOWNLOAD_COLUMN_LIST.map(() => '?').join(',')

export class DownloadRepository {
  constructor(private readonly db: Database) {}

  insert(download: Download): void {
    this.db.run(
      `INSERT INTO downloads (${DOWNLOAD_COLUMNS}) VALUES (${DOWNLOAD_PLACEHOLDERS})`,
      ...toParams(download)
    )
  }

  /** Full-row upsert. Used by recovery when it rebuilds state. */
  upsert(download: Download): void {
    this.db.run(
      `INSERT INTO downloads (${DOWNLOAD_COLUMNS})
       VALUES (${DOWNLOAD_PLACEHOLDERS})
       ON CONFLICT(id) DO UPDATE SET
         url=excluded.url, final_url=excluded.final_url, filename=excluded.filename,
         temp_path=excluded.temp_path, final_path=excluded.final_path,
         file_size=excluded.file_size, accept_ranges=excluded.accept_ranges,
         etag=excluded.etag, last_modified=excluded.last_modified,
         content_type=excluded.content_type, category=excluded.category,
         status=excluded.status, downloaded_bytes=excluded.downloaded_bytes,
         expected_algorithm=excluded.expected_algorithm,
         expected_checksum=excluded.expected_checksum,
         computed_checksum=excluded.computed_checksum, priority=excluded.priority,
         retry_count=excluded.retry_count, max_retries=excluded.max_retries,
         error_code=excluded.error_code, error_message=excluded.error_message,
         speed_limit=excluded.speed_limit,
         upload_speed_limit=excluded.upload_speed_limit,
         torrent_files=excluded.torrent_files,
         quota_bytes=excluded.quota_bytes,
         scheduled_start_at=excluded.scheduled_start_at,
         connections=excluded.connections, headers=excluded.headers,
         updated_at=excluded.updated_at, started_at=excluded.started_at,
         completed_at=excluded.completed_at`,
      ...toParams(download)
    )
  }

  get(id: DownloadId): Download | null {
    const row = this.db.get<Row>(`SELECT ${DOWNLOAD_COLUMNS} FROM downloads WHERE id = ?`, id)
    return row ? rowToDownload(row) : null
  }

  list(): Download[] {
    return this.db
      .all<Row>(
        `SELECT ${DOWNLOAD_COLUMNS} FROM downloads
         ORDER BY priority ASC, created_at ASC, id ASC`
      )
      .map(rowToDownload)
  }

  listByStatus(statuses: readonly DownloadStatus[]): Download[] {
    if (statuses.length === 0) return []
    const placeholders = statuses.map(() => '?').join(',')
    return this.db
      .all<Row>(
        `SELECT ${DOWNLOAD_COLUMNS} FROM downloads
         WHERE status IN (${placeholders})
         ORDER BY priority ASC, created_at ASC, id ASC`,
        ...statuses
      )
      .map(rowToDownload)
  }

  update(id: DownloadId, patch: Partial<Download>): void {
    const entries = Object.entries(patch).filter(([key]) => key !== 'id')
    if (entries.length === 0) return

    const setters: string[] = []
    const params: SqlValue[] = []
    for (const [key, value] of entries) {
      // `expectedChecksum` is a domain object spread over two columns.
      if (key === 'expectedChecksum') {
        const spec = value as ChecksumSpec | null | undefined
        setters.push('expected_algorithm = ?', 'expected_checksum = ?')
        params.push(spec?.algorithm ?? null, spec?.value ?? null)
        continue
      }
      setters.push(`${toColumnName(key)} = ?`)
      params.push(toColumnValue(key, value))
    }
    setters.push('updated_at = ?')
    params.push(Date.now())
    params.push(id)

    this.db.run(`UPDATE downloads SET ${setters.join(', ')} WHERE id = ?`, ...params)
  }

  remove(id: DownloadId): void {
    // chunks cascade via the foreign key
    this.db.run('DELETE FROM downloads WHERE id = ?', id)
    this.db.run('DELETE FROM activity WHERE download_id = ?', id)
  }

  removeMany(ids: readonly DownloadId[]): DownloadId[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    this.db.transaction(() => {
      this.db.run(`DELETE FROM activity WHERE download_id IN (${placeholders})`, ...ids)
      this.db.run(`DELETE FROM downloads WHERE id IN (${placeholders})`, ...ids)
    })
    return [...ids]
  }

  /** Applies the priority implied by a drag-and-drop reorder. */
  applyOrder(orderedIds: readonly DownloadId[]): void {
    this.db.transaction(() => {
      const now = Date.now()
      for (let index = 0; index < orderedIds.length; index += 1) {
        const id = orderedIds[index] as DownloadId
        this.db.run(
          'UPDATE downloads SET priority = ?, updated_at = ? WHERE id = ?',
          index,
          now,
          id
        )
      }
    })
  }

  countByStatus(statuses: readonly DownloadStatus[]): number {
    if (statuses.length === 0) return 0
    const placeholders = statuses.map(() => '?').join(',')
    return this.db.count(
      `SELECT COUNT(*) AS n FROM downloads WHERE status IN (${placeholders})`,
      ...statuses
    )
  }

  totalDownloadedBytes(): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COALESCE(SUM(downloaded_bytes), 0) AS n FROM downloads WHERE status = 'completed'"
    )
    return num(row?.n, 0)
  }
}

function toColumnName(key: string): string {
  switch (key) {
    case 'finalUrl':
      return 'final_url'
    case 'tempPath':
      return 'temp_path'
    case 'finalPath':
      return 'final_path'
    case 'fileSize':
      return 'file_size'
    case 'acceptRanges':
      return 'accept_ranges'
    case 'lastModified':
      return 'last_modified'
    case 'contentType':
      return 'content_type'
    case 'downloadedBytes':
      return 'downloaded_bytes'
    case 'expectedChecksum':
      return 'expected_checksum'
    case 'computedChecksum':
      return 'computed_checksum'
    case 'retryCount':
      return 'retry_count'
    case 'maxRetries':
      return 'max_retries'
    case 'errorCode':
      return 'error_code'
    case 'errorMessage':
      return 'error_message'
    case 'speedLimit':
      return 'speed_limit'
    case 'uploadSpeedLimit':
      return 'upload_speed_limit'
    case 'torrentFiles':
      return 'torrent_files'
    case 'quotaBytes':
      return 'quota_bytes'
    case 'scheduledStartAt':
      return 'scheduled_start_at'
    case 'createdAt':
      return 'created_at'
    case 'updatedAt':
      return 'updated_at'
    case 'startedAt':
      return 'started_at'
    case 'completedAt':
      return 'completed_at'
    default:
      return key
  }
}

function toColumnValue(key: string, value: unknown): SqlValue {
  if (key === 'headers' || key === 'torrentFiles') return value === null ? null : JSON.stringify(value ?? {})
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'string') return value
  return JSON.stringify(value)
}

function toParams(download: Download): SqlValue[] {
  // Order must match the column list in DOWNLOAD_COLUMNS.
  return [
    download.id,
    download.url,
    download.finalUrl,
    download.filename,
    download.tempPath,
    download.finalPath,
    download.fileSize,
    download.acceptRanges ? 1 : 0,
    download.etag,
    download.lastModified,
    download.contentType,
    download.category,
    download.status,
    download.downloadedBytes,
    download.expectedChecksum?.algorithm ?? null,
    download.expectedChecksum?.value ?? null,
    download.computedChecksum,
    download.priority,
    download.retryCount,
    download.maxRetries,
    download.errorCode,
    download.errorMessage,
    download.speedLimit,
    download.uploadSpeedLimit ?? null,
    download.torrentFiles == null ? null : JSON.stringify(download.torrentFiles),
    download.quotaBytes,
    download.scheduledStartAt,
    download.connections,
    JSON.stringify(download.headers ?? {}),
    download.createdAt,
    download.updatedAt,
    download.startedAt,
    download.completedAt
  ]
}

// --- chunks -----------------------------------------------------------------

const CHUNK_COLUMN_LIST = [
  'id', 'download_id', 'idx', 'start_byte', 'end_byte', 'size', 'status',
  'bytes_written', 'attempts', 'last_error', 'checksum', 'updated_at'
] as const

const CHUNK_COLUMNS = CHUNK_COLUMN_LIST.join(', ')
const CHUNK_PLACEHOLDERS = CHUNK_COLUMN_LIST.map(() => '?').join(',')

export class ChunkRepository {
  constructor(private readonly db: Database) {}

  /** Wholesale replacement of a download's chunk map. */
  replaceAll(downloadId: DownloadId, chunks: readonly Chunk[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM chunks WHERE download_id = ?', downloadId)
      for (const chunk of chunks) this.insert(chunk)
    })
  }

  insert(chunk: Chunk): void {
    this.db.run(
      `INSERT INTO chunks (${CHUNK_COLUMNS})
       VALUES (${CHUNK_PLACEHOLDERS})
       ON CONFLICT(download_id, idx) DO UPDATE SET
         start_byte=excluded.start_byte, end_byte=excluded.end_byte,
         size=excluded.size, status=excluded.status,
         bytes_written=excluded.bytes_written, updated_at=excluded.updated_at`,
      chunk.id,
      chunk.downloadId,
      chunk.index,
      chunk.start,
      chunk.end,
      chunk.size,
      chunk.status,
      chunk.bytesWritten,
      chunk.attempts,
      chunk.lastError,
      chunk.checksum,
      chunk.updatedAt
    )
  }

  listByDownload(downloadId: DownloadId): Chunk[] {
    return this.db
      .all<Row>(
        `SELECT ${CHUNK_COLUMNS} FROM chunks WHERE download_id = ? ORDER BY idx ASC`,
        downloadId
      )
      .map(rowToChunk)
  }

  /**
   * Fetches only the chunks that still need work.
   * The engine calls this on every resume and after every recovery pass.
   */
  listPending(downloadId: DownloadId): Chunk[] {
    return this.db
      .all<Row>(
        `SELECT ${CHUNK_COLUMNS} FROM chunks
         WHERE download_id = ? AND status != 'complete'
         ORDER BY idx ASC`,
        downloadId
      )
      .map(rowToChunk)
  }

  listComplete(downloadId: DownloadId): Chunk[] {
    return this.db
      .all<Row>(
        `SELECT ${CHUNK_COLUMNS} FROM chunks
         WHERE download_id = ? AND status = 'complete'
         ORDER BY idx ASC`,
        downloadId
      )
      .map(rowToChunk)
  }

  markActive(chunkId: string, bytesWritten: number): void {
    this.db.run(
      `UPDATE chunks SET status = 'active', bytes_written = ?, updated_at = ? WHERE id = ?`,
      bytesWritten,
      Date.now(),
      chunkId
    )
  }

  markComplete(chunkId: string, checksum: string | null): void {
    // `bytes_written = size` is deliberate: a chunk is only marked complete
    // after every one of its bytes has been durably written.
    this.db.run(
      `UPDATE chunks SET status = 'complete', bytes_written = size, checksum = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      checksum,
      Date.now(),
      chunkId
    )
  }

  markFailed(chunkId: string, error: string): void {
    this.db.run(
      `UPDATE chunks SET status = 'pending', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
      error.slice(0, 2000),
      Date.now(),
      chunkId
    )
  }

  /** Resets in-flight chunks back to pending; used when a transfer is aborted. */
  resetActive(downloadId: DownloadId): void {
    this.db.run(
      `UPDATE chunks SET status = 'pending', updated_at = ? WHERE download_id = ? AND status = 'active'`,
      Date.now(),
      downloadId
    )
  }

  updateProgress(chunkId: string, bytesWritten: number): void {
    this.db.run(
      'UPDATE chunks SET bytes_written = ?, updated_at = ? WHERE id = ?',
      bytesWritten,
      Date.now(),
      chunkId
    )
  }

  /** Bulk progress write, called on the telemetry cadence. */
  updateProgressBatch(entries: readonly { id: string; bytesWritten: number }[]): void {
    if (entries.length === 0) return
    const now = Date.now()
    this.db.transaction(() => {
      for (const entry of entries) {
        this.db.run(
          'UPDATE chunks SET bytes_written = ?, updated_at = ? WHERE id = ?',
          entry.bytesWritten,
          now,
          entry.id
        )
      }
    })
  }

  /** Marks every chunk pending, discarding all progress. */
  invalidateAll(downloadId: DownloadId): void {
    this.db.run(
      `UPDATE chunks SET status = 'pending', bytes_written = 0, checksum = NULL, last_error = NULL, updated_at = ? WHERE download_id = ?`,
      Date.now(),
      downloadId
    )
  }

  /** Discards chunks outside `[0, fileSize)` after the remote size changed. */
  invalidateOutOfRange(downloadId: DownloadId, fileSize: number): number {
    const result = this.db.run(
      `UPDATE chunks SET status = 'pending', bytes_written = 0, checksum = NULL, updated_at = ?
       WHERE download_id = ? AND (end_byte >= ? OR start_byte < 0)`,
      Date.now(),
      downloadId,
      fileSize
    )
    return result.changes
  }

  removeForDownload(downloadId: DownloadId): void {
    this.db.run('DELETE FROM chunks WHERE download_id = ?', downloadId)
  }

  stats(downloadId: DownloadId): { total: number; complete: number; bytes: number } {
    const row = this.db.get<{ total: number; complete: number; bytes: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) AS complete,
              COALESCE(SUM(CASE WHEN status = 'complete' THEN size ELSE 0 END), 0) AS bytes
       FROM chunks WHERE download_id = ?`,
      downloadId
    )
    return {
      total: num(row?.total, 0),
      complete: num(row?.complete, 0),
      bytes: num(row?.bytes, 0)
    }
  }
}

// --- settings ---------------------------------------------------------------

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  getAll(): Record<string, string> {
    const rows = this.db.all<Row>('SELECT key, value FROM settings')
    const out: Record<string, string> = {}
    for (const row of rows) out[str(row.key)] = str(row.value)
    return out
  }

  get(key: string): string | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
    return row ? str(row.value) : null
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      Date.now()
    )
  }

  setMany(entries: Record<string, string>): void {
    if (Object.keys(entries).length === 0) return
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(entries)) this.set(key, value)
    })
  }
}

// --- queue plans ------------------------------------------------------------

export class QueuePlanRepository {
  constructor(private readonly db: Database) {}

  insert(plan: QueuePlan): void {
    this.db.run(
      `INSERT INTO queue_plans
        (id, name, download_ids, starts_at, duration_minutes, strategy, end_action, status, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      plan.id,
      plan.name,
      JSON.stringify(plan.downloadIds),
      plan.startsAt,
      plan.durationMinutes,
      plan.strategy,
      plan.endAction,
      plan.status,
      plan.createdAt,
      plan.endedAt
    )
  }

  get(id: string): QueuePlan | null {
    const row = this.db.get<Row>('SELECT * FROM queue_plans WHERE id = ?', id)
    return row ? rowToQueuePlan(row) : null
  }

  list(): QueuePlan[] {
    return this.db
      .all<Row>('SELECT * FROM queue_plans ORDER BY starts_at DESC, created_at DESC, id DESC')
      .map(rowToQueuePlan)
      .filter((plan): plan is QueuePlan => plan !== null)
  }

  updateStatus(id: string, status: QueuePlanStatus, endedAt: number | null): void {
    this.db.run(
      'UPDATE queue_plans SET status = ?, ended_at = ? WHERE id = ?',
      status,
      endedAt,
      id
    )
  }

  remove(id: string): void {
    this.db.run('DELETE FROM queue_plans WHERE id = ?', id)
  }
}

function rowToQueuePlan(row: Row): QueuePlan | null {
  const id = str(row.id)
  const name = str(row.name)
  const status = str(row.status)
  const strategy = str(row.strategy)
  const endAction = str(row.end_action)
  let downloadIds: unknown
  try {
    downloadIds = JSON.parse(str(row.download_ids))
  } catch (error) {
    log.warn('Skipping queue plan with invalid download list', { id, error })
    return null
  }
  if (
    !id ||
    !name ||
    !Array.isArray(downloadIds) ||
    !downloadIds.every((value) => typeof value === 'string') ||
    !['scheduled', 'running', 'completed', 'canceled'].includes(status) ||
    !['queue-order', 'smallest-first'].includes(strategy) ||
    !['pause', 'continue'].includes(endAction)
  ) {
    log.warn('Skipping queue plan with invalid persisted fields', { id })
    return null
  }
  return {
    id,
    name,
    downloadIds,
    startsAt: num(row.starts_at),
    durationMinutes: num(row.duration_minutes),
    strategy: strategy as QueuePlanStrategy,
    endAction: endAction as QueuePlanEndAction,
    status: status as QueuePlanStatus,
    createdAt: num(row.created_at),
    endedAt: numOrNull(row.ended_at)
  }
}

// --- activity ---------------------------------------------------------------

export interface ActivityEntry {
  id: number
  downloadId: DownloadId
  at: number
  level: string
  message: string
}

export class ActivityRepository {
  constructor(private readonly db: Database) {}

  append(downloadId: DownloadId, level: string, message: string): void {
    this.db.run(
      'INSERT INTO activity (download_id, at, level, message) VALUES (?, ?, ?, ?)',
      downloadId,
      Date.now(),
      level,
      message.slice(0, 4000)
    )
  }

  list(downloadId: DownloadId, limit = 200): ActivityEntry[] {
    return this.db
      .all<Row>(
        'SELECT id, download_id, at, level, message FROM activity WHERE download_id = ? ORDER BY at DESC, id DESC LIMIT ?',
        downloadId,
        limit
      )
      .map((row) => ({
        id: num(row.id, 0),
        downloadId: str(row.download_id),
        at: num(row.at, 0),
        level: str(row.level, 'info'),
        message: str(row.message)
      }))
  }

  /** Keeps the activity table bounded on long-lived installs. */
  prune(keepPerDownload = 200): void {
    this.db.run(
      `DELETE FROM activity WHERE id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY download_id ORDER BY at DESC) AS rn
           FROM activity
         ) WHERE rn <= ?
       )`,
      keepPerDownload
    )
  }
}

export interface PendingVideoMerge {
  downloadId: DownloadId
  audioUrl: string
  container: 'mp4' | 'webm' | 'mkv'
  headers: Record<string, string>
}

export class VideoMergeRepository {
  constructor(private readonly db: Database) {}

  set(merge: PendingVideoMerge): void {
    this.db.run(
      `INSERT INTO pending_video_merges (download_id, audio_url, container, headers, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(download_id) DO UPDATE SET
         audio_url=excluded.audio_url, container=excluded.container,
         headers=excluded.headers, created_at=excluded.created_at`,
      merge.downloadId,
      merge.audioUrl,
      merge.container,
      JSON.stringify(merge.headers),
      Date.now()
    )
  }

  get(downloadId: DownloadId): PendingVideoMerge | null {
    const row = this.db.get<Row>(
      'SELECT download_id, audio_url, container, headers FROM pending_video_merges WHERE download_id = ?',
      downloadId
    )
    if (!row) return null
    const container = str(row.container)
    if (container !== 'mp4' && container !== 'webm' && container !== 'mkv') {
      throw new Error(`Invalid persisted video merge container: ${container}`)
    }
    return {
      downloadId: str(row.download_id),
      audioUrl: str(row.audio_url),
      container,
      headers: parseHeaders(row.headers)
    }
  }

  list(): PendingVideoMerge[] {
    return this.db
      .all<Row>('SELECT download_id FROM pending_video_merges ORDER BY created_at')
      .map((row) => this.get(str(row.download_id)))
      .filter((merge): merge is PendingVideoMerge => merge !== null)
  }

  remove(downloadId: DownloadId): void {
    this.db.run('DELETE FROM pending_video_merges WHERE download_id = ?', downloadId)
  }
}

export interface PendingMediaResolution {
  downloadId: DownloadId
  format: 'video' | 'audio'
  audioFormat: 'source' | 'mp3'
  videoQuality: VideoQuality
  requestedFilename: string | null
  requestedDestination: string | null
  sourcePageUrl: string
  resolved: boolean
  mediaId: string | null
  mediaTitle: string | null
  subtitleLanguages: string[]
  namingTemplate: string | null
  embedMetadata: boolean
}

export class MediaResolutionRepository {
  constructor(private readonly db: Database) {}

  set(resolution: PendingMediaResolution): void {
    this.db.run(
      `INSERT INTO pending_media_resolutions
         (download_id, format, video_quality, requested_filename, requested_destination, audio_format,
          source_page_url, resolved, media_id, media_title, subtitle_languages, naming_template,
          embed_metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(download_id) DO UPDATE SET
         format=excluded.format, video_quality=excluded.video_quality,
         requested_filename=excluded.requested_filename,
         requested_destination=excluded.requested_destination,
         audio_format=excluded.audio_format, source_page_url=excluded.source_page_url,
         resolved=0, media_id=NULL, media_title=NULL,
         subtitle_languages=excluded.subtitle_languages, naming_template=excluded.naming_template,
         embed_metadata=excluded.embed_metadata, created_at=excluded.created_at`,
      resolution.downloadId,
      resolution.format,
      resolution.videoQuality,
      resolution.requestedFilename,
      resolution.requestedDestination,
      resolution.audioFormat,
      resolution.sourcePageUrl,
      JSON.stringify(resolution.subtitleLanguages),
      resolution.namingTemplate,
      resolution.embedMetadata ? 1 : 0,
      Date.now()
    )
  }

  get(downloadId: DownloadId): PendingMediaResolution | null {
    const row = this.db.get<Row>(
      `SELECT download_id, format, video_quality, requested_filename, requested_destination, audio_format,
              source_page_url, resolved, media_id, media_title, subtitle_languages,
              naming_template, embed_metadata
       FROM pending_media_resolutions WHERE download_id = ?`,
      downloadId
    )
    if (!row) return null
    const format = str(row.format)
    const audioFormat = str(row.audio_format)
    let subtitleLanguages: string[] = []
    try {
      const rawLanguages: unknown = JSON.parse(str(row.subtitle_languages, '[]'))
      if (
        Array.isArray(rawLanguages) &&
        rawLanguages.length <= 8 &&
        rawLanguages.every((language) => typeof language === 'string' && /^[A-Za-z0-9_-]{1,35}$/.test(language))
      ) {
        subtitleLanguages = rawLanguages
      } else {
        throw new Error('Invalid saved subtitle languages')
      }
    } catch (err) {
      log.warn('Invalid persisted subtitle languages; using none', { downloadId, error: err })
    }
    const videoQuality = num(row.video_quality)
    if (
      (format !== 'video' && format !== 'audio') ||
      (audioFormat !== 'source' && audioFormat !== 'mp3') ||
      !([360, 480, 720, 1080, 1440, 2160] as number[]).includes(videoQuality)
    ) {
      throw new Error(`Invalid persisted media resolution request for ${downloadId}`)
    }
    return {
      downloadId: str(row.download_id),
      format,
      audioFormat,
      videoQuality: videoQuality as PendingMediaResolution['videoQuality'],
      requestedFilename: strOrNull(row.requested_filename),
      requestedDestination: strOrNull(row.requested_destination),
      sourcePageUrl: str(row.source_page_url),
      resolved: bool(row.resolved),
      mediaId: strOrNull(row.media_id),
      mediaTitle: strOrNull(row.media_title),
      subtitleLanguages,
      namingTemplate: strOrNull(row.naming_template),
      embedMetadata: bool(row.embed_metadata)
    }
  }

  markResolved(downloadId: DownloadId, mediaId: string | null, mediaTitle: string | null): void {
    this.db.run(
      'UPDATE pending_media_resolutions SET resolved = 1, media_id = ?, media_title = ? WHERE download_id = ?',
      mediaId,
      mediaTitle,
      downloadId
    )
  }

  markUnresolved(downloadId: DownloadId): void {
    this.db.run(
      'UPDATE pending_media_resolutions SET resolved = 0, media_id = NULL, media_title = NULL WHERE download_id = ?',
      downloadId
    )
  }

  list(): PendingMediaResolution[] {
    return this.db
      .all<Row>('SELECT download_id FROM pending_media_resolutions ORDER BY created_at')
      .map((row) => this.get(str(row.download_id)))
      .filter((item): item is PendingMediaResolution => item !== null)
  }

  remove(downloadId: DownloadId): void {
    this.db.run('DELETE FROM pending_media_resolutions WHERE download_id = ?', downloadId)
  }
}

export interface MediaHistoryEntry {
  sourceKey: string
  sourcePageUrl: string
  title: string
  filename: string
  completedAt: number
}

export class MediaHistoryRepository {
  constructor(private readonly db: Database) {}

  record(entry: MediaHistoryEntry): void {
    this.db.run(
      `INSERT INTO media_history (source_key, source_page_url, title, filename, completed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET
         source_page_url=excluded.source_page_url, title=excluded.title,
         filename=excluded.filename, completed_at=excluded.completed_at`,
      entry.sourceKey,
      entry.sourcePageUrl,
      entry.title,
      entry.filename,
      entry.completedAt
    )
  }

  findByPageUrl(pageUrl: string): MediaHistoryEntry | null {
    const row = this.db.get<Row>(
      `SELECT source_key, source_page_url, title, filename, completed_at
       FROM media_history WHERE source_page_url = ?`,
      pageUrl
    )
    return row
      ? {
          sourceKey: str(row.source_key),
          sourcePageUrl: str(row.source_page_url),
          title: str(row.title),
          filename: str(row.filename),
          completedAt: num(row.completed_at)
        }
      : null
  }

  hasSourceKey(sourceKey: string): boolean {
    return Boolean(this.db.get<{ source_key: string }>(
      'SELECT source_key FROM media_history WHERE source_key = ?',
      sourceKey
    ))
  }
}

export class AudioTranscodeRepository {
  constructor(private readonly db: Database) {}

  set(downloadId: DownloadId): void {
    this.db.run(
      'INSERT INTO pending_audio_transcodes (download_id) VALUES (?) ON CONFLICT(download_id) DO NOTHING',
      downloadId
    )
  }

  has(downloadId: DownloadId): boolean {
    return Boolean(this.db.get<{ download_id: string }>(
      'SELECT download_id FROM pending_audio_transcodes WHERE download_id = ?',
      downloadId
    ))
  }

  remove(downloadId: DownloadId): void {
    this.db.run('DELETE FROM pending_audio_transcodes WHERE download_id = ?', downloadId)
  }
}

export class YouTubeVideoOutputRepository {
  constructor(private readonly db: Database) {}

  set(downloadId: DownloadId, output: YouTubeVideoOutput): void {
    this.db.run(
      `INSERT INTO youtube_video_output_details
         (download_id, requested_quality, width, height, video_codec, audio_codec, validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(download_id) DO UPDATE SET
         requested_quality=excluded.requested_quality, width=excluded.width, height=excluded.height,
         video_codec=excluded.video_codec, audio_codec=excluded.audio_codec,
         validated_at=excluded.validated_at`,
      downloadId,
      output.requestedQuality,
      output.width,
      output.height,
      output.videoCodec,
      output.audioCodec,
      output.validatedAt
    )
  }

  get(downloadId: DownloadId): YouTubeVideoOutput | null {
    const row = this.db.get<Row>(
      `SELECT requested_quality, width, height, video_codec, audio_codec, validated_at
       FROM youtube_video_output_details WHERE download_id = ?`,
      downloadId
    )
    if (!row) return null
    const requestedQuality = num(row.requested_quality)
    if (![360, 480, 720, 1080, 1440, 2160].includes(requestedQuality)) {
      log.warn('Invalid persisted YouTube output quality', { downloadId, requestedQuality })
      return null
    }
    return {
      requestedQuality: requestedQuality as VideoQuality,
      width: numOrNull(row.width),
      height: numOrNull(row.height),
      videoCodec: strOrNull(row.video_codec),
      audioCodec: strOrNull(row.audio_codec),
      validatedAt: num(row.validated_at)
    }
  }

  remove(downloadId: DownloadId): void {
    this.db.run('DELETE FROM youtube_video_output_details WHERE download_id = ?', downloadId)
  }
}

export interface Repositories {
  downloads: DownloadRepository
  chunks: ChunkRepository
  settings: SettingsRepository
  queuePlans: QueuePlanRepository
  activity: ActivityRepository
  media: MediaRepository
  videoMerges: VideoMergeRepository
  mediaResolutions: MediaResolutionRepository
  youtubeVideoOutputs: YouTubeVideoOutputRepository
  audioTranscodes: AudioTranscodeRepository
  mediaHistory: MediaHistoryRepository
}

export function createRepositories(db: Database): Repositories {
  return {
    downloads: new DownloadRepository(db),
    chunks: new ChunkRepository(db),
    settings: new SettingsRepository(db),
    queuePlans: new QueuePlanRepository(db),
    activity: new ActivityRepository(db),
    media: new MediaRepository(db),
    videoMerges: new VideoMergeRepository(db),
    mediaResolutions: new MediaResolutionRepository(db),
    youtubeVideoOutputs: new YouTubeVideoOutputRepository(db),
    audioTranscodes: new AudioTranscodeRepository(db),
    mediaHistory: new MediaHistoryRepository(db)
  }
}
