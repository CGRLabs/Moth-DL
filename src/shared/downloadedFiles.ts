import type { DownloadCategory } from './types.js'

export interface DownloadedFileRecord {
  status: string
  filename: string
  finalPath: string | null
  category: DownloadCategory
  completedAt: number | null
  updatedAt: number
  metadata?: { title: string | null }
}

export function selectDownloadedFiles<T extends DownloadedFileRecord>(
  downloads: readonly T[],
  search: string,
  category: DownloadCategory | 'all' = 'all'
): T[] {
  const needle = search.trim().toLowerCase()
  return downloads
    .filter((download) => download.status === 'completed')
    .filter((download) => category === 'all' || download.category === category)
    .filter((download) => !needle || [
      download.filename,
      download.finalPath ?? '',
      download.category,
      download.metadata?.title ?? ''
    ].some((value) => value.toLowerCase().includes(needle)))
    .sort((left, right) =>
      (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt)
    )
}