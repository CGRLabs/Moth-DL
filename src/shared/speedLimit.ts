export const SPEED_LIMIT_UNITS = {
  'B/s': 1,
  'KB/s': 1024,
  'MB/s': 1024 ** 2,
  'GB/s': 1024 ** 3
} as const

export type SpeedLimitUnit = keyof typeof SPEED_LIMIT_UNITS
export const SPEED_LIMIT_UNIT_OPTIONS: readonly SpeedLimitUnit[] = ['B/s', 'KB/s', 'MB/s', 'GB/s']

const MAX_SPEED_LIMIT = 1024 ** 4

export function toBytesPerSecond(value: string, unit: SpeedLimitUnit): number | null {
  const amount = Number(value.trim())
  if (!value.trim() || !Number.isFinite(amount) || amount <= 0) return null

  const bytesPerSecond = Math.round(amount * SPEED_LIMIT_UNITS[unit])
  return Number.isSafeInteger(bytesPerSecond) &&
    bytesPerSecond > 0 &&
    bytesPerSecond <= MAX_SPEED_LIMIT
    ? bytesPerSecond
    : null
}

export function fromBytesPerSecond(bytesPerSecond: number): {
  value: string
  unit: SpeedLimitUnit
} {
  let unit: SpeedLimitUnit = 'B/s'
  for (const candidate of ['KB/s', 'MB/s', 'GB/s'] as const) {
    if (bytesPerSecond >= SPEED_LIMIT_UNITS[candidate]) unit = candidate
    else break
  }

  const value = (bytesPerSecond / SPEED_LIMIT_UNITS[unit]).toFixed(6).replace(/\.?0+$/, '')
  return { value, unit }
}
