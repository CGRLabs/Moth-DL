import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadFile, refreshDownload } from '../src/cli.mjs'

const servers = new Set()
const directories = new Set()

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  servers.clear()
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  directories.clear()
})

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'moth-cli-test-'))
  directories.add(directory)
  return directory
}

async function serve(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.add(server)
  return `http://127.0.0.1:${server.address().port}/file.bin`
}

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function rangedFile(body, { etag = '"fixture-v1"', onRange = () => {} } = {}) {
  return serve((request, response) => {
    const range = request.headers.range
    if (!range) {
      response.writeHead(200, { 'content-length': body.length, etag })
      response.end(body)
      return
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)
    assert.ok(match)
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), body.length - 1)
    onRange(start, end)
    response.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': end - start + 1,
      etag
    })
    response.end(body.subarray(start, end + 1))
  })
}

describe('Moth download CLI core', () => {
  it('downloads a range-capable file, checks its expected hash, and never overwrites', async () => {
    const body = Buffer.alloc(96 * 1024, 0x5a)
    const url = await rangedFile(body)
    const output = join(await workspace(), 'payload.bin')
    const result = await downloadFile(url, output, { sha256: hash(body), onProgress: () => {} })
    assert.equal(result.bytes, body.length)
    assert.equal(result.sha256, hash(body))
    assert.deepEqual(await readFile(output), body)
    await assert.rejects(downloadFile(url, output), /Output already exists/)
  })

  it('keeps JSON events on stdout and redacts signed query strings from debug output', async () => {
    const body = Buffer.from('debug-safe')
    const baseUrl = await rangedFile(body)
    const url = `${baseUrl}?token=secret-query-value`
    const output = join(await workspace(), 'debug.bin')
    const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
    const child = spawn(process.execPath, [entry, 'download', url, '--output', output, '--json', '--debug'])
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })

    assert.equal(exitCode, 0, stderr)
    assert.ok(stdout.trim().length > 0)
    assert.doesNotThrow(() => stdout.trim().split('\n').forEach((line) => JSON.parse(line)))
    assert.ok(stderr.trim().length > 0)
    assert.doesNotThrow(() => stderr.trim().split('\n').forEach((line) => JSON.parse(line)))
    assert.match(stderr, /http\.request/)
    assert.doesNotMatch(stdout + stderr, /secret-query-value/)
  })

  it('continues after a dropped connection using the same strong ETag', async () => {
    const body = Buffer.alloc(256 * 1024)
    for (let index = 0; index < body.length; index += 1) body[index] = index % 251
    const starts = []
    let dropped = false
    const url = await serve((request, response) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      assert.ok(match)
      const start = Number(match[1])
      const end = Math.min(Number(match[2]), body.length - 1)
      starts.push(start)
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': end - start + 1,
        etag: '"resume-v1"'
      })
      if (!dropped && start === 0 && end > 64 * 1024) {
        dropped = true
        response.write(body.subarray(start, start + 32 * 1024))
        setTimeout(() => response.socket.destroy(), 25)
        return
      }
      response.end(body.subarray(start, end + 1))
    })
    const output = join(await workspace(), 'resumed.bin')
    const result = await downloadFile(url, output, { retries: 2, onProgress: () => {} })
    assert.equal(result.sha256, hash(body))
    assert.deepEqual(await readFile(output), body)
    assert.ok(starts.includes(32 * 1024), `expected a resumed range, got ${starts.join(', ')}`)
  })

  it('resumes a failed CLI process from its saved partial file', async () => {
    const body = Buffer.alloc(192 * 1024)
    for (let index = 0; index < body.length; index += 1) body[index] = index % 239
    let dropped = false
    const starts = []
    const url = await serve((request, response) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      assert.ok(match)
      const start = Number(match[1])
      const end = Math.min(Number(match[2]), body.length - 1)
      starts.push(start)
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': end - start + 1,
        etag: '"cli-restart-v1"'
      })
      if (!dropped && end > start) {
        dropped = true
        response.write(body.subarray(start, start + 32 * 1024))
        setTimeout(() => response.socket.destroy(), 25)
        return
      }
      response.end(body.subarray(start, end + 1))
    })
    const output = join(await workspace(), 'cli-restart.bin')
    const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
    const invoke = (args) => new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [entry, ...args])
      child.stdout.resume()
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      child.once('error', rejectPromise)
      child.once('close', (code) => resolvePromise({ code, stderr }))
    })

    const first = await invoke(['download', url, '--output', output, '--retries', '0', '--json'])
    assert.notEqual(first.code, 0, first.stderr)
    const partialPath = `${output}.part`
    assert.ok((await readFile(partialPath)).length > 0, 'failed transfer should retain partial bytes')
    const resumed = await invoke(['resume', output, '--json'])
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.ok(starts.some((start) => start > 0), `expected resume from nonzero offset, got ${starts.join(', ')}`)
    assert.deepEqual(await readFile(output), body)
  })

  it('uses a single stream when the server ignores ranges', async () => {
    const body = Buffer.from('single stream fallback')
    let requests = 0
    const url = await serve((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-length': body.length })
      response.end(body)
    })
    const output = join(await workspace(), 'single.bin')
    const result = await downloadFile(url, output, { onProgress: () => {} })
    assert.equal(result.bytes, body.length)
    assert.deepEqual(await readFile(output), body)
    assert.equal(requests, 1)
  })

  it('keeps progress on refresh only when the strong ETag and size match', async () => {
    const body = Buffer.alloc(192 * 1024, 0x34)
    let dropped = false
    const oldUrl = await serve((request, response) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      assert.ok(match)
      const start = Number(match[1])
      const end = Math.min(Number(match[2]), body.length - 1)
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': end - start + 1,
        etag: '"same-version"'
      })
      if (!dropped && end > 0) {
        dropped = true
        response.write(body.subarray(start, 24 * 1024))
        setTimeout(() => response.socket.destroy(), 20)
        return
      }
      response.end(body.subarray(start, end + 1))
    })
    const starts = []
    const newUrl = await rangedFile(body, {
      etag: '"same-version"',
      onRange: (start) => starts.push(start)
    })
    const output = join(await workspace(), 'refresh.bin')
    await assert.rejects(downloadFile(oldUrl, output, { retries: 0, onProgress: () => {} }))

    const refreshed = await refreshDownload(output, newUrl, { onProgress: () => {} })
    assert.equal(refreshed.keptProgress, true)
    assert.deepEqual(await readFile(output), body)
    assert.ok(starts.includes(24 * 1024), `expected retained progress, got ranges ${starts.join(', ')}`)
  })

  it('holds the output lock throughout refreshed-link verification and transfer', async () => {
    const body = Buffer.alloc(48 * 1024, 0x33)
    const directory = await workspace()
    const output = join(directory, 'locked-refresh.bin')
    const partialPath = `${output}.part`
    let markProbeStarted
    let releaseProbe
    const probeStarted = new Promise((resolve) => { markProbeStarted = resolve })
    const probeGate = new Promise((resolve) => { releaseProbe = resolve })
    const oldUrl = await serve(async (request, response) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      assert.ok(range)
      const start = Number(range[1])
      const end = Math.min(Number(range[2]), body.length - 1)
      if (start === 0 && end === 0) {
        markProbeStarted()
        await probeGate
      }
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': end - start + 1,
        etag: '"refresh-lock-v1"'
      })
      response.end(body.subarray(start, end + 1))
    })
    await writeFile(partialPath, body.subarray(0, 4096))
    await writeFile(`${partialPath}.json`, JSON.stringify({
      version: 1,
      url: oldUrl,
      finalUrl: oldUrl,
      size: body.length,
      etag: '"refresh-lock-v1"',
      ranges: true,
      expectedSha256: null
    }))

    const refreshing = refreshDownload(output, `${oldUrl}?refreshed=1`, { onProgress: () => {} })
    await probeStarted
    await assert.rejects(downloadFile(oldUrl, output), /Another download is using/)
    releaseProbe()
    const result = await refreshing
    assert.equal(result.bytes, body.length)
    assert.deepEqual(await readFile(output), body)
  })

  it('retries a dropped non-range stream from byte zero', async () => {
    const body = Buffer.alloc(96 * 1024, 0x6b)
    let requests = 0
    let dropped = false
    const url = await serve((request, response) => {
      requests += 1
      response.writeHead(200, { 'content-length': body.length, etag: '"whole-file-v1"' })
      if (!dropped && request.headers.range) {
        dropped = true
        response.write(body.subarray(0, 32 * 1024))
        setTimeout(() => response.socket.destroy(), 25)
        return
      }
      response.end(body)
    })
    const output = join(await workspace(), 'non-range-retry.bin')
    const result = await downloadFile(url, output, { retries: 2, onProgress: () => {} })
    assert.equal(requests, 2)
    assert.equal(result.bytes, body.length)
    assert.deepEqual(await readFile(output), body)
  })

  it('restarts cleanly when a refreshed source has a different strong ETag', async () => {
    const body = Buffer.alloc(128 * 1024, 0x63)
    let dropped = false
    const oldUrl = await serve((request, response) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      assert.ok(match)
      const start = Number(match[1])
      const end = Math.min(Number(match[2]), body.length - 1)
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': end - start + 1,
        etag: '"old-version"'
      })
      if (!dropped && end > 0) {
        dropped = true
        response.write(body.subarray(start, 16 * 1024))
        setTimeout(() => response.socket.destroy(), 20)
        return
      }
      response.end(body.subarray(start, end + 1))
    })
    const starts = []
    const newUrl = await rangedFile(body, {
      etag: '"new-version"',
      onRange: (start) => starts.push(start)
    })
    const output = join(await workspace(), 'refresh-reset.bin')
    await assert.rejects(downloadFile(oldUrl, output, { retries: 0, onProgress: () => {} }))

    const refreshed = await refreshDownload(output, newUrl, { onProgress: () => {} })
    assert.equal(refreshed.keptProgress, false)
    assert.deepEqual(await readFile(output), body)
    assert.ok(starts.includes(0), 'expected the replacement file to be downloaded from byte zero')
  })

  it('retries temporary server errors and strips credentials across redirect origins', async () => {
    const body = Buffer.from('redirected securely')
    let destinationHeaders = null
    const destination = createServer((request, response) => {
      destinationHeaders = request.headers
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
      assert.ok(match)
      const start = Number(match[1])
      const end = Math.min(Number(match[2]), body.length - 1)
      response.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': end - start + 1,
        etag: '"redirect-v1"'
      })
      response.end(body.subarray(start, end + 1))
    })
    await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve))
    servers.add(destination)
    const destinationUrl = `http://127.0.0.1:${destination.address().port}/file.bin`
    let temporaryFailures = 1
    const sourceUrl = await serve((_request, response) => {
      if (temporaryFailures > 0) {
        temporaryFailures -= 1
        response.writeHead(503, { 'retry-after': '0' })
        response.end()
        return
      }
      response.writeHead(302, { location: destinationUrl })
      response.end()
    })
    const output = join(await workspace(), 'redirect.bin')
    const result = await downloadFile(sourceUrl, output, {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'X-Client-Mode': 'test'
      },
      retries: 2,
      onProgress: () => {}
    })

    assert.deepEqual(await readFile(output), body)
    assert.equal(result.bytes, body.length)
    assert.equal(Object.hasOwn(destinationHeaders, 'authorization'), false)
    assert.equal(Object.hasOwn(destinationHeaders, 'cookie'), false)
    assert.equal(destinationHeaders['x-client-mode'], 'test')
  })
})
