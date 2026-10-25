/**
 * HTTP transport for range-based downloading.
 *
 * Built directly on `node:http`/`node:https` rather than a third-party client
 * so that Moth has exact control over the three things that make a resumable
 * downloader work or fail:
 *
 *  1. **Range correctness** - a `206 Partial Content` is verified against the
 *     bytes we asked for. A server that answers `200 OK` to a range request
 *     (very common) is detected and reported as `RANGE_UNSUPPORTED` instead of
 *     silently corrupting the file by writing the whole body at an offset.
 *  2. **Preconditions** - `ETag`/`Last-Modified` are sent back as `If-Range` so
 *     a changed remote file cannot be stitched onto old bytes.
 *  3. **Redirects** - redirects are followed manually and credentials are
 *     removed when crossing origins. Transfers start at the original URL so
 *     that this protection also applies after a restart.
 */

import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RemoteMetadata } from '@shared/types.js'
import {
  DEFAULT_USER_AGENT,
  CONNECT_TIMEOUT_MS,
  IDLE_SOCKET_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS
} from '@shared/constants.js'
import { EngineError } from '../util/errors.js'
import { parseRetryAfter } from '../util/backoff.js'
import { getLogger } from '../util/logger.js'
import { selectIfRangeValidator } from '@shared/ifRange.js'
export { selectIfRangeValidator } from '@shared/ifRange.js'

const log = getLogger('net.http')

const MAX_REDIRECTS = 5

/** Sockets are pooled: with 16 parallel chunks per file, per-chunk TLS
 *  handshakes would otherwise dominate the transfer time. */
const httpAgent = new HttpAgent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: IDLE_SOCKET_TIMEOUT_MS
})
const httpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: IDLE_SOCKET_TIMEOUT_MS
})

export function closeAgents(): void {
  httpAgent.destroy()
  httpsAgent.destroy()
}

export interface ClientOptions {
  headers?: Record<string, string>
  userAgent?: string
  signal?: AbortSignal
  /** Overall timeout for establishing a response. */
  timeoutMs?: number
  /** Maximum redirects to follow. */
  maxRedirects?: number
}

export interface RangeRequest extends ClientOptions {
  /** Absolute URL to fetch the range from. */
  url: string
  start: number
  /** Inclusive end offset. */
  end: number
  /** ETag/Last-Modified from the probe; guards against the file changing. */
  etag?: string | null
  lastModified?: string | null
}

export interface RangeResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  stream: Readable
  /** Bytes the server says it will send for this range. */
  contentLength: number
  /** Total file size parsed from `Content-Range`, when disclosed. */
  totalSize: number | null
  /** `false` when the server ignored the Range header and sent the whole file. */
  rangeHonored: boolean
  /** URL that actually served the bytes, after redirects. */
  finalUrl: string
  /** True when the server replied 416, i.e. our offset is past the end. */
  rangeNotSatisfiable: boolean
}

function isHttps(url: URL): boolean {
  return url.protocol === 'https:'
}

function buildHeaders(options: ClientOptions, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
    ...(options.headers ?? {}),
    ...extra
  }
  // `accept-encoding: identity` is mandatory: a transparent gzip would make
  // byte offsets meaningless and silently corrupt every resumed file.
  headers['accept-encoding'] = 'identity'
  return headers
}

/** Wraps a socket-level request in a promise, applying timeouts and aborts. */
function sendRequest(
  url: URL,
  method: 'GET' | 'HEAD',
  headers: Record<string, string>,
  options: ClientOptions
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = isHttps(url) ? httpsRequest : httpRequest
    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps(url) ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      agent: isHttps(url) ? httpsAgent : httpAgent
    }

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    const req = send(requestOptions, (res) => {
      finish(() => resolve(res))
    })

    req.setTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
      req.destroy()
      finish(() =>
        reject(
          new EngineError({
            code: 'TIMEOUT',
            message: `Request to ${url.host} timed out after ${options.timeoutMs ?? REQUEST_TIMEOUT_MS}ms`,
            context: { host: url.host, path: url.pathname }
          })
        )
      )
    })

    req.on('error', (err) => {
      finish(() =>
        reject(
          new EngineError({
            code: 'NETWORK',
            message: `Request to ${url.host} failed: ${err.message}`,
            cause: err
          })
        )
      )
    })

    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy()
        finish(() => reject(new EngineError({ code: 'CANCELED', message: 'Request aborted' })))
      } else {
        options.signal.addEventListener(
          'abort',
          () => {
            req.destroy()
            finish(() => reject(new EngineError({ code: 'CANCELED', message: 'Request aborted' })))
          },
          { once: true }
        )
      }
    }

    // Both verbs must be finalised. Without this a GET is never actually
    // written to the socket and simply hangs until the timeout fires.
    req.end()
  })
}

/** Follows redirects manually so the final URL is observable and persistable. */
async function sendFollowingRedirects(
  initialUrl: string,
  method: 'GET' | 'HEAD',
  headers: Record<string, string>,
  options: ClientOptions
): Promise<{ res: IncomingMessage; finalUrl: string }> {
  let current = initialUrl
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = new URL(current)
    const res = await sendRequest(url, method, headers, options)

    const status = res.statusCode ?? 0
    const location = res.headers.location
    if (status < 300 || status >= 400 || !location) return { res, finalUrl: current }

    // Discard the redirect body so the socket can be reused.
    res.resume()
    const next = new URL(location, current)
    if (url.origin !== next.origin) {
      for (const name of Object.keys(headers)) {
        if (/^(authorization|cookie|proxy-authorization)$/i.test(name)) {
          delete headers[name]
        }
      }
    }
    current = next.toString()
    log.debug('Following redirect', {
      from: urlForDiagnostics(url.toString()),
      to: urlForDiagnostics(current),
      status
    })
  }

  throw new EngineError({
    code: 'NETWORK',
    message: `Exceeded ${maxRedirects} redirects starting at ${urlForDiagnostics(initialUrl)}`,
    retryable: false
  })
}

function urlForDiagnostics(value: string): string {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '[remote URL]'
  }
}

/** Translates an error status into a classified EngineError. */
function httpError(status: number, url: string, retryAfter?: string): EngineError {
  const code =
    status === 429
      ? 'HTTP_TOO_MANY_REQUESTS'
      : status >= 500
        ? 'HTTP_SERVER_ERROR'
        : status === 403 && retryAfter
          ? 'HTTP_TOO_MANY_REQUESTS'
          : 'HTTP_CLIENT_ERROR'

  const retryAfterMs = parseRetryAfter(retryAfter)
  const hint = retryAfterMs === null ? '' : ` (retry after ${Math.ceil(retryAfterMs / 1000)}s)`
  return new EngineError({
    code,
    message: `HTTP ${status} from ${urlForDiagnostics(url)}${hint}`,
    httpStatus: status,
    // 4xx other than 408/429 will not fix themselves.
    retryable: status >= 500 || status === 408 || status === 429,
    context: retryAfterMs === null ? undefined : { retryAfterMs }
  })
}

/**
 * Discovers the remote file's metadata.
 *
 * `HEAD` is tried first because it costs no bandwidth. A one-byte ranged
 * `GET` then verifies actual range support because some servers advertise it
 * in `HEAD` but ignore it for downloads.
 */
export async function probe(url: string, options: ClientOptions = {}): Promise<RemoteMetadata> {
  const headers = buildHeaders(options, {})
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS

  let res: IncomingMessage
  let finalUrl = url
  try {
    const result = await sendFollowingRedirects(url, 'HEAD', headers, { ...options, timeoutMs })
    res = result.res
    finalUrl = result.finalUrl
  } catch (err) {
    log.debug('HEAD probe failed, falling back to ranged GET', { url: urlForDiagnostics(url), error: err })
    return probeWithRangeRequest(url, { ...options, timeoutMs })
  }

  const status = res.statusCode ?? 0
  if (status === 405 || status === 501 || status === 403 || status < 200 || status >= 400) {
    res.resume()
    return probeWithRangeRequest(url, { ...options, timeoutMs })
  }

  const meta = readMetadata(res, finalUrl)
  res.resume()
  // HEAD metadata is not evidence that a server actually honours byte ranges.
  // Probe one byte with GET so the transfer mode is based on observed behavior.
  const ranged = await probeWithRangeRequest(url, { ...options, timeoutMs })
  return {
    ...meta,
    ...ranged,
    size: ranged.size ?? meta.size,
    etag: ranged.etag ?? meta.etag,
    lastModified: ranged.lastModified ?? meta.lastModified,
    contentType: ranged.contentType ?? meta.contentType,
    contentDisposition: ranged.contentDisposition ?? meta.contentDisposition
  }
}

/**
 * One-request probe: asks for byte 0 and reads metadata plus actual range
 * support. Used where a `HEAD` first would only add a round trip — for example
 * deciding whether an extension-less URL is a file, where the ranged `GET`
 * already answers that question and also verifies range support.
 */
export async function probeRange(url: string, options: ClientOptions = {}): Promise<RemoteMetadata> {
  return probeWithRangeRequest(url, { ...options, timeoutMs: options.timeoutMs ?? CONNECT_TIMEOUT_MS })
}

/** Requests byte 0 only and reads metadata plus actual range support. */
async function probeWithRangeRequest(url: string, options: ClientOptions): Promise<RemoteMetadata> {
  const headers = buildHeaders(options, { range: 'bytes=0-0' })
  const { res, finalUrl } = await sendFollowingRedirects(url, 'GET', headers, options)
  const status = res.statusCode ?? 0

  if (status < 200 || status >= 400) {
    res.resume()
    throw httpError(status, finalUrl, headerValue(res.headers['retry-after']))
  }

  const meta = readMetadata(res, finalUrl)
  const contentRange = headerValue(res.headers['content-range'])
  const rangeSupported =
    res.statusCode === 206 && typeof contentRange === 'string' && /^bytes\s+0-0\/\d+$/i.test(contentRange.trim())
  // Close the body immediately; we only wanted the headers.
  res.destroy()
  return { ...meta, acceptRanges: rangeSupported, rangeUnsupported: !rangeSupported }
}

/** Opens a non-range transfer. Such transfers always restart from byte zero. */
export async function openFile(request: ClientOptions & { url: string }): Promise<RangeResponse> {
  const headers = buildHeaders(request, {})
  const { res, finalUrl } = await sendFollowingRedirects(request.url, 'GET', headers, request)
  const status = res.statusCode ?? 0
  if (status < 200 || status >= 300) {
    const retryAfter = headerValue(res.headers['retry-after'])
    res.resume()
    throw httpError(status, finalUrl, retryAfter)
  }
  if (status !== 200) {
    res.destroy()
    throw new EngineError({
      code: 'NETWORK',
      message: `Expected a full-file response but server returned HTTP ${status}`,
      retryable: true
    })
  }

  const lengthHeader = headerValue(res.headers['content-length'])
  const contentLength = lengthHeader === undefined ? 0 : Number.parseInt(lengthHeader, 10)
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    res.destroy()
    throw new EngineError({
      code: 'NETWORK',
      message: 'Server returned an invalid Content-Length for a full-file transfer',
      retryable: true
    })
  }

  return {
    status,
    headers: res.headers,
    stream: res,
    contentLength,
    totalSize: contentLength || null,
    rangeHonored: false,
    finalUrl,
    rangeNotSatisfiable: false
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function readMetadata(res: IncomingMessage, finalUrl: string): RemoteMetadata {
  const headers = res.headers
  const contentRange = headers['content-range']
  let totalSize: number | null = null

  if (typeof contentRange === 'string') {
    const match = /\/(\d+)\s*$/.exec(contentRange)
    if (match?.[1]) totalSize = Number.parseInt(match[1], 10)
  }
  if (totalSize === null) {
    const length = headers['content-length']
    const parsed = headerValue(length)
    // For a 200 response, Content-Length is the file size. For a 206 it is the
    // size of the returned slice, which the Content-Range would have told us.
    if (parsed && res.statusCode === 200) totalSize = Number.parseInt(parsed, 10)
    if (Number.isNaN(totalSize)) totalSize = null
  }

  const acceptRangesHeader = headerValue(headers['accept-ranges'])?.toLowerCase() ?? ''
  const acceptRanges = acceptRangesHeader.includes('bytes') || res.statusCode === 206

  return {
    finalUrl,
    size: totalSize,
    acceptRanges,
    etag: headerValue(headers['etag']) ?? null,
    lastModified: headerValue(headers['last-modified']) ?? null,
    contentType: headerValue(headers['content-type']) ?? null,
    contentDisposition: headerValue(headers['content-disposition']) ?? null,
    rangeUnsupported: res.statusCode === 200 && acceptRangesHeader === ''
  }
}

export async function openRange(request: RangeRequest): Promise<RangeResponse> {
  const { start, end, etag, lastModified } = request
  const extra: Record<string, string> = { range: `bytes=${start}-${end}` }

  // `If-Range` makes the server fall back to a full 200 if the entity changed,
  // which we then reject rather than splice mismatched bytes together.
  // A weak ETag must never be sent (see selectIfRangeValidator): the server
  // would correctly ignore it, downgrade to 200, and we would fail or corrupt.
  const validator = selectIfRangeValidator(etag, lastModified)
  if (validator.droppedWeakETag) {
    log.warn('Dropping weak ETag from If-Range; resuming without a validator', {
      url: request.url,
      etag
    })
  }
  if (validator.value) extra['if-range'] = validator.value
  else if (etag ?? lastModified) {
    // Only weak/absent validators existed: say so once per request so a
    // silent downgrade to "size check only" is visible in the logs.
    log.debug('No usable If-Range validator for range request', { url: urlForDiagnostics(request.url) })
  }

  const headers = buildHeaders(request, extra)
  const { res, finalUrl } = await sendFollowingRedirects(request.url, 'GET', headers, request)
  const status = res.statusCode ?? 0

  if (status === 416) {
    res.resume()
    return {
      status,
      headers: res.headers,
      stream: res,
      contentLength: 0,
      totalSize: null,
      rangeHonored: false,
      finalUrl,
      rangeNotSatisfiable: true
    }
  }

  if (status < 200 || status >= 300) {
    const retryAfter = headerValue(res.headers['retry-after'])
    res.resume()
    throw httpError(status, finalUrl, retryAfter)
  }

  const rangeHonored = status === 206
  const contentRange = res.headers['content-range']

  let totalSize: number | null = null
  let reportedStart: number | null = null
  let reportedEnd: number | null = null
  if (typeof contentRange === 'string') {
    const parsed = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim())
    if (parsed) {
      reportedStart = Number.parseInt(parsed[1] as string, 10)
      reportedEnd = Number.parseInt(parsed[2] as string, 10)
      const totalToken = parsed[3] as string
      totalSize = totalToken === '*' ? null : Number.parseInt(totalToken, 10)
    }
  }

  // The server ignored our Range header. The caller must not write this body
  // at an offset, so signal it clearly instead of corrupting the file.
  if (!rangeHonored) {
    res.destroy()
    throw new EngineError({
      code: 'RANGE_UNSUPPORTED',
      message:
        `Server at ${finalUrl} ignored the Range header and returned the full file (HTTP ${status}). ` +
        'This file cannot be downloaded in parallel or resumed safely.',
      httpStatus: status,
      retryable: false,
      context: { finalUrl, requested: `bytes=${start}-${end}` }
    })
  }

  // A 206 without a usable Content-Range cannot be safely placed in the file.
  if (reportedStart === null || reportedEnd === null) {
    res.destroy()
    throw new EngineError({
      code: 'NETWORK',
      message: 'Server returned partial content without a valid Content-Range header',
      retryable: true,
      context: { finalUrl, requested: `bytes=${start}-${end}` }
    })
  }

  // Defensive: some servers return a shifted or wider 206 window. Trust nothing.
  if (reportedStart !== start || reportedEnd > end) {
    res.destroy()
    throw new EngineError({
      code: 'NETWORK',
      message: `Server returned bytes ${reportedStart}-${reportedEnd} but bytes=${start}-${end} was requested`,
      retryable: true,
      context: { finalUrl, reportedStart, reportedEnd, requestedStart: start, requestedEnd: end }
    })
  }

  const lengthHeader = headerValue(res.headers['content-length'])
  const rangeLength = reportedEnd - reportedStart + 1
  const parsedLength = lengthHeader === undefined ? null : Number.parseInt(lengthHeader, 10)
  if (parsedLength !== null && (!Number.isSafeInteger(parsedLength) || parsedLength !== rangeLength)) {
    res.destroy()
    throw new EngineError({
      code: 'NETWORK',
      message: 'Server returned inconsistent Content-Length and Content-Range headers',
      retryable: true,
      context: { finalUrl, contentLength: lengthHeader, rangeLength }
    })
  }
  const contentLength =
    parsedLength ?? rangeLength

  return {
    status,
    headers: res.headers,
    stream: res,
    contentLength,
    totalSize,
    rangeHonored,
    finalUrl,
    rangeNotSatisfiable: false
  }
}

/**
 * Verifies that a short-read is legitimate.
 * A 206 body shorter than the requested range is normal at the tail of a file
 * but suspicious elsewhere; the caller decides.
 */
export function isShortRead(expected: number, actual: number): boolean {
  return actual < expected
}

/** Consumes and discards a stream, swallowing errors. */
export async function drain(stream: Readable): Promise<void> {
  try {
    await pipeline(stream, async function* (source) {
      for await (const _chunk of source) {
        void _chunk
      }
    })
  } catch {
    /* discarding; errors are irrelevant */
  }
}

export { parseRetryAfter }
