#!/usr/bin/env node

import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pathToFileURL } from 'node:url'

const MAX_REDIRECTS = 8
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 5
const CHECKPOINT_BYTES = 1024 * 1024
const SECRET_HEADERS = /^(authorization|cookie|proxy-authorization)$/i
const SHARED_LOCK = Symbol('shared-download-lock')

export class DownloadError extends Error {
  constructor(message, { retryable = false, status = null, code = 'DOWNLOAD_ERROR' } = {}) {
    super(message)
    this.name = 'DownloadError'
    this.retryable = retryable
    this.status = status
    this.code = code
  }
}

function safeUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownloadError('Only HTTP and HTTPS URLs are supported', { code: 'INVALID_URL' })
  }
  if (url.username || url.password) {
    throw new DownloadError('Credentials in URLs are not supported; use a site-provided signed link', {
      code: 'INVALID_URL'
    })
  }
  url.hash = ''
  return url
}

function diagnosticUrl(value) {
  const url = safeUrl(value)
  url.search = ''
  return url.toString()
}

function strongEtag(value) {
  return typeof value === 'string' && /^"(?:[\x21\x23-\x7E\x80-\xFF])*"$/.test(value.trim())
}

function header(headers, name) {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value ?? '')
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null
  return { start, end, total }
}

function httpError(response, url) {
  const status = response.statusCode ?? 0
  const retryAfter = Number.parseInt(header(response.headers, 'retry-after') ?? '', 10)
  const retryAfterMs = Number.isFinite(retryAfter) ? Math.min(Math.max(0, retryAfter * 1000), 300_000) : 0
  const error = new DownloadError(
    `HTTP ${status} from ${diagnosticUrl(url)}`,
    { status, retryable: status === 408 || status === 429 || status >= 500, code: 'HTTP_ERROR' }
  )
  error.retryAfterMs = retryAfterMs
  return error
}

function requestOnce(url, headers, options) {
  const { timeoutMs, signal } = options
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = safeUrl(url)
    const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const startedAt = Date.now()
    emitDebug(options, 'http.request', {
      method: 'GET',
      host: parsed.host,
      path: parsed.pathname,
      range: headers.range ?? null,
      ifRange: Boolean(headers['if-range']),
      headers: Object.keys(headers).map((name) => name.toLowerCase()).sort()
    })
    let connectTimer
    let abortHandler
    const cleanup = () => {
      clearTimeout(connectTimer)
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
    }
    const request = send(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { 'accept-encoding': 'identity', ...headers }
      },
      (response) => {
        response.once('end', cleanup)
        response.once('close', cleanup)
        emitDebug(options, 'http.response', {
          host: parsed.host,
          status: response.statusCode ?? 0,
          contentLength: header(response.headers, 'content-length') ?? null,
          durationMs: Date.now() - startedAt
        })
        resolvePromise(response)
      }
    )
    const fail = (error) => {
      cleanup()
      emitDebug(options, 'http.error', {
        host: parsed.host,
        code: error instanceof DownloadError ? error.code : (error?.code ?? 'NETWORK_ERROR')
      })
      rejectPromise(
        error instanceof DownloadError
          ? error
          : new DownloadError(`Request to ${parsed.host} failed: ${error.message}`, {
              retryable: true,
              code: 'NETWORK_ERROR'
            })
      )
    }
    connectTimer = setTimeout(() => {
      request.destroy(new DownloadError(`Connection to ${parsed.host} timed out`, {
        retryable: true,
        code: 'TIMEOUT'
      }))
    }, timeoutMs)
    connectTimer.unref?.()
    request.setTimeout(timeoutMs, () => {
      request.destroy(new DownloadError(`Request to ${parsed.host} timed out`, {
        retryable: true,
        code: 'TIMEOUT'
      }))
    })
    request.once('error', fail)
    if (signal) {
      if (signal.aborted) request.destroy(new DownloadError('Download cancelled', { code: 'CANCELLED' }))
      else {
        abortHandler = () => request.destroy(new DownloadError('Download cancelled', { code: 'CANCELLED' }))
        signal.addEventListener('abort', abortHandler, { once: true })
      }
    }
    request.end()
  })
}

async function requestFollowingRedirects(initialUrl, initialHeaders, options) {
  let current = safeUrl(initialUrl).toString()
  let headers = { ...initialHeaders }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const previous = safeUrl(current)
    const response = await requestOnce(current, headers, options)
    const location = header(response.headers, 'location')
    const status = response.statusCode ?? 0
    if (status < 300 || status >= 400 || !location) return { response, url: current }

    response.resume()
    const next = safeUrl(new URL(location, current).toString())
    const originChanged = previous.origin !== next.origin
    const credentialsRemoved = originChanged
      ? Object.keys(headers).filter((name) => SECRET_HEADERS.test(name)).map((name) => name.toLowerCase())
      : []
    if (originChanged) {
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADERS.test(name)))
    }
    emitDebug(options, 'http.redirect', {
      status,
      from: diagnosticUrl(current),
      to: diagnosticUrl(next.toString()),
      originChanged,
      credentialsRemoved
    })
    current = next.toString()
  }
  throw new DownloadError(`Too many redirects from ${diagnosticUrl(initialUrl)}`, { code: 'REDIRECT_LIMIT' })
}

async function probeUrl(url, headers, options) {
  const { response, url: finalUrl } = await requestFollowingRedirects(
    url,
    { ...headers, range: 'bytes=0-0' },
    options
  )
  const status = response.statusCode ?? 0
  const etag = header(response.headers, 'etag') ?? null
  if (status === 206) {
    const range = parseContentRange(header(response.headers, 'content-range'))
    if (!range || range.start !== 0 || range.end !== 0) {
      response.destroy()
      throw new DownloadError('Server returned an invalid range during link check', {
        retryable: true,
        code: 'INVALID_RANGE'
      })
    }
    response.destroy()
    emitDebug(options, 'download.probed', {
      host: safeUrl(finalUrl).host,
      size: range.total,
      rangeSupport: true,
      strongEtag: strongEtag(etag)
    })
    return {
      url: finalUrl,
      size: range.total,
      etag,
      ranges: true,
      fullResponse: null
    }
  }
  if (status === 200) {
    const length = Number.parseInt(header(response.headers, 'content-length') ?? '', 10)
    return {
      url: finalUrl,
      size: Number.isSafeInteger(length) && length >= 0 ? length : null,
      etag,
      ranges: false,
      fullResponse: response
    }
  }
  response.resume()
  throw httpError(response, finalUrl)
}

async function requestWholeFile(url, headers, options) {
  const { response, url: finalUrl } = await requestFollowingRedirects(url, headers, options)
  if (response.statusCode !== 200) {
    response.resume()
    throw httpError(response, finalUrl)
  }
  const length = Number.parseInt(header(response.headers, 'content-length') ?? '', 10)
  return {
    response,
    url: finalUrl,
    size: Number.isSafeInteger(length) && length >= 0 ? length : null,
    etag: header(response.headers, 'etag') ?? null
  }
}

async function loadState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'))
    if (
      parsed.version !== 1 ||
      typeof parsed.url !== 'string' ||
      typeof parsed.size !== 'number' ||
      !Number.isSafeInteger(parsed.size) ||
      parsed.size < 0
    ) {
      throw new Error('invalid download state')
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new DownloadError(`Cannot read download state: ${error.message}`, { code: 'STATE_INVALID' })
  }
}

async function saveState(statePath, state) {
  const temporary = `${statePath}.${process.pid}.tmp`
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, statePath)
}

async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

async function writeResponse(response, partialPath, statePath, state, start, onProgress, debug) {
  const file = await open(partialPath, start === 0 ? 'w' : 'r+')
  let offset = start
  let sinceCheckpoint = 0
  try {
    if (start > 0) await file.truncate(start)
    for await (const data of response) {
      let written = 0
      while (written < data.length) {
        const result = await file.write(data, written, data.length - written, offset + written)
        if (result.bytesWritten === 0) throw new DownloadError('Writing the partial file made no progress', {
          retryable: true,
          code: 'FILE_WRITE'
        })
        written += result.bytesWritten
      }
      offset += data.length
      sinceCheckpoint += data.length
      onProgress?.({ bytes: offset, total: state.size })
      if (state.size !== null && offset > state.size) {
        throw new DownloadError('Server sent more bytes than the advertised file size', {
          code: 'SIZE_MISMATCH'
        })
      }
      if (sinceCheckpoint >= CHECKPOINT_BYTES) {
        await file.sync()
        await saveState(statePath, state)
        debug?.('download.checkpoint', { bytes: offset, total: state.size })
        sinceCheckpoint = 0
      }
    }
    await file.sync()
    await saveState(statePath, state)
    debug?.('download.stream-ended', { bytes: offset, total: state.size })
  } catch (error) {
    await file.sync().catch(() => {})
    await file.close()
    await saveState(statePath, state).catch(() => {})
    debug?.('download.stream-interrupted', {
      bytes: offset,
      total: state.size,
      code: error instanceof DownloadError ? error.code : (error?.code ?? 'NETWORK_ERROR')
    })
    if (error instanceof DownloadError) throw error
    throw new DownloadError(`Transfer stream failed: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: true,
      code: 'NETWORK_ERROR'
    })
  }
  await file.close()
  return offset
}

async function fileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function equalDigest(actual, expected) {
  if (!/^[a-f\d]{64}$/i.test(expected ?? '')) {
    throw new DownloadError('Expected SHA-256 must be exactly 64 hexadecimal characters', {
      code: 'INVALID_CHECKSUM'
    })
  }
  const left = Buffer.from(actual, 'hex')
  const right = Buffer.from(expected, 'hex')
  return timingSafeEqual(left, right)
}

async function promote(partialPath, outputPath) {
  try {
    await link(partialPath, outputPath)
    await unlink(partialPath)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new DownloadError(`Output already exists: ${outputPath}`, { code: 'OUTPUT_EXISTS' })
    }
    throw new DownloadError(`Could not safely create the final file: ${error.message}`, {
      code: 'PROMOTION_FAILED'
    })
  }
}

function emitEvent(json, event) {
  if (json) process.stdout.write(`${JSON.stringify(event)}\n`)
}

function emitDebug(options, event, fields = {}) {
  if (typeof options?.debug === 'function') {
    options.debug(event, fields)
    return
  }
  if (options?.debug !== true) return
  const line = JSON.stringify({ event, ...fields })
  process.stderr.write(options.json ? `${line}\n` : `[debug] ${line}\n`)
}

async function waitForRetry(delay, signal) {
  if (signal?.aborted) throw new DownloadError('Download cancelled', { code: 'CANCELLED' })
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolvePromise()
    }, delay)
    timer.unref?.()
    const cancel = () => {
      clearTimeout(timer)
      rejectPromise(new DownloadError('Download cancelled', { code: 'CANCELLED' }))
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

async function retryOperation(operation, { retries, signal, json, debug }) {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new DownloadError('Download cancelled', { code: 'CANCELLED' })
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof DownloadError) || !error.retryable || attempt >= retries) throw error
      emitEvent(json, {
        event: 'retry',
        attempt: attempt + 1,
        code: error.code,
        message: error.message
      })
      const delay = Math.max(error.retryAfterMs ?? 0, Math.min(30_000, 500 * 2 ** attempt))
      debug?.('download.retry', { attempt: attempt + 1, code: error.code, delayMs: delay })
      await waitForRetry(delay, signal)
    }
  }
}

function displayProgress(json, progress) {
  if (json) emitEvent(true, { event: 'progress', ...progress })
  else if (progress.total !== null) {
    const percent = progress.total === 0 ? 100 : Math.min(100, (progress.bytes / progress.total) * 100)
    process.stderr.write(`\r${percent.toFixed(1)}%  ${progress.bytes}/${progress.total} bytes`)
  } else {
    process.stderr.write(`\r${progress.bytes} bytes`)
  }
}

export async function downloadFile(urlInput, outputInput, options = {}) {
  const url = safeUrl(urlInput).toString()
  const outputPath = resolve(outputInput)
  const partialPath = `${outputPath}.part`
  const statePath = `${partialPath}.json`
  const lockPath = `${partialPath}.lock`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const json = options.json ?? false
  const headers = options.headers ?? {}
  const onProgress = options.onProgress ?? ((progress) => displayProgress(json, progress))
  const debug = (event, fields) => emitDebug(options, event, fields)
  let lock = options[SHARED_LOCK] ?? null
  const ownsLock = !lock

  await mkdir(dirname(outputPath), { recursive: true })
  if (ownsLock) {
    try {
      lock = await open(lockPath, 'wx')
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new DownloadError(`Another download is using ${outputPath}`, { code: 'DOWNLOAD_LOCKED' })
      }
      throw error
    }
  }

  try {
    try {
      await stat(outputPath)
      throw new DownloadError(`Output already exists: ${outputPath}`, { code: 'OUTPUT_EXISTS' })
    } catch (error) {
      if (error instanceof DownloadError) throw error
      if (error?.code !== 'ENOENT') throw error
    }
    const state = await loadState(statePath)
    const partialSize = await fileSize(partialPath)
    let transfer = state && state.url === url ? state : null
    let pendingFullResponse = null
    debug('download.state-loaded', {
      savedState: Boolean(state),
      matchingUrl: Boolean(transfer),
      partialBytes: partialSize,
      resumable: Boolean(transfer?.ranges && strongEtag(transfer?.etag))
    })
    if (!transfer && partialSize > 0) {
      const stale = await open(partialPath, 'w')
      await stale.close()
    }
    let received = transfer ? partialSize : 0

    if (
      !transfer ||
      !transfer.ranges ||
      !strongEtag(transfer.etag) ||
      received > transfer.size
    ) {
      const probe = await retryOperation(
        () => probeUrl(url, headers, { timeoutMs, signal: options.signal, debug, json }),
        { retries, signal: options.signal, json, debug }
      )
      transfer = {
        version: 1,
        url,
        finalUrl: probe.url,
        size: probe.size,
        etag: probe.etag,
        ranges: probe.ranges,
        expectedSha256: options.sha256 ?? null
      }
      if (transfer.ranges && !strongEtag(transfer.etag)) transfer.ranges = false
      await saveState(statePath, transfer)
      debug('download.source-selected', {
        host: safeUrl(transfer.finalUrl).host,
        size: transfer.size,
        ranges: transfer.ranges,
        strongEtag: strongEtag(transfer.etag)
      })
      pendingFullResponse = probe.fullResponse
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        if (!transfer.ranges || !strongEtag(transfer.etag)) {
          debug('download.resume-reset', {
            reason: !transfer.ranges ? 'server-does-not-support-ranges' : 'missing-strong-etag'
          })
          if (received > 0) {
            const file = await open(partialPath, 'w')
            await file.close()
            received = 0
          }
          const fresh = pendingFullResponse
            ? {
                response: pendingFullResponse,
                url: transfer.finalUrl,
                size: transfer.size,
                etag: transfer.etag
              }
            : await requestWholeFile(transfer.url, headers, { timeoutMs, signal: options.signal, debug, json })
          pendingFullResponse = null
          transfer = {
            ...transfer,
            finalUrl: fresh.url,
            size: fresh.size,
            etag: fresh.etag,
            ranges: false
          }
          await saveState(statePath, transfer)
          received = await writeResponse(
            fresh.response,
            partialPath,
            statePath,
            transfer,
            0,
            onProgress,
            debug
          )
          if (transfer.size !== null && received !== transfer.size) {
            throw new DownloadError(`Incomplete response: expected ${transfer.size}, received ${received}`, {
              retryable: true,
              code: 'INCOMPLETE_RESPONSE'
            })
          }
        } else if (received < transfer.size) {
          debug('download.range-start', { start: received, end: transfer.size - 1, total: transfer.size })
          const { response, url: finalUrl } = await requestFollowingRedirects(
            transfer.url,
            {
              ...headers,
              range: `bytes=${received}-${transfer.size - 1}`,
              'if-range': transfer.etag
            },
            { timeoutMs, signal: options.signal, debug, json }
          )
          const status = response.statusCode ?? 0
          if (status === 200) {
            response.destroy()
            const file = await open(partialPath, 'w')
            await file.close()
            received = 0
            transfer = null
            break
          }
          if (status !== 206) {
            response.resume()
            throw httpError(response, finalUrl)
          }
          const range = parseContentRange(header(response.headers, 'content-range'))
          const responseTag = header(response.headers, 'etag')
          if (
            !range ||
            range.start !== received ||
            range.total !== transfer.size ||
            responseTag !== transfer.etag
          ) {
            response.destroy()
            throw new DownloadError('Server returned a range that does not match the saved file', {
              code: 'SOURCE_CHANGED'
            })
          }
          transfer.finalUrl = finalUrl
          received = await writeResponse(
            response,
            partialPath,
            statePath,
            transfer,
            received,
            onProgress,
            debug
          )
          if (received !== transfer.size) {
            throw new DownloadError(`Incomplete response: expected ${transfer.size}, received ${received}`, {
              retryable: true,
              code: 'INCOMPLETE_RESPONSE'
            })
          }
        }
        if (transfer && (transfer.size === null || received === transfer.size)) {
          return await finishDownload(partialPath, statePath, outputPath, transfer, options, json)
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw new DownloadError('Download cancelled; partial data was kept where it can be resumed', {
            code: 'CANCELLED'
          })
        }
        if (transfer?.ranges && strongEtag(transfer.etag)) {
          received = await fileSize(partialPath)
          if (received > transfer.size) {
            const partial = await open(partialPath, 'w')
            await partial.close()
            received = 0
            throw new DownloadError('Partial file exceeded the validated source size', {
              code: 'SIZE_MISMATCH'
            })
          }
        }
        if (!(error instanceof DownloadError) || !error.retryable || attempt === retries) throw error
        emitEvent(json, { event: 'retry', attempt: attempt + 1, code: error.code, message: error.message })
        const delay = Math.max(error.retryAfterMs ?? 0, Math.min(30_000, 500 * 2 ** attempt))
        debug('download.retry', { attempt: attempt + 1, code: error.code, delayMs: delay })
        await waitForRetry(delay, options.signal)
      }

      if (!transfer) {
        const fresh = await retryOperation(
          () => probeUrl(url, headers, { timeoutMs, signal: options.signal, debug, json }),
          { retries, signal: options.signal, json, debug }
        )
        transfer = {
          version: 1,
          url,
          finalUrl: fresh.url,
          size: fresh.size,
          etag: fresh.etag,
          ranges: fresh.ranges,
          expectedSha256: options.sha256 ?? null
        }
        if (transfer.ranges && !strongEtag(transfer.etag)) transfer.ranges = false
        await saveState(statePath, transfer)
        received = 0
        if (fresh.fullResponse) {
          received = await writeResponse(
            fresh.fullResponse,
            partialPath,
            statePath,
            transfer,
            0,
            onProgress,
            debug
          )
          if (transfer.size !== null && received !== transfer.size) {
            throw new DownloadError(`Incomplete response: expected ${transfer.size}, received ${received}`, {
              retryable: true,
              code: 'INCOMPLETE_RESPONSE'
            })
          }
          return await finishDownload(partialPath, statePath, outputPath, transfer, options, json)
        } else if (!transfer.ranges) {
          const whole = await requestWholeFile(url, headers, { timeoutMs, signal: options.signal, debug, json })
          transfer.finalUrl = whole.url
          transfer.size = whole.size
          transfer.etag = whole.etag
          await saveState(statePath, transfer)
          received = await writeResponse(
            whole.response,
            partialPath,
            statePath,
            transfer,
            0,
            onProgress,
            debug
          )
          if (transfer.size !== null && received !== transfer.size) {
            throw new DownloadError(`Incomplete response: expected ${transfer.size}, received ${received}`, {
              retryable: true,
              code: 'INCOMPLETE_RESPONSE'
            })
          }
          return await finishDownload(partialPath, statePath, outputPath, transfer, options, json)
        }
      }
    }
    throw new DownloadError('Download retry limit reached', { retryable: false, code: 'RETRY_LIMIT' })
  } finally {
    if (ownsLock) {
      await lock?.close()
      await unlink(lockPath).catch(() => {})
    }
  }
}

export async function refreshDownload(outputInput, replacementInput, options = {}) {
  const outputPath = resolve(outputInput)
  const partialPath = `${outputPath}.part`
  const statePath = `${partialPath}.json`
  const lockPath = `${partialPath}.lock`
  await mkdir(dirname(outputPath), { recursive: true })
  let lock
  try {
    lock = await open(lockPath, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new DownloadError(`Another download is using ${outputPath}`, { code: 'DOWNLOAD_LOCKED' })
    }
    throw error
  }
  try {
    const state = await loadState(statePath)
    if (!state) throw new DownloadError('No partial download exists to refresh', { code: 'NO_STATE' })
    const nextUrl = safeUrl(replacementInput).toString()
    const retries = options.retries ?? DEFAULT_RETRIES
    const checked = await retryOperation(
      () =>
        probeUrl(nextUrl, options.headers ?? {}, {
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: options.signal,
          debug: (event, fields) => emitDebug(options, event, fields),
          json: options.json ?? false
        }),
      {
        retries,
        signal: options.signal,
        json: options.json ?? false,
        debug: (event, fields) => emitDebug(options, event, fields)
      }
    )
    const keep =
      checked.ranges &&
      state.ranges &&
      state.size === checked.size &&
      strongEtag(state.etag) &&
      state.etag === checked.etag
    if (!keep) {
      const file = await open(partialPath, 'w')
      await file.close()
    }
    emitDebug(options, 'download.refresh-decision', {
      keptProgress: keep,
      reason: keep ? 'matching-size-and-strong-etag' : 'source-identity-not-verified'
    })
    state.url = nextUrl
    state.finalUrl = checked.url
    state.size = checked.size
    state.etag = checked.etag
    state.ranges = checked.ranges && strongEtag(checked.etag)
    state.expectedSha256 = options.sha256 ?? state.expectedSha256 ?? null
    await saveState(statePath, state)
    emitEvent(options.json ?? false, { event: 'refresh', keptProgress: keep })
    const result = await downloadFile(nextUrl, outputPath, {
      ...options,
      sha256: state.expectedSha256,
      [SHARED_LOCK]: lock
    })
    return { ...result, keptProgress: keep }
  } finally {
    await lock.close()
    await unlink(lockPath).catch(() => {})
  }
}

async function finishDownload(partialPath, statePath, outputPath, state, options, json) {
  const actualSize = await fileSize(partialPath)
  if (state.size !== null && actualSize !== state.size) {
    throw new DownloadError(`Incomplete file: expected ${state.size}, received ${actualSize}`, {
      retryable: true,
      code: 'INCOMPLETE_RESPONSE'
    })
  }
  const sha256 = await fileSha256(partialPath)
  emitDebug(options, 'download.checksum', {
    algorithm: 'sha256',
    expectedProvided: Boolean(options.sha256 ?? state.expectedSha256),
    matched: !(options.sha256 ?? state.expectedSha256) || equalDigest(sha256, options.sha256 ?? state.expectedSha256)
  })
  const expected = options.sha256 ?? state.expectedSha256
  if (expected && !equalDigest(sha256, expected)) {
    throw new DownloadError(`SHA-256 mismatch: expected ${expected.toLowerCase()}, received ${sha256}`, {
      code: 'CHECKSUM_MISMATCH'
    })
  }
  await promote(partialPath, outputPath)
  emitDebug(options, 'download.promoted', { bytes: actualSize, destination: outputPath })
  await unlink(statePath).catch(() => {})
  if (!json) process.stderr.write('\n')
  const result = { event: 'completed', path: outputPath, bytes: actualSize, sha256 }
  emitEvent(json, result)
  return result
}

async function showStatus(outputInput, json) {
  const outputPath = resolve(outputInput)
  const partialPath = `${outputPath}.part`
  const state = await loadState(`${partialPath}.json`)
  const bytes = await fileSize(partialPath)
  const result = { event: 'status', path: outputPath, bytes, total: state?.size ?? null, resumable: Boolean(state?.ranges && strongEtag(state?.etag)) }
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`)
  else process.stdout.write(`${result.path}: ${result.bytes}${result.total === null ? '' : `/${result.total}`} bytes; ${result.resumable ? 'resumable' : 'restart required'}\n`)
}

function usage() {
  process.stderr.write(
    'Usage:\n' +
    '  moth-get download <url> --output <file> [--sha256 <hex>] [--json] [--retries <n>]\n' +
    '    [--debug]\n' +
    '  moth-get resume <file> [--json]\n' +
    '  moth-get refresh <file> <new-url> [--json]\n' +
    '  moth-get status <file> [--json]\n'
  )
}

function parseOptions(args) {
  const options = {}
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--json') options.json = true
    else if (value === '--debug') options.debug = true
    else if (value === '--output') options.output = args[++index]
    else if (value === '--sha256') options.sha256 = args[++index]
    else if (value === '--retries') options.retries = Number(args[++index])
    else if (value === '--timeout-ms') options.timeoutMs = Number(args[++index])
    else if (value.startsWith('--')) throw new DownloadError(`Unknown option: ${value}`, { code: 'INVALID_ARGUMENT' })
    else positional.push(value)
  }
  if (options.retries !== undefined && (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 20)) {
    throw new DownloadError('--retries must be an integer from 0 to 20', { code: 'INVALID_ARGUMENT' })
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 600_000)) {
    throw new DownloadError('--timeout-ms must be an integer from 100 to 600000', { code: 'INVALID_ARGUMENT' })
  }
  return { options, positional }
}

async function main(argv, signal) {
  const [command, ...args] = argv
  const { options, positional } = parseOptions(args)
  options.signal = signal
  if (command === 'download') {
    const url = positional[0]
    const output = options.output
    if (!url || !output) throw new DownloadError('download requires a URL and --output <file>', { code: 'INVALID_ARGUMENT' })
    return downloadFile(url, output, options)
  }
  if (command === 'resume') {
    const output = positional[0]
    const state = output ? await loadState(`${resolve(output)}.part.json`) : null
    if (!output || !state?.url) throw new DownloadError('No resumable download state exists for that file', { code: 'NO_STATE' })
    return downloadFile(state.url, output, { ...options, sha256: options.sha256 ?? state.expectedSha256 })
  }
  if (command === 'status') {
    if (!positional[0]) throw new DownloadError('status requires an output file', { code: 'INVALID_ARGUMENT' })
    return showStatus(positional[0], options.json)
  }
  if (command === 'refresh') {
    const [output, replacement] = positional
    if (!output || !replacement) throw new DownloadError('refresh requires a file and replacement URL', { code: 'INVALID_ARGUMENT' })
    return refreshDownload(output, replacement, options)
  }
  usage()
  throw new DownloadError(`Unknown command: ${command ?? ''}`, { code: 'INVALID_ARGUMENT' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  main(process.argv.slice(2), controller.signal)
    .catch((error) => {
      const failure = error instanceof DownloadError
        ? error
        : new DownloadError(error instanceof Error ? error.message : String(error), { code: 'UNEXPECTED' })
      if (process.argv.includes('--json')) {
        process.stderr.write(`${JSON.stringify({ event: 'error', code: failure.code, retryable: failure.retryable, message: failure.message })}\n`)
      } else {
        process.stderr.write(`\n${failure.code}: ${failure.message}\n`)
      }
      process.exitCode = 1
    })
}
