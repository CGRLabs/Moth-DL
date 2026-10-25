import { describe, expect, it } from 'vitest'
import { sanitizeLogData, sanitizeLogText } from '../../src/main/util/logger.js'

describe('log sanitization', () => {
  it('redacts URL query values, fragments, and embedded credentials', () => {
    const result = sanitizeLogText(
      'Request https://user:pass@example.com/watch?v=video-id&token=private#fragment'
    )

    expect(result).toContain('https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/watch')
    expect(result).toContain('v=%5BREDACTED%5D')
    expect(result).toContain('token')
    expect(result).not.toContain('video-id')
    expect(result).not.toContain('private')
    expect(result).not.toContain('fragment')
  })

  it('redacts credential fields recursively and sanitizes errors', () => {
    const error = new Error('Request failed at https://example.com/file?key=private')
    const result = sanitizeLogData({
      headers: { Cookie: 'session=private', Accept: 'video/*' },
      nested: { accessToken: 'private', detail: error }
    })

    expect(result).toEqual({
      headers: { Cookie: '[REDACTED]', Accept: 'video/*' },
      nested: {
        accessToken: '[REDACTED]',
        detail: expect.objectContaining({
          message: 'Request failed at https://example.com/file?key=%5BREDACTED%5D'
        })
      }
    })
  })

  it('handles cyclic diagnostic objects without throwing', () => {
    const data: Record<string, unknown> = {}
    data['self'] = data

    expect(sanitizeLogData(data)).toEqual({ self: '[Circular]' })
  })
})
