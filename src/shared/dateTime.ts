/** Formats an epoch timestamp as a readable date and time in the user's locale. */
export function formatDateTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—'
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
