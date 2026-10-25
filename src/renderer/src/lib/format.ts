/**
 * Renderer-side formatting.
 *
 * Deliberately duplicated from the main process: the renderer runs in an
 * isolated context with no Node access, and pulling `util/bytes` across the
 * bridge just to format a string would be absurd. The two must stay in sync —
 * the unit tests in `test/unit/bytes.test.ts` pin the main-process copy.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export function formatBytes(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(precision)} ${UNITS[unit]}`
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSecond, bytesPerSecond < 1024 * 100 ? 0 : 1)}/s`
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 1) return 'less than a second'
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—'
  return `${(fraction * 100).toFixed(digits)}%`
}

/** `1700000000000` -> `14:32:07`. */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour12: false })
}

export function formatRelative(epochMs: number, now = Date.now()): string {
  const delta = Math.round((now - epochMs) / 1000)
  if (delta < 5) return 'just now'
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

export { formatDateTime } from '@shared/dateTime.js'

/** Truncates a long URL to `host/…/tail` for compact display. */
export function shortenUrl(url: string, max = 52): string {
  try {
    const parsed = new URL(url)
    const tail = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
    const label = tail ? `${parsed.host}/…/${tail}` : parsed.host
    return label.length > max ? `${label.slice(0, max - 1)}…` : label
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url
  }
}

export const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  connecting: 'Connecting',
  downloading: 'Downloading',
  paused: 'Paused',
  verifying: 'Verifying',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Cancelled',
  scheduled: 'Scheduled',
  review: 'Review'
}

/** Short forms for the row, where space is tight. */
export const STATUS_SHORT: Record<string, string> = {
  queued: 'Queued',
  connecting: 'Connecting',
  downloading: 'Active',
  paused: 'Paused',
  verifying: 'Verifying',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Cancelled',
  scheduled: 'Scheduled',
  review: 'Review'
}

/** Statuses where a transfer is in flight and progress will keep moving. */
export const ACTIVE_STATUSES = new Set([
  'downloading',
  'connecting',
  'verifying',
  'queued',
  'scheduled'
])

export const isActive = (status: string): boolean => ACTIVE_STATUSES.has(status)

/**
 * A one-letter monogram per category.
 *
 * Replaces the previous emoji map: emoji render at wildly different sizes and
 * weights per platform, and several showed as a missing-glyph box.
 */
export const CATEGORY_MONOGRAM: Record<string, string> = {
  video: 'V',
  audio: 'A',
  document: 'D',
  archive: 'Z',
  executable: 'X',
  image: 'I',
  installer: 'P',
  other: 'F'
}

export const CATEGORY_LABEL: Record<string, string> = {
  video: 'Videos',
  audio: 'Music',
  document: 'Documents',
  archive: 'Archives',
  executable: 'Executables',
  image: 'Images',
  installer: 'Installers',
  other: 'Other'
}
