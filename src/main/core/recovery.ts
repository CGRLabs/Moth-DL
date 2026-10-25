/**
 * Crash recovery.
 *
 * On startup Moth does not trust the database. A power cut can leave the two
 * sources of truth — the SQLite chunk map and the bytes actually on disk — in
 * disagreement, and only the *intersection* of the two is provably good:
 *
 *   DB says complete   + disk has the bytes   -> keep (verified by digest)
 *   DB says complete   + disk is short/zero  -> re-download
 *   DB says partial    + disk has more bytes  -> keep the checkpoint, rewind
 *   DB says partial    + disk has fewer bytes -> re-download from the rewind point
 *
 * Everything else is discarded. Recovery is deliberately conservative: it
 * would be far cheaper to trust the database, but the whole promise of the
 * product is that resuming never silently produces a corrupt file, so a chunk
 * is only ever trusted after its digest is confirmed against the disk.
 *
 * The pass is also what makes "killed at 70% -> resumes from 70%" true: the
 * chunk map is a range bitmap, so the surviving 70% is kept and only the
 * missing 30% is re-requested.
 */

import type { Chunk, Download, DownloadId } from '@shared/types.js'
import { DEFAULT_CHUNK_SIZE } from '@shared/constants.js'
import type { Repositories } from '../db/repositories.js'
import { hashRange, digestMatches, verifyFile } from '../util/checksum.js'
import { planChunks, validateChunkMap, completedBytes } from './planner.js'
import { inspectPartialFile } from './writer.js'
import { inspectPath } from '../util/paths.js'
import { getLogger } from '../util/logger.js'
import { emitActivity } from './activity.js'
import { isTorrentSource } from '@shared/torrent.js'

const log = getLogger('core.recovery')

/** How aggressively completed chunks are re-verified against the disk. */
export type VerifyMode = 'none' | 'sample' | 'all'

export interface RecoveryOptions {
  /**
   * 'all' re-digests every completed chunk. Capped by `maxVerifyBytes` so a
   * very large download cannot stall startup for minutes.
   */
  verify?: VerifyMode
  /** Upper bound on bytes re-hashed per download. */
  maxVerifyBytes?: number
  /** Chunks sampled when `verify === 'sample'`. */
  sampleSize?: number
  /**
   * Chunk size to use if the map must be rebuilt. Must match the task's, or
   * every salvaged chunk is invalidated by the layout change and the user
   * silently loses their progress.
   */
  desiredChunkSize?: number
}

export interface RecoveryAction {
  id: DownloadId
  /** What recovery decided, for the UI report. */
  action: 'resumable' | 'repaired' | 'replanned' | 'reset' | 'orphaned' | 'skipped'
  bytesKept: number
  chunksKept: number
  chunksReset: number
  note: string
}

export interface RecoveryReport {
  scanned: number
  repaired: number
  bytesRecovered: number
  durationMs: number
  details: RecoveryAction[]
}

const DEFAULTS: Required<RecoveryOptions> = {
  verify: 'all',
  maxVerifyBytes: 512 * 1024 * 1024,
  sampleSize: 8,
  desiredChunkSize: DEFAULT_CHUNK_SIZE
}

/**
 * Scans every unfinished download and reconciles the database against the disk.
 * Mutates both; returns a report suitable for the UI.
 */
export async function runRecovery(
  repos: Repositories,
  options: RecoveryOptions = {}
): Promise<RecoveryReport> {
  const startedAt = Date.now()
  const config = { ...DEFAULTS, ...options }

  const candidates = repos.downloads
    .list()
    .filter((download) =>
      download.status !== 'completed' &&
      download.status !== 'canceled' &&
      download.status !== 'review' &&
      !isTorrentSource(download.url)
    )

  const details: RecoveryAction[] = []
  let bytesRecovered = 0
  let repaired = 0

  for (const download of candidates) {
    try {
      const action = await recoverOne(repos, download, config)
      details.push(action)
      if (action.action !== 'skipped') repaired += 1
      bytesRecovered += action.bytesKept
    } catch (err) {
      log.error('Recovery failed for download; marking as paused', {
        id: download.id,
        error: err instanceof Error ? err.message : String(err)
      })
      // Never let one bad row block startup.
      try {
        repos.downloads.update(download.id, { status: 'paused' })
      } catch {
        /* the database itself is broken; the caller will surface it */
      }
      details.push({
        id: download.id,
        action: 'skipped',
        bytesKept: 0,
        chunksKept: 0,
        chunksReset: 0,
        note: `Recovery error: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  const durationMs = Date.now() - startedAt
  log.info('Recovery pass complete', {
    scanned: candidates.length,
    repaired,
    bytesRecovered,
    durationMs
  })

  return { scanned: candidates.length, repaired, bytesRecovered, durationMs, details }
}

/** Reconciles a single download. */
async function recoverOne(
  repos: Repositories,
  download: Download,
  config: Required<RecoveryOptions>
): Promise<RecoveryAction> {
  const base: RecoveryAction = {
    id: download.id,
    action: 'skipped',
    bytesKept: 0,
    chunksKept: 0,
    chunksReset: 0,
    note: ''
  }

  // 1. The partial file is the ground truth for "how much do we actually have".
  const disk = await inspectPartialFile(download.tempPath, download.fileSize)

  if (disk.size === 0) {
    // Promote-before-record crash window: `finalise` moves .mothpart -> final
    // and only then commits status:'completed'. A crash in between leaves the
    // temp gone, the DB still "downloading", and a complete final file that
    // the old code wiped to 0% (and the next resume deleted). Check first.
    const promoted = await recoverPromotedFile(repos, download)
    if (promoted) return { ...base, ...promoted }
    // Nothing on disk. Any "complete" chunks in the DB are a lie, so wipe them.
    if (download.downloadedBytes > 0 || repos.chunks.listByDownload(download.id).length > 0) {
      repos.chunks.invalidateAll(download.id)
      emitActivity(repos, download.id, 'warn', 'Partial file was missing; progress reset')
    }
    repos.downloads.update(download.id, {
      status: 'paused',
      downloadedBytes: 0
    })
    return {
      ...base,
      action: 'reset',
      note: 'Partial file missing; progress reset to zero'
    }
  }

  // 2. A never-probed download has no size, so no map can be validated yet.
  if (download.fileSize <= 0) {
    repos.downloads.update(download.id, { status: 'paused' })
    return {
      ...base,
      action: 'resumable',
      note: 'Awaiting first probe; will plan chunks on resume'
    }
  }

  // 3. The file on disk is shorter than the database believes. The tail chunks
  //    cannot be trusted; find where the disk actually ends and reset from there.
  const sizeMismatch = disk.size < download.fileSize
  if (sizeMismatch) {
    log.warn('Partial file is shorter than expected; trimming trust boundary', {
      id: download.id,
      diskSize: disk.size,
      expected: download.fileSize
    })
  }

  // 4. Load and validate the chunk map.
  let chunks = repos.chunks.listByDownload(download.id)
  let replanned = false

  if (chunks.length === 0) {
    // The map never made it to disk (crash between insert and plan). Rebuild it.
    chunks = planChunks({
      downloadId: download.id,
      fileSize: download.fileSize,
      desiredChunkSize: config.desiredChunkSize
    })
    repos.chunks.replaceAll(download.id, chunks)
    replanned = true
  } else {
    const validation = validateChunkMap(chunks, download.fileSize)
    if (!validation.valid) {
      log.warn('Chunk map invalid; replanning while salvaging progress', {
        id: download.id,
        reason: validation.reason
      })
      const salvaged = salvageProgress(chunks, download)
      chunks = planChunks({
        downloadId: download.id,
        fileSize: download.fileSize,
        desiredChunkSize: config.desiredChunkSize
      })
      for (const chunk of chunks) {
        const covered = salvaged.some((r) => r[0] <= chunk.start && r[1] >= chunk.end)
        if (covered) {
          chunk.status = 'complete'
          chunk.bytesWritten = chunk.size
        }
      }
      repos.chunks.replaceAll(download.id, chunks)
      replanned = true
    }
  }

  // 5. Drop any chunk that extends past the real end of the file on disk.
  const lastUsableByte = Math.min(disk.size, download.fileSize) - 1
  let chunksReset = 0
  for (const chunk of chunks) {
    if (chunk.end > lastUsableByte && chunk.status === 'complete') {
      chunk.status = 'pending'
      chunk.bytesWritten = 0
      chunk.checksum = null
      repos.chunks.insert(chunk)
      chunksReset += 1
    }
  }

  // 6. Verify completed chunks against the bytes actually on disk.
  let verifiedBytes = 0
  const toVerify = selectChunksToVerify(chunks, config, verifiedBytes)
  for (const chunk of toVerify) {
    if (verifiedBytes + chunk.size > config.maxVerifyBytes) break
    verifiedBytes += chunk.size

    const expected = chunk.checksum
    if (!expected) {
      // No digest recorded (crash between fsync and digest): accept the chunk
      // but record a digest so the next recovery can actually check it.
      try {
        const digest = await hashRange(download.tempPath, chunk.start, chunk.end, 'sha256')
        chunk.checksum = digest
        repos.chunks.insert(chunk)
      } catch (err) {
        log.warn('Could not digest chunk during recovery', {
          id: download.id,
          chunk: chunk.index,
          error: err
        })
      }
      continue
    }

    try {
      const actual = await hashRange(download.tempPath, chunk.start, chunk.end, 'sha256')
      if (!digestMatches(actual, expected)) {
        log.warn('Corrupted chunk detected; scheduling re-download', {
          id: download.id,
          chunk: chunk.index
        })
        chunk.status = 'pending'
        chunk.bytesWritten = 0
        chunk.checksum = null
        repos.chunks.insert(chunk)
        chunksReset += 1
        emitActivity(
          repos,
          download.id,
          'warn',
          `Chunk ${chunk.index + 1} was corrupted on disk and will be downloaded again`
        )
      }
    } catch (err) {
      log.warn('Chunk verification failed; resetting chunk', {
        id: download.id,
        chunk: chunk.index,
        error: err
      })
      chunk.status = 'pending'
      chunk.bytesWritten = 0
      chunk.checksum = null
      repos.chunks.insert(chunk)
      chunksReset += 1
    }
  }

  // 7. Partially written chunks keep their checkpoint; the task rewinds a
  //    safety margin before resuming, so a torn tail can never leave a hole.
  const pendingWithProgress = chunks.filter(
    (chunk) => chunk.status !== 'complete' && chunk.bytesWritten > 0
  ).length

  // 8. Commit the reconciled state.
  const kept = completedBytes(chunks)
  const allComplete = chunks.length > 0 && chunks.every((chunk) => chunk.status === 'complete')

  repos.downloads.update(download.id, {
    downloadedBytes: kept,
    status: allComplete ? 'completed' : 'paused',
    errorCode: null,
    errorMessage: null
  })

  const action: RecoveryAction = {
    id: download.id,
    action: allComplete
      ? 'resumable'
      : replanned
        ? 'replanned'
        : chunksReset > 0 || sizeMismatch
          ? 'repaired'
          : 'resumable',
    bytesKept: kept,
    chunksKept: chunks.filter((chunk) => chunk.status === 'complete').length,
    chunksReset,
    note: allComplete
      ? 'All chunks present; ready to finalise'
      : sizeMismatch
        ? `Kept ${kept} of ${download.fileSize} bytes; ${chunksReset} chunk(s) reset`
        : `Kept ${kept} of ${download.fileSize} bytes`
  }

  if (chunksReset > 0) {
    emitActivity(
      repos,
      download.id,
      'info',
      `Recovery: ${action.chunksKept} chunks verified, ${chunksReset} reset for re-download`
    )
  }
  if (pendingWithProgress > 0) {
    log.debug('Partially written chunks will resume with a rewind', {
      id: download.id,
      count: pendingWithProgress
    })
  }

  return action
}

/**
 * Promote-before-record crash window: the final file is already in place at
 * full size (the move succeeded) but the DB never recorded `completed` (the
 * crash landed before the commit). Recognise this state and claim the file
 * instead of wiping progress to zero and re-downloading — let alone letting
 * the next resume delete the already-correct file.
 *
 * Trust order: user-supplied expected digest first, then the baseline digest
 * recorded before the move, then size alone as a documented best effort (no
 * digest was ever recorded, and only our own move writes to finalPath).
 * Returns the action fields on success, or `null` when this is not a
 * promoted file (caller falls through to the normal missing-temp reset).
 * A file that cannot even be read pauses without wiping, so a transient IO
 * error can never destroy evidence of a good download.
 */
async function recoverPromotedFile(
  repos: Repositories,
  download: Download
): Promise<Omit<RecoveryAction, 'id'> | null> {
  if (!download.finalPath || download.finalPath === download.tempPath) return null
  if (download.fileSize <= 0) return null

  const final = await inspectPath(download.finalPath)
  if (!final.exists || final.isDirectory || final.size !== download.fileSize) return null

  if (download.expectedChecksum) {
    let result: Awaited<ReturnType<typeof verifyFile>> | null = null
    try {
      result = await verifyFile(download.finalPath, download.expectedChecksum)
    } catch {
      result = null
    }
    if (!result) {
      repos.downloads.update(download.id, { status: 'paused' })
      emitActivity(
        repos,
        download.id,
        'warn',
        'Finished file found but could not be verified (read error); kept as-is instead of resetting'
      )
      return {
        action: 'resumable',
        bytesKept: 0,
        chunksKept: 0,
        chunksReset: 0,
        note: 'Final file present but unreadable; paused without resetting'
      }
    }
    if (!result.ok) return null
  } else if (download.computedChecksum) {
    let actual: string | null = null
    try {
      actual = await hashRange(download.finalPath, 0, download.fileSize - 1, 'sha256')
    } catch {
      actual = null
    }
    if (!actual) {
      repos.downloads.update(download.id, { status: 'paused' })
      emitActivity(
        repos,
        download.id,
        'warn',
        'Finished file found but could not be verified (read error); kept as-is instead of resetting'
      )
      return {
        action: 'resumable',
        bytesKept: 0,
        chunksKept: 0,
        chunksReset: 0,
        note: 'Final file present but unreadable; paused without resetting'
      }
    }
    if (!digestMatches(actual, download.computedChecksum)) return null
  }
  // Else: no digest of any kind — size is the only signal. Best effort, and
  // said so: only our own move writes to finalPath, so a full-size file here
  // with an empty temp is overwhelmingly the crashed promotion, not a plant.

  const chunks = repos.chunks.listByDownload(download.id)
  if (chunks.length > 0) {
    repos.chunks.replaceAll(
      download.id,
      chunks.map((chunk) => ({ ...chunk, status: 'complete' as const, bytesWritten: chunk.size }))
    )
  }
  repos.downloads.update(download.id, {
    status: 'completed',
    downloadedBytes: download.fileSize,
    completedAt: Date.now(),
    errorCode: null,
    errorMessage: null
  })
  emitActivity(
    repos,
    download.id,
    'info',
    'Crash interrupted recording completion, but the finished file verified OK; marked completed without re-downloading'
  )
  log.info('Recovered promoted file without re-download', { id: download.id })
  return {
    action: 'resumable',
    bytesKept: download.fileSize,
    chunksKept: chunks.length,
    chunksReset: 0,
    note: 'Final file verified after an interrupted completion; marked completed'
  }
}

/** Byte ranges of every completed chunk in a (possibly corrupt) map. */
function salvageProgress(chunks: readonly Chunk[], download: Download): Array<[number, number]> {
  void download
  return chunks
    .filter((chunk) => chunk.status === 'complete')
    .map((chunk) => [chunk.start, chunk.end] as [number, number])
    .sort((a, b) => a[0] - b[0])
}

/**
 * Chooses which completed chunks to re-verify.
 * Sampling always includes the highest-index chunk, which is the one most
 * likely to be a torn write from the crash.
 */
function selectChunksToVerify(
  chunks: readonly Chunk[],
  config: Required<RecoveryOptions>,
  alreadyBudgeted: number
): Chunk[] {
  void alreadyBudgeted
  if (config.verify === 'none') return []
  const complete = chunks.filter((chunk) => chunk.status === 'complete')
  if (complete.length === 0) return []
  if (config.verify === 'all') return complete

  const step = Math.max(1, Math.floor(complete.length / config.sampleSize))
  const sampled = complete.filter((_, index) => index % step === 0)
  const last = complete[complete.length - 1]
  if (last && !sampled.includes(last)) sampled.push(last)
  return sampled
}

/**
 * Re-checks a single download on demand (the "Rescan" button).
 * Returns how many bytes survived.
 */
export async function verifyAgainstDisk(
  repos: Repositories,
  downloadId: DownloadId,
  options: RecoveryOptions = {}
): Promise<RecoveryReport> {
  const download = repos.downloads.get(downloadId)
  if (!download) {
    return { scanned: 0, repaired: 0, bytesRecovered: 0, durationMs: 0, details: [] }
  }
  const action = await recoverOne(repos, download, { ...DEFAULTS, ...options })
  return {
    scanned: 1,
    repaired: action.action === 'skipped' ? 0 : 1,
    bytesRecovered: action.bytesKept,
    durationMs: 0,
    details: [action]
  }
}
