/**
 * Structured error type.
 *
 * Every failure that crosses a module boundary is an `EngineError` so that the
 * scheduler can make a single, uniform decision: retry (with backoff), fail
 * permanently, or simply stop because the user asked for it.
 */

import type { ErrorCode } from '@shared/types.js'

export interface EngineErrorOptions {
  code: ErrorCode
  message: string
  retryable?: boolean
  httpStatus?: number
  cause?: unknown
  /** Free-form structured context for the log. */
  context?: Record<string, unknown>
}

/** Default retry policy per code. `RANGE_UNSUPPORTED` is fatal by design. */
const RETRYABLE_BY_DEFAULT: Record<ErrorCode, boolean> = {
  NETWORK: true,
  TIMEOUT: true,
  HTTP_CLIENT_ERROR: false,
  HTTP_SERVER_ERROR: true,
  HTTP_TOO_MANY_REQUESTS: true,
  RANGE_UNSUPPORTED: false,
  FILE_IO: true,
  DISK_FULL: false,
  CHECKSUM_MISMATCH: false,
  CANCELED: false,
  PAUSED: false,
  PRECONDITION_FAILED: false,
  INTERNAL: true
}

export class EngineError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly httpStatus: number | undefined
  readonly context: Record<string, unknown> | undefined

  constructor(options: EngineErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'EngineError'
    this.code = options.code
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT[options.code]
    this.httpStatus = options.httpStatus
    this.context = options.context
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      context: this.context
    }
  }
}

export const isEngineError = (value: unknown): value is EngineError =>
  value instanceof EngineError ||
  (typeof value === 'object' &&
    value !== null &&
    (value as { name?: string }).name === 'EngineError' &&
    typeof (value as { code?: unknown }).code === 'string')

/** Normalises any thrown value into an EngineError, preserving known codes. */
export function toEngineError(value: unknown, fallback: ErrorCode = 'INTERNAL'): EngineError {
  if (isEngineError(value)) return value as EngineError
  if (value instanceof Error) {
    return new EngineError({ code: fallback, message: value.message, cause: value })
  }
  return new EngineError({ code: fallback, message: String(value) })
}

export const isCanceled = (value: unknown): boolean =>
  isEngineError(value) && (value.code === 'CANCELED' || value.code === 'PAUSED')

/**
 * Classifies a Node filesystem error into a meaningful EngineError.
 * ENOSPC is separated out because retrying a full disk is pointless and the UI
 * must tell the user to free space.
 */
export function fromFileSystemError(err: unknown, path: string): EngineError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC') {
    return new EngineError({
      code: 'DISK_FULL',
      message: `Not enough free disk space to write to ${path}`,
      cause: err
    })
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new EngineError({
      code: 'FILE_IO',
      message: `Permission denied writing to ${path}`,
      retryable: false,
      cause: err
    })
  }
  if (code === 'EBUSY') {
    return new EngineError({
      code: 'FILE_IO',
      message: `File is locked by another process: ${path}`,
      cause: err
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  return new EngineError({
    code: 'FILE_IO',
    message: `Filesystem error on ${path}: ${message}`,
    cause: err
  })
}
