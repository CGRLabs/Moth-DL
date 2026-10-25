/**
 * A real HTTP file server for integration tests.
 *
 * Deliberately configurable so the engine can be tested against the nasty
 * cases that actually break download managers:
 *  - servers that ignore `Range` and answer 200 with the whole body,
 *  - servers that close the socket mid-transfer,
 *  - servers that report a size but return truncated bodies,
 *  - servers that change the file between requests (ETag changes),
 *  - redirect chains and `Content-Disposition` filenames.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

export interface TestServerOptions {
  /** Serve this buffer. Mutate between requests to simulate a changed file. */
  body?: Buffer
  /** Honour Range requests with 206 (default true). */
  supportRanges?: boolean
  /** Send `Accept-Ranges: bytes`. */
  advertiseRanges?: boolean
  /** Number of leading requests to answer with 503 before succeeding. */
  failFirst?: number
  /** Retry-After value attached to leading 503 responses (default "0"). */
  retryAfter?: string
  /** Truncate every response body by this many bytes. */
  truncateBy?: number
  /** Destroy the socket after this many bytes (simulates a dropped connection). */
  dropAfterBytes?: number
  /** Drop only the first N response bodies; later retries succeed. */
  dropFirstResponses?: number
  /** Drop the first body for each of the first N aligned HTTP chunks. */
  dropFirstRangeChunks?: {
    count: number
    chunkSize: number
    afterBytes: number
  }
  /** Serve a redirect to this many hops before the real body. */
  redirectHops?: number
  /**
   * Answer these path prefixes with a small HTML document instead of the file,
   * so tests can tell a media page from a download link by response evidence.
   */
  htmlPaths?: readonly string[]
  /** `Content-Disposition` filename to advertise. */
  contentDisposition?: string
  /** ETag; a new value simulates a changed remote file. */
  etag?: string
  /** Never send Content-Length. */
  omitContentLength?: boolean
  /**
   * Send neither ETag nor Last-Modified, simulating a validator-less server.
   * Resume requests then carry no If-Range, which is exactly the failed-open
   * case the engine must handle by discarding unverifiable progress.
   */
  sendValidators?: boolean
}

export interface TestServer {
  url: string
  port: number
  /** Total bytes served so far, for assertions on "did it re-download?". */
  bytesServed: () => number
  /** How many requests were received. */
  requestCount: () => number
  /** Count of requests that were range requests. */
  rangeRequestCount: () => number
  droppedResponseCount: () => number
  setBody: (body: Buffer) => void
  setEtag: (etag: string) => void
  setFailFirst: (count: number) => void
  close: () => Promise<void>
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  let body = options.body ?? randomBytes(256 * 1024)
  let etag = options.etag ?? createHash('md5').update(body).digest('hex')
  let failFirst = options.failFirst ?? 0
  let bytesServed = 0
  let requestCount = 0
  let rangeRequests = 0
  let droppedResponses = 0
  const droppedRangeChunks = new Set<number>()

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1

    if (failFirst > 0) {
      failFirst -= 1
      res.writeHead(503, { 'retry-after': options.retryAfter ?? '0' })
      res.end('temporarily unavailable')
      return
    }

    let path = req.url ?? '/'
    // A redirect chain that preserves the Range header, which is what a real
    // CDN does. 302 would drop it and is a classic source of resume bugs.
    const hopToken = /^\/r(\d+)(?:\/|$)/.exec(path)?.[1]
    const hop = hopToken === undefined ? 0 : Number(hopToken)
    if (hop > 0) {
      res.writeHead(307, { location: `/r${hop - 1}/file.bin` })
      res.end()
      return
    }
    path = path.replace(/^\/r\d+(?:\/|$)/, '/')

    // A page route answers like a real web page: a document, no byte ranges.
    if (options.htmlPaths?.some((prefix) => path.startsWith(prefix))) {
      const document = '<!doctype html><title>Clip</title><div id="player"></div>'
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(document))
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      bytesServed += Buffer.byteLength(document)
      res.end(document)
      return
    }

    const rangeHeader = req.headers.range
    if (rangeHeader) rangeRequests += 1

    const lastModifiedValue = new Date(1700000000000).toUTCString()
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream'
    }
    if (options.sendValidators !== false) {
      headers['etag'] = etag
      headers['last-modified'] = lastModifiedValue
    }
    if (options.advertiseRanges !== false) headers['accept-ranges'] = 'bytes'
    if (options.contentDisposition) {
      headers['content-disposition'] = options.contentDisposition
    }

    // RFC 7233 §3.2: a mismatched If-Range (or a weak validator, which a
    // server MUST ignore) downgrades the response to an unconditional 200.
    // Honouring this lets tests prove the client never splices a 200 body
    // onto old ranges and never emits a weak validator.
    const rawIfRange = req.headers['if-range']
    const ifRange = Array.isArray(rawIfRange) ? rawIfRange[0] : rawIfRange
    let ifRangeOk = true
    if (typeof ifRange === 'string' && ifRange.length > 0) {
      const candidate = ifRange.trim()
      if (/^w\//i.test(candidate)) ifRangeOk = false
      else ifRangeOk = candidate === etag || candidate === lastModifiedValue
    }

    if (rangeHeader && options.supportRanges !== false && ifRangeOk) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim())
      if (match) {
        const start = Number.parseInt(match[1] as string, 10)
        const endToken = match[2] as string
        const requestedEnd = endToken === '' ? body.length - 1 : Number.parseInt(endToken, 10)
        const end = Math.min(requestedEnd, body.length - 1)
        if (start > body.length - 1) {
          res.writeHead(416, { 'content-range': `bytes */${body.length}` })
          res.end()
          return
        }
        const slice = body.subarray(start, end + 1)
        headers['content-range'] = `bytes ${start}-${end}/${body.length}`
        headers['content-length'] = String(slice.length)
        res.writeHead(206, headers)
        const rangeDrop = options.dropFirstRangeChunks
        const rangeChunk = rangeDrop ? Math.floor(start / rangeDrop.chunkSize) : -1
        const metadataProbe = start === 0 && end === 0
        const shouldDropRange =
          !metadataProbe &&
          rangeDrop !== undefined &&
          rangeChunk >= 0 &&
          rangeChunk < rangeDrop.count &&
          !droppedRangeChunks.has(rangeChunk)
        if (shouldDropRange) droppedRangeChunks.add(rangeChunk)
        writeBody(res, slice, metadataProbe, shouldDropRange ? rangeDrop?.afterBytes : undefined)
        return
      }
    }

    // No range, or ranges unsupported: the whole file.
    if (!options.omitContentLength) headers['content-length'] = String(body.length)
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    writeBody(res, body)
  })

  function writeBody(
    res: ServerResponse,
    buffer: Buffer,
    metadataProbe = false,
    rangeDropAfterBytes?: number
  ): void {
    let payload = buffer
    if (options.truncateBy && options.truncateBy > 0) {
      payload = buffer.subarray(0, Math.max(0, buffer.length - options.truncateBy))
    }
    const dropAfterBytes = options.dropAfterBytes
    const shouldDrop = !metadataProbe &&
      dropAfterBytes !== undefined &&
      (options.dropFirstResponses === undefined || droppedResponses < options.dropFirstResponses)
    const cutAfterBytes = rangeDropAfterBytes ?? (shouldDrop ? dropAfterBytes : undefined)
    if (!metadataProbe && cutAfterBytes !== undefined) {
      droppedResponses += 1
      const cut = Math.min(cutAfterBytes, payload.length)
      bytesServed += cut
      res.write(payload.subarray(0, cut))
      // Kill the socket mid-body, which must look like a network error.
      res.socket?.destroy()
      return
    }
    bytesServed += payload.length
    res.end(payload)
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}/file.bin`,
    port: address.port,
    bytesServed: () => bytesServed,
    requestCount: () => requestCount,
    rangeRequestCount: () => rangeRequests,
    droppedResponseCount: () => droppedResponses,
    setBody: (next) => {
      body = next
      etag = createHash('md5').update(body).digest('hex')
    },
    setEtag: (next) => {
      etag = next
    },
    setFailFirst: (count) => {
      failFirst = count
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

/** Deterministic, compressible content with a known digest. */
export function makeBody(size: number, seed = 0): Buffer {
  const out = Buffer.allocUnsafe(size)
  let state = seed >>> 0
  for (let i = 0; i < size; i += 1) {
    // xorshift keeps the buffer compressible enough to be realistic while
    // still being fully deterministic across runs.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    out[i] = state & 0xff
  }
  return out
}
