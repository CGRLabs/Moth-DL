/**
 * Resolves the on-disk path for a download, for server-side tag writing.
 *
 * Split from the IPC handler so the path lookup is testable without Electron,
 * and so the handler stays a thin validation-and-dispatch shell.
 */

import type { Repositories } from '../db/repositories.js'
import { getLogger } from '../util/logger.js'
import { pathExists } from '../util/paths.js'

const log = getLogger('ipc.mediaPaths')

/**
 * Returns the path to write tags into, or null when there is no file.
 *
 * A completed download has a final path; anything else is still a partial file.
 * Both are written in place, which is why the caller must confirm the download
 * is finished before offering the action.
 */
export async function getDownloadPath(
  repos: Repositories,
  downloadId: string
): Promise<string | null> {
  const download = repos.downloads.get(downloadId)
  if (!download) return null

  const candidate = download.status === 'completed' ? download.finalPath : download.tempPath
  if (!candidate) return null

  if (!(await pathExists(candidate))) {
    log.warn('Download has no file on disk', { downloadId, candidate })
    return null
  }
  return candidate
}
