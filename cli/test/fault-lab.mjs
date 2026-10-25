#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIB = 1024 * 1024
const BLOCK_SIZE = 64 * 1024
const ETAG = '"moth-fault-lab-v1"'

function sizeFromArgs(args) {
  const index = args.indexOf('--size-mib')
  const value = index === -1 ? 8 : Number(args[index + 1])
  if (!Number.isInteger(value) || value < 1 || value > 1024) {
    throw new Error('--size-mib must be an integer from 1 to 1024')
  }
  return value * MIB
}

async function makePayload(path, size) {
  const file = await open(path, 'wx')
  const hash = createHash('sha256')
  let offset = 0
  try {
    while (offset < size) {
      const length = Math.min(BLOCK_SIZE, size - offset)
      const block = Buffer.allocUnsafe(length)
      for (let index = 0; index < length; index += 1) {
        block[index] = (offset + index) % 251
      }
      let written = 0
      while (written < block.length) {
        const result = await file.write(block, written, block.length - written, offset + written)
        if (result.bytesWritten === 0) throw new Error('Could not finish writing the lab payload')
        written += result.bytesWritten
      }
      hash.update(block)
      offset += length
    }
    await file.sync()
  } finally {
    await file.close()
  }
  return hash.digest('hex')
}

function sendPayload(response, payloadPath, start, end, { etag = ETAG, total } = {}) {
  response.writeHead(206, {
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${total}`,
    etag
  })
  createReadStream(payloadPath, { start, end }).pipe(response)
}

function rangeFor(request, total) {
  const value = request.headers.range
  if (!value) return { start: 0, end: total - 1 }
  const match = /^bytes=(\d+)-(\d*)$/.exec(value)
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : total - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) return null
  return { start, end: Math.min(end, total - 1) }
}

function createLabServer(payloadPath, total, counters) {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/expired') {
      response.writeHead(403, { 'content-type': 'text/plain' })
      response.end('Simulated expired link')
      return
    }
    if (path === '/flaky' && counters.flaky++ === 0) {
      response.writeHead(503, { 'retry-after': '0', 'content-type': 'text/plain' })
      response.end('Simulated temporary failure')
      return
    }
    if (path === '/redirect') {
      response.writeHead(302, { location: counters.destinationUrl })
      response.end()
      return
    }

    const range = rangeFor(request, total)
    if (!range) {
      response.writeHead(416, { 'content-range': `bytes */${total}` })
      response.end()
      return
    }
    if (path === '/no-range') {
      response.writeHead(200, { 'content-length': total, etag: ETAG })
      createReadStream(payloadPath).pipe(response)
      return
    }
    if (path === '/stall' && (range.end - range.start) > 0) return
    if (path === '/bad-range' && (range.end - range.start) > 0) {
      const wrongStart = Math.min(range.start + 1, range.end)
      response.writeHead(206, {
        'accept-ranges': 'bytes',
        'content-length': range.end - range.start + 1,
        'content-range': `bytes ${wrongStart}-${range.end}/${total}`,
        etag: ETAG
      })
      createReadStream(payloadPath, { start: range.start, end: range.end }).pipe(response)
      return
    }
    if (path === '/changed-etag' && (range.end - range.start) > 0) {
      sendPayload(response, payloadPath, range.start, range.end, {
        etag: '"moth-fault-lab-changed"',
        total
      })
      return
    }
    if (path === '/drop-once' && range.end > range.start && !counters.dropped) {
      counters.dropped = true
      response.writeHead(206, {
        'accept-ranges': 'bytes',
        'content-length': range.end - range.start + 1,
        'content-range': `bytes ${range.start}-${range.end}/${total}`,
        etag: ETAG
      })
      const cut = Math.min(range.start + 32 * 1024, range.end)
      const stream = createReadStream(payloadPath, { start: range.start, end: cut })
      stream.pipe(response)
      stream.once('end', () => response.socket?.destroy())
      return
    }
    sendPayload(response, payloadPath, range.start, range.end, { total })
  })
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function main() {
  const size = sizeFromArgs(process.argv.slice(2))
  const directory = await mkdtemp(join(tmpdir(), 'moth-download-fault-lab-'))
  const payloadPath = join(directory, 'test-payload.bin')
  const checksum = await makePayload(payloadPath, size)
  const counters = { flaky: 0, dropped: false, destinationUrl: '' }
  const destination = createLabServer(payloadPath, size, {})
  const source = createLabServer(payloadPath, size, counters)
  const servers = [source, destination]
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    await rm(directory, { recursive: true, force: true })
  }

  try {
    const destinationPort = await listen(destination)
    counters.destinationUrl = `http://127.0.0.1:${destinationPort}/ok`
    const sourcePort = await listen(source)
    const baseUrl = `http://127.0.0.1:${sourcePort}`
    const fileInfo = await stat(payloadPath)
    process.stdout.write(
      `Local Moth download fault lab (127.0.0.1 only)\n` +
      `Generated payload: ${payloadPath}\n` +
      `Size: ${fileInfo.size} bytes\n` +
      `SHA-256: ${checksum}\n` +
      `Normal:       ${baseUrl}/ok\n` +
      `Drop once:    ${baseUrl}/drop-once\n` +
      `No ranges:    ${baseUrl}/no-range\n` +
      `Temporary 503:${baseUrl}/flaky\n` +
      `Expired link: ${baseUrl}/expired\n` +
      `Bad range:    ${baseUrl}/bad-range\n` +
      `Changed ETag: ${baseUrl}/changed-etag\n` +
      `Stall:        ${baseUrl}/stall\n` +
      `Redirect:     ${baseUrl}/redirect\n\n` +
      `Example (in another terminal):\n` +
      `node cli\\src\\cli.mjs download ${baseUrl}/drop-once --output .\\lab-drop.bin --sha256 ${checksum} --debug --json\n\n` +
      `Press Ctrl+C to stop the server and remove the generated payload.\n`
    )
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } finally {
    await close()
  }
}

main().catch((error) => {
  process.stderr.write(`Fault lab failed: ${error.message}\n`)
  process.exitCode = 1
})
