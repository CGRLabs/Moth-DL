/**
 * Live test of the browser ingest endpoint.
 *
 * Starts the built app, then talks to its loopback endpoint exactly the way the
 * browser extension does: a POST to /ingest with the X-Moth-Token header. It
 * also verifies the security properties that matter, namely that a bad token is
 * refused and a non-http scheme is refused.
 *
 * Run with: node scripts/testIngest.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const electronBinary = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

let failures = 0
const pass = (m) => console.log(`  \u2714 ${m}`)
const fail = (m, d) => {
  failures += 1
  console.error(`  \u2716 ${m}${d ? ` — ${d}` : ''}`)
}

function makeBody(size, seed) {
  const out = Buffer.allocUnsafe(size)
  let state = seed >>> 0
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    out[i] = state & 0xff
  }
  return out
}

function startFileServer(body) {
  return new Promise((done) => {
    const etag = createHash('md5').update(body).digest('hex')
    const server = createServer((req, res) => {
      const range = req.headers.range
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range)
        if (m) {
          const start = Number.parseInt(m[1], 10)
          const end = m[2] === '' ? body.length - 1 : Number.parseInt(m[2], 10)
          const slice = body.subarray(start, Math.min(end, body.length - 1) + 1)
          res.writeHead(206, {
            'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${start + slice.length - 1}/${body.length}`,
            'content-length': String(slice.length),
            etag
          })
          res.end(slice)
          return
        }
      }
      res.writeHead(200, { 'accept-ranges': 'bytes', 'content-length': String(body.length), etag })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => done(server))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(port, token, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-moth-token': token },
    body: JSON.stringify(payload)
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function main() {
  console.log('\n  Moth ingest endpoint test\n')

  if (!existsSync(join(projectRoot, 'out', 'main', 'index.js'))) {
    fail('build missing — run npm run build')
    process.exitCode = 1
    return
  }

  const body = makeBody(2 * 1024 * 1024, 7)
  const server = await startFileServer(body)
  const url = `http://127.0.0.1:${server.address().port}/from-browser.bin`

  const userData = await mkdtemp(join(tmpdir(), 'moth-ingest-'))
  const downloadDir = await mkdtemp(join(tmpdir(), 'moth-ingest-dl-'))

  const child = spawn(electronBinary, ['.', `--user-data-dir=${userData}`, '--no-sandbox'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1',
      MOTH_SMOKE_DOWNLOAD_DIR: downloadDir
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  let stdout = ''
  child.stdout.on('data', (d) => {
    stdout += d.toString()
  })

  // Discover the port and token from the structured log.
  let port = null
  let token = null
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    const portMatch = /Ingest server listening \{[^\n]*"port":(\d+)/.exec(stdout)
    if (portMatch) {
      port = Number(portMatch[1])
      break
    }
    await sleep(200)
  }
  if (!port) {
    fail('ingest server never reported a port\n' + stdout.slice(-2000))
    child.kill()
    server.close()
    process.exitCode = 1
    return
  }
  pass(`ingest server is listening on 127.0.0.1:${port}`)

  // The token is stored in the database; read it back the same way the UI does.
  const logFile = join(userData, 'logs', 'moth.log')
  await sleep(1200)
  if (existsSync(logFile)) {
    const contents = readFileSync(logFile, 'utf8')
    void contents
  }

  // Ask the app for its own token via the same IPC the settings panel uses is
  // not possible out-of-process, so read it from the SQLite settings table.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(userData, 'moth.db'), { readOnly: true })
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ingestToken'").get()
  token = row?.value ?? null
  db.close()

  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    fail(`a 64-hex pairing token was not persisted (got ${JSON.stringify(token)})`)
    child.kill()
    server.close()
    process.exitCode = 1
    return
  }
  pass('a 64-hex pairing token was generated and persisted')

  // --- security checks ---------------------------------------------------
  const noToken = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url })
  })
  noToken.status === 401
    ? pass('a request with no token is refused (401)')
    : fail('a request with no token should be refused', `got ${noToken.status}`)

  const badToken = await post(port, 'deadbeef'.repeat(8), { url })
  badToken.status === 401
    ? pass('a request with a wrong token is refused (401)')
    : fail('a wrong token should be refused', `got ${badToken.status}`)

  const fileScheme = await post(port, token, { url: 'file:///C:/Windows/win.ini' })
  fileScheme.status === 400
    ? pass('a file:// URL is refused (400)')
    : fail('file:// should be refused', `got ${fileScheme.status} ${JSON.stringify(fileScheme.body)}`)

  const blobScheme = await post(port, token, { url: 'blob:https://example.com/abc-123' })
  blobScheme.status === 400
    ? pass('a blob: URL is refused (400)')
    : fail('blob: should be refused', `got ${blobScheme.status}`)

  // --- the real thing ----------------------------------------------------
  const accepted = await post(port, token, {
    url,
    filename: 'from-browser.bin',
    referer: 'https://example.com/page',
    cookies: 'session=abc123',
    autoStart: true
  })
  if (accepted.status === 200 && accepted.body?.ok) {
    pass(`a valid request was accepted (download id ${String(accepted.body.id).slice(0, 8)}…)`)
  } else {
    fail('a valid request should be accepted', JSON.stringify(accepted))
  }

  // It should actually download.
  const completed = await (async () => {
    const db2 = new DatabaseSync(join(userData, 'moth.db'), { readOnly: true })
    const deadline2 = Date.now() + 40_000
    try {
      while (Date.now() < deadline2) {
        const r = db2
          .prepare("SELECT status, file_size, downloaded_bytes FROM downloads ORDER BY created_at DESC LIMIT 1")
          .get()
        if (r?.status === 'completed' || r?.status === 'failed') return r
        await sleep(250)
      }
      return null
    } finally {
      db2.close()
    }
  })()

  if (completed?.status === 'completed') {
    pass(`the ingested download completed (${Number(completed.downloaded_bytes)} bytes)`)
  } else {
    fail('the ingested download did not complete', JSON.stringify(completed))
  }

  child.kill()
  await sleep(600)
  server.close()
  await rm(userData, { recursive: true, force: true }).catch(() => {})
  await rm(downloadDir, { recursive: true, force: true }).catch(() => {})

  if (failures > 0) {
    console.error(`\n  ${failures} check(s) failed\n`)
    process.exitCode = 1
  } else {
    console.log('\n  All ingest checks passed.\n')
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
