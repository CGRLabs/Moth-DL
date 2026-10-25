/** Status filter logic shared by the sidebar.
 *
 * The UI moved into the sidebar (mockup direction); this module keeps the
 * filter vocabulary and matching in one place. It is no longer rendered.
 */

import type { DownloadSnapshot } from '@shared/types.js'

export type Filter = 'all' | 'active' | 'completed' | 'paused' | 'scheduled' | 'failed'

export const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
  { key: 'paused', label: 'Paused' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'failed', label: 'Failed' }
]

export type CategoryFilter = DownloadSnapshot['category'] | 'all'

export function matchesFilter(download: DownloadSnapshot, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return ['downloading', 'connecting', 'verifying', 'queued'].includes(download.status)
    case 'completed':
      return download.status === 'completed'
    case 'paused':
      return download.status === 'paused'
    case 'scheduled':
      return download.status === 'scheduled'
    case 'failed':
      return download.status === 'failed' || download.status === 'canceled'
  }
}

export function matchesCategory(download: DownloadSnapshot, category: CategoryFilter): boolean {
  return category === 'all' || download.category === category
}

export function countByFilter(
  downloads: DownloadSnapshot[],
  filter: Filter
): number {
  if (filter === 'all') return downloads.length
  let count = 0
  for (const download of downloads) {
    if (matchesFilter(download, filter)) count += 1
  }
  return count
}

export function countByCategory(
  downloads: DownloadSnapshot[],
  category: CategoryFilter
): number {
  if (category === 'all') return downloads.length
  let count = 0
  for (const download of downloads) {
    if (download.category === category) count += 1
  }
  return count
}
