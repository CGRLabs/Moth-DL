const MEGABYTE = 1024 ** 2
const MAX_QUOTA_BYTES = Number.MAX_SAFE_INTEGER

export function toQuotaBytes(value: string): number | null {
  const amount = Number(value.trim())
  if (!value.trim() || !Number.isFinite(amount) || amount <= 0) return null

  const bytes = Math.round(amount * MEGABYTE)
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_QUOTA_BYTES ? bytes : null
}

export function fromQuotaBytes(bytes: number): string {
  return (bytes / MEGABYTE).toFixed(6).replace(/\.?0+$/, '')
}
