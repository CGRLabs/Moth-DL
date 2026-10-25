/** Byte / duration / throughput formatting and parsing. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Human readable byte size, e.g. `1.5 MB`. Uses 1024-based units. */
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

/** Transfer rate, e.g. `12.4 MB/s`. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond, bytesPerSecond < 1024 * 100 ? 0 : 1)}/s`
}

/** Compact duration: `3d 4h`, `12m 30s`, `45s`, `just now`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 1) return 'just now'
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

/** Parses `1.5MB`, `512 kbps`, `2G` into bytes (or bytes/second for rates). */
export function parseByteSize(input: string): number | null {
  const trimmed = input.trim().toLowerCase().replace(/[\s,]/g, '')
  const match = /^(\d+(?:\.\d+)?)([kmgtp]?)(i?)b(?:ps|its|\/s)?$/.exec(trimmed)
  if (!match) return null
  const [, rawValue, prefix, binary] = match
  const value = Number.parseFloat(rawValue as string)
  if (!Number.isFinite(value)) return null
  const isBinary = binary === 'i' || prefix !== ''
  const base = isBinary ? 1024 : 1000
  const exponents: Record<string, number> = { '': 0, k: 1, m: 2, g: 3, t: 4, p: 5 }
  const exponent = exponents[prefix ?? ''] ?? 0
  return Math.round(value * base ** exponent)
}

/** `0.42` -> `42%`. */
export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—'
  return `${(fraction * 100).toFixed(digits)}%`
}

/** Remaining time from a rate, guarding against a stalled transfer. */
export function estimateEta(remainingBytes: number, bytesPerSecond: number): number | null {
  if (bytesPerSecond <= 0 || remainingBytes <= 0) return null
  if (!Number.isFinite(bytesPerSecond)) return null
  const eta = remainingBytes / bytesPerSecond
  // Beyond ~100 years the estimate is meaningless.
  return eta > 3.15e9 ? null : eta
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value
