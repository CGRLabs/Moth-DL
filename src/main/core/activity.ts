/**
 * Per-download activity log.
 *
 * The rotating file log is for developers; this table is for the user. It
 * records the human-meaningful events ("paused by user", "retry 2 of 5 after
 * HTTP 503") that the detail panel shows. Writes are best-effort: losing an
 * activity row must never interrupt a download.
 */

import type { Repositories } from '../db/repositories.js'
import { getLogger } from '../util/logger.js'

const log = getLogger('core.activity')

export type ActivityLevel = 'info' | 'warn' | 'error'

export function emitActivity(
  repos: Repositories,
  downloadId: string,
  level: ActivityLevel,
  message: string
): void {
  try {
    repos.activity.append(downloadId, level, message)
  } catch (err) {
    log.warn('Failed to append activity', { downloadId, error: err })
  }
}
