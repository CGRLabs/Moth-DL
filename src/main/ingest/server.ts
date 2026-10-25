/**
 * Authenticated loopback endpoints for browser handoff and local agent control.
 *
 * Security model — browser pages can reach localhost, so every request is
 * treated as hostile:
 *
 *  - Binds to `127.0.0.1` only. Never `0.0.0.0`; a download manager that
 *    accepts commands from the LAN is a remote code execution vector.
 *  - Every request must carry the pairing token, which is 32 bytes of CSPRNG
 *    output generated once per install. A random web page that can talk to
 *    localhost still cannot guess it.
 *  - Only `http`/`https` URLs are accepted. This is not a proxy: it refuses
 *    `file:`, `javascript:`, `data:` and UNC paths, and it never fetches
 *    anything itself — it only hands the URL to the engine.
 *  - Cookie and `Referer` headers are accepted from the extension because
 *    downloads from authenticated sites need them, but they are stored per
 *    download and never logged.
 *
 * The server only runs while the app is running, which is exactly the lifetime
 * a download manager needs to accept work.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  AddDownloadRequest,
  AddDownloadResult,
  Download,
  DownloadId,
  DownloadSnapshot,
  EngineStats,
  AudioOutputFormat,
  VideoCaptureFormat,
  VideoQuality
} from '@shared/types.js'
import type { DiskRescanResult } from '@shared/ipc.js'
import { addDownloadSchema, downloadIdSchema } from '@shared/schemas.js'
import { getLogger } from '../util/logger.js'
import { EngineError } from '../util/errors.js'

const log = getLogger('ingest')

/** Default port; overridable because a busy machine may already hold it. */
export const DEFAULT_INGEST_PORT = 24678
const MAX_PORT_ATTEMPTS = 12
const MAX_BODY_BYTES = 64 * 1024
const TOKEN_BYTES = 32

export interface IngestRequest {
  url: string
  filename?: string
  referer?: string
  cookies?: string
  userAgent?: string
  /** Set by the extension when the user holds a modifier key. */
  autoStart?: boolean
  /**
   * Requested media shape for page grabs. Absent means video (backward
   * compatible); anything else is a 400.
   */
  format?: VideoCaptureFormat
  videoQuality?: VideoQuality
  audioFormat?: AudioOutputFormat
}

export interface IngestServerOptions {
  port?: number
  token: string
  /** Signed companion extension ID allowed to request automatic local pairing. */
  extensionId?: string | null
  onDownload: (request: IngestRequest) => Promise<{ id: string }>
  agent?: AgentApi
  /** Called when the port actually bound differs from the requested one. */
  onPort: (port: number) => void
  /**
   * Read-only views for the agent/test CLI (`scripts/moth.mjs`). Absent
   * means 404 — the browser extension needs neither, so surface stays minimal.
   */
  onList?: () => Promise<unknown>
  onGet?: (id: string) => Promise<unknown>
}

export interface AgentApi {
  stats: () => EngineStats
  list: () => DownloadSnapshot[]
  get: (id: DownloadId) => DownloadSnapshot | null
  add: (request: AddDownloadRequest) => Promise<AddDownloadResult>
  pause: (id: DownloadId) => Promise<Download>
  resume: (id: DownloadId) => Promise<Download>
  retry: (id: DownloadId) => Download
  cancel: (id: DownloadId) => Promise<Download>
  logs: (lines: number) => Promise<string[]>
  rescan: (id?: DownloadId) => Promise<DiskRescanResult>
}

export interface IngestServer {
  port: number
  close: () => Promise<void>
}

/** Generates a fresh pairing token. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/**
 * Returns a usable token, minting one the first time the app runs.
 * The result is always 64 hex characters, which is what `ingestTokenSchema`
 * enforces, so a corrupt stored value can never reach the server.
 */
export function ensureToken(existing: string): string {
  if (/^[a-f0-9]{64}$/i.test(existing)) return existing
  return generateToken()
}

/** Constant-time token comparison, so timing cannot leak the secret. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sendJson(res: ServerResponse, status: number, body: unknown, allowedOrigin = '*'): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    // The extension runs on its own origin, so CORS must be permissive here.
    // The token is the actual authentication; this only enables the request.
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'content-type,x-moth-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  })
  res.end(payload)
}

/** Reads a bounded request body. Over-long bodies are rejected, not truncated. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new EngineError({ code: 'INTERNAL', message: 'Request body too large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Validates the shape of an ingest request. Throws with a readable message. */
export function validateIngestRequest(input: unknown): IngestRequest {
  if (typeof input !== 'object' || input === null) {
    throw new EngineError({ code: 'INTERNAL', message: 'Body must be a JSON object' })
  }
  const record = input as Record<string, unknown>

  const url = record['url']
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096) {
    throw new EngineError({ code: 'INTERNAL', message: 'A "url" string is required' })
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new EngineError({ code: 'INTERNAL', message: `Not a valid URL: ${url}` })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EngineError({
      code: 'INTERNAL',
      message: `Refusing ${parsed.protocol} — only http and https are supported`
    })
  }

  const str = (key: string, max = 2048): string | undefined => {
    const value = record[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') return undefined
    return value.slice(0, max)
  }

  const formatRaw = record['format']
  let format: VideoCaptureFormat | undefined
  if (formatRaw !== undefined && formatRaw !== null) {
    if (formatRaw !== 'video' && formatRaw !== 'audio') {
      throw new EngineError({ code: 'INTERNAL', message: 'Invalid "format" — expected "video" or "audio"' })
    }
    format = formatRaw
  }
  const videoQualityRaw = record['videoQuality']
  let videoQuality: VideoQuality | undefined
  if (videoQualityRaw !== undefined && videoQualityRaw !== null) {
    if (
      videoQualityRaw !== 360 &&
      videoQualityRaw !== 480 &&
      videoQualityRaw !== 720 &&
      videoQualityRaw !== 1080 &&
      videoQualityRaw !== 1440 &&
      videoQualityRaw !== 2160
    ) {
      throw new EngineError({
        code: 'INTERNAL',
        message: 'Invalid "videoQuality" — expected 360, 480, 720, 1080, 1440, or 2160'
      })
    }
    videoQuality = videoQualityRaw
  }
  const audioFormatRaw = record['audioFormat']
  let audioFormat: AudioOutputFormat | undefined
  if (audioFormatRaw !== undefined && audioFormatRaw !== null) {
    if (audioFormatRaw !== 'source' && audioFormatRaw !== 'mp3') {
      throw new EngineError({
        code: 'INTERNAL',
        message: 'Invalid "audioFormat" — expected "source" or "mp3"'
      })
    }
    audioFormat = audioFormatRaw
  }

  return {
    url,
    filename: str('filename', 255),
    referer: str('referer'),
    cookies: str('cookies', 8192),
    userAgent: str('userAgent', 512),
    autoStart: record['autoStart'] !== false,
    ...(format !== undefined ? { format } : {}),
    ...(videoQuality !== undefined ? { videoQuality } : {}),
    ...(audioFormat !== undefined ? { audioFormat } : {})
  }
}

export async function startIngestServer(options: IngestServerOptions): Promise<IngestServer> {
  const requestedPort = options.port ?? DEFAULT_INGEST_PORT
  let boundPort = requestedPort

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // CORS preflight.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type,x-moth-token',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-max-age': '600'
      })
      res.end()
      return
    }

    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && requestUrl.pathname === '/api/v1/pair') {
      const extensionOrigin = options.extensionId ? `chrome-extension://${options.extensionId}` : null
      const origin = req.headers.origin
      if (extensionOrigin && origin === extensionOrigin) {
        sendJson(res, 200, { ok: true, data: { port: boundPort, token: options.token } }, extensionOrigin)
      } else {
        log.warn('Rejected automatic extension pairing request', {
          origin: origin ?? '[missing]',
          hasExtensionIdentity: extensionOrigin !== null
        })
        sendJson(res, 403, { ok: false, error: 'Pairing is only available to the signed browser extension' })
      }
      return
    }

    const provided = req.headers['x-moth-token']
    const token = Array.isArray(provided) ? provided[0] : provided
    if (!token || !tokenMatches(token, options.token)) {
      log.warn('Rejected ingest request with a bad token', { from: req.socket.remoteAddress })
      sendJson(res, 401, { ok: false, error: 'Invalid or missing X-Moth-Token' })
      return
    }

    // Health check, used by the extension to confirm it is talking to Moth.
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/')) {
      sendJson(res, 200, { ok: true, app: 'moth-dlm', version: 1 })
      return
    }

    if (requestUrl.pathname.startsWith('/api/v1/')) {
      if (!options.agent) {
        sendJson(res, 404, { ok: false, error: 'Not found' })
      } else {
        await handleAgentApi(req, res, requestUrl, options.agent)
      }
      return
    }

    // Download list for the agent/test CLI. Same token gate as everything
    // else on this server; loopback-only still applies.
    if (req.method === 'GET' && req.url === '/downloads') {
      if (!options.onList) {
        sendJson(res, 404, { ok: false, error: 'Not found' })
        return
      }
      sendJson(res, 200, { ok: true, downloads: await options.onList() })
      return
    }

    // Single download view. The id shape is validated so garbage never
    // reaches the database layer (which binds parameters anyway).
    const getMatch = /^\/downloads\/([A-Za-z0-9-]{1,64})$/.exec(req.url ?? '')
    if (req.method === 'GET' && getMatch?.[1]) {
      if (!options.onGet) {
        sendJson(res, 404, { ok: false, error: 'Not found' })
        return
      }
      const download = await options.onGet(getMatch[1])
      if (download === null || download === undefined) {
        sendJson(res, 404, { ok: false, error: 'Unknown download id' })
        return
      }
      sendJson(res, 200, { ok: true, download })
      return
    }

    if (req.method !== 'POST' || req.url !== '/ingest') {
      sendJson(res, 404, { ok: false, error: 'Not found' })
      return
    }

    async function handleAgentApi(
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
      api: AgentApi
    ): Promise<void> {
      const path = url.pathname
      try {
        if (req.method === 'GET' && path === '/api/v1/status') {
          sendJson(res, 200, { ok: true, data: { app: 'moth-dlm', version: 1, stats: api.stats() } })
          return
        }
        if (req.method === 'GET' && path === '/api/v1/downloads') {
          sendJson(res, 200, { ok: true, data: api.list().map(publicDownload) })
          return
        }
        if (req.method === 'POST' && path === '/api/v1/downloads') {
          const input = addDownloadSchema.safeParse(JSON.parse(await readBody(req)) as unknown)
          if (!input.success) {
            sendJson(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: input.error.message } })
            return
          }
          sendJson(res, 201, { ok: true, data: await api.add(input.data) })
          return
        }
        if (req.method === 'GET' && path === '/api/v1/logs') {
          const parsedLines = Number.parseInt(url.searchParams.get('lines') ?? '100', 10)
          if (!Number.isInteger(parsedLines) || parsedLines < 1 || parsedLines > 500) {
            sendJson(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'lines must be between 1 and 500' } })
            return
          }
          sendJson(res, 200, { ok: true, data: await api.logs(parsedLines) })
          return
        }
        if (req.method === 'POST' && path === '/api/v1/maintenance/rescan') {
          const rawBody = await readBody(req)
          let id: DownloadId | undefined
          if (rawBody.trim()) {
            const input = JSON.parse(rawBody) as unknown
            if (typeof input !== 'object' || input === null || Array.isArray(input)) {
              sendJson(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'Body must be an object' } })
              return
            }
            const record = input as Record<string, unknown>
            if (record['id'] !== undefined) {
              const parsedId = downloadIdSchema.safeParse(record['id'])
              if (!parsedId.success) {
                sendJson(res, 400, { ok: false, error: { code: 'INVALID_ID', message: 'Invalid download id' } })
                return
              }
              id = parsedId.data
            }
          }
          sendJson(res, 200, { ok: true, data: await api.rescan(id) })
          return
        }

        const match = /^\/api\/v1\/downloads\/([^/]+)(?:\/(pause|resume|retry|cancel))?$/.exec(path)
        if (match) {
          const parsedId = downloadIdSchema.safeParse(decodeURIComponent(match[1] ?? ''))
          if (!parsedId.success) {
            sendJson(res, 400, { ok: false, error: { code: 'INVALID_ID', message: 'Invalid download id' } })
            return
          }
          const id = parsedId.data
          const action = match[2]
          if (req.method === 'GET' && !action) {
            const download = api.get(id)
            sendJson(
              res,
              download ? 200 : 404,
              download
                ? { ok: true, data: publicDownload(download) }
                : { ok: false, error: { code: 'NOT_FOUND', message: 'Download not found' } }
            )
            return
          }
          if (req.method === 'POST' && action) {
            const result =
              action === 'pause'
                ? await api.pause(id)
                : action === 'resume'
                  ? await api.resume(id)
                  : action === 'retry'
                    ? api.retry(id)
                    : await api.cancel(id)
            sendJson(res, 200, { ok: true, data: publicDownload(api.get(id) ?? result) })
            return
          }
        }

        sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } })
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const status = /not found/i.test(error.message)
          ? 404
          : err instanceof EngineError
            ? err.retryable
              ? 503
              : 400
            : 500
        sendJson(res, status, {
          ok: false,
          error: {
            code: err instanceof EngineError ? err.code : 'REQUEST_FAILED',
            message: error.message
          }
        })
      }
    }

    /** Excludes private request headers and redacts credentials embedded in URLs. */
    function publicDownload(download: DownloadSnapshot | Download): Record<string, unknown> {
      const { headers: _headers, ...safe } = download
      return {
        ...safe,
        url: redactUrl(safe.url),
        finalUrl: safe.finalUrl ? redactUrl(safe.finalUrl) : null
      }
    }

    function redactUrl(raw: string): string {
      try {
        const url = new URL(raw)
        if (url.username) url.username = 'REDACTED'
        if (url.password) url.password = 'REDACTED'
        for (const key of [...url.searchParams.keys()]) {
          if (/token|secret|auth|api.?key|signature|(^|[_-])sig([_-]|$)|credential|password|session/i.test(key)) {
            url.searchParams.set(key, 'REDACTED')
          }
        }
        return url.toString()
      } catch {
        return '[invalid-url]'
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(req))
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' })
      return
    }

    try {
      const request = validateIngestRequest(parsed)
      const result = await options.onDownload(request)
      log.info('Accepted download from the browser extension', {
        url: request.url,
        id: result.id
      })
      sendJson(res, 200, { ok: true, id: result.id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('Ingest request rejected', { message })
      sendJson(res, 400, { ok: false, error: message })
    }
  }

  const server: Server = createServer((req, res) => {
    void handler(req, res).catch((err) => {
      log.error('Ingest handler threw', { error: err })
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal error' })
      else res.end()
    })
  })

  // Loopback only. This is the single most important line in the file.
  const bind = async (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError)
        reject(err)
      }
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve()
      })
    })

  let port = requestedPort
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    try {
      await bind(port)
      break
    } catch (err) {
      lastError = err
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      port += 1
    }
  }
  if (!server.listening) {
    throw new EngineError({
      code: 'INTERNAL',
      message: `Could not bind an ingest port (tried ${MAX_PORT_ATTEMPTS} ports): ${String(lastError)}`,
      cause: lastError
    })
  }
  if (port === 0) {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new EngineError({ code: 'INTERNAL', message: 'Could not determine the bound ingest port' })
    }
    port = address.port
  }

  // Report the real bound port (matters when 0 was requested in tests).
  const address = server.address()
  if (address !== null && typeof address === 'object') port = address.port
  boundPort = port

  options.onPort(port)
  log.info('Ingest server listening', { host: '127.0.0.1', port })

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}
