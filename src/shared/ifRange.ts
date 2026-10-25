/**
 * Selects a validator suitable for HTTP If-Range.
 *
 * A weak ETag is deliberately not converted into a strong validator. When a
 * weak ETag is present it blocks Last-Modified fallback, matching the HTTP
 * client's established source-identity policy.
 */
export function selectIfRangeValidator(
  etag: string | null | undefined,
  lastModified: string | null | undefined
): { value: string | null; droppedWeakETag: boolean } {
  const tag = etag?.trim() ?? ''
  if (tag.length > 0) {
    if (/^w\//i.test(tag)) return { value: null, droppedWeakETag: true }
    return { value: tag, droppedWeakETag: false }
  }
  const stamp = lastModified?.trim() ?? ''
  if (stamp.length > 0) return { value: stamp, droppedWeakETag: false }
  return { value: null, droppedWeakETag: false }
}
