/**
 * Disk usage via `node:fs statfs`.
 *
 * Read synchronously: the handler runs on the main thread and `statfs` is a
 * single syscall, so there is nothing to gain from the async form. Returns
 * `null` when the path cannot be statted (removed drive, dead network share)
 * instead of throwing, so the UI can show a dash rather than a toast.
 */

import { statfsSync } from 'node:fs'
import type { DiskUsage } from '@shared/ipc.js'

export function getDiskUsage(directory: string): DiskUsage | null {
  try {
    const stats = statfsSync(directory)
    const blockSize = stats.bsize
    const totalBytes = stats.blocks * blockSize
    const freeBytes = stats.bavail * blockSize
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) {
      return null
    }
    return {
      totalBytes,
      freeBytes: Math.max(0, Math.min(freeBytes, totalBytes))
    }
  } catch {
    return null
  }
}
