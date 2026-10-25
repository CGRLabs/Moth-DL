/**
 * End-to-end smoke test against the *built* application.
 *
 * Unit and integration tests cannot cover bundle resolution, the `contextBridge`
 * preload surface, or Electron's SQLite availability. This launches the real
 * `out/` bundle under the real Electron binary, points it at a local HTTP
 * server, and lets the app's own self-test module drive a genuine download,
 * a genuine crash-recovery pass, and a byte-for-byte integrity check.
 *
 * Usage:  node scripts/smoke.mjs
 * Requires: npm run build
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const electronBinary = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

const FILE_SIZE = 3 * 1024 * 1024
const CHUNK_SIZE = 512 * 1024

const log = (m) => console.log(`  ${m}`)
const pass = (m) => console.log(`  \u2714 ${m}`)
let failures = 0
const fail = (m, detail) => {
  failures += 1
  console.error(`  \u2716 ${m}`)
  if (detail) console.error(`      ${String(detail).split('\n').join('\n      ')}`)
}

/** Deterministic body. */
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
            'content-type': 'application/octet-stream',
            'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${start + slice.length - 1}/${body.length}`,
            'content-length': String(slice.length),
            etag
          })
          res.end(slice)
          return
        }
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': String(body.length),
        etag
      })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => done(server))
  })
}

/** Recursively lists file paths under `dir`. Returns [] when absent. */
function listFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (current) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(dir)
  return out
}
async function main() {
  console.log('\n  Moth end-to-end smoke test (built bundle)\n')

  if (!existsSync(join(projectRoot, 'out', 'main', 'index.js'))) {
    fail('out/main/index.js is missing — run `npm run build` first')
    process.exitCode = 1
    return
  }
  if (!existsSync(electronBinary)) {
    fail('Electron binary missing — run `npm install`')
    process.exitCode = 1
    return
  }

  const body = makeBody(FILE_SIZE, 20260928)
  const digest = createHash('sha256').update(body).digest('hex')
  const server = await startFileServer(body)
  const url = `http://127.0.0.1:${server.address().port}/ubuntu-24.04.iso`
  log(`server: ${url}  (${(FILE_SIZE / 1024 / 1024).toFixed(1)} MB)`)

  const realDownloads = join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads')
  const beforeDownloads = new Set(listFiles(realDownloads))

  const userData = await mkdtemp(join(tmpdir(), 'moth-smoke-'))
  // A separate sandbox for downloads: --user-data-dir does NOT redirect
  // app.getPath('downloads'), so without this the test would write its
  // synthetic files into the user's real Downloads folder.
  const downloadDir = await mkdtemp(join(tmpdir(), 'moth-smoke-dl-'))
  const resultPath = join(userData, 'smoke-result.json')

  const child = spawn(
    electronBinary,
    ['.', `--user-data-dir=${userData}`, '--no-sandbox'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        MOTH_SMOKE_URL: url,
        MOTH_SMOKE_DIGEST: digest,
        MOTH_SMOKE_RESULT: resultPath,
        MOTH_SMOKE_DOWNLOAD_DIR: downloadDir
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    stdout += d.toString()
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  const exited = new Promise((done) => child.on('exit', (code) => done(code)))
  const timeout = new Promise((done) => setTimeout(() => done('timeout'), 180_000))
  const exitCode = await Promise.race([exited, timeout])

  if (exitCode === 'timeout') {
    fail('application did not exit within 180s')
    console.error(`--- stdout ---\n${stdout.slice(-4000)}`)
    console.error(`--- stderr ---\n${stderr.slice(-4000)}`)
    child.kill()
    server.close()
    process.exitCode = 1
    return
  }

  if (!existsSync(resultPath)) {
    fail(`no self-test result was written (exit code ${exitCode})`)
    console.error(`--- stdout ---\n${stdout.slice(-4000)}`)
    console.error(`--- stderr ---\n${stderr.slice(-4000)}`)
    server.close()
    process.exitCode = 1
    return
  }

  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  for (const step of result.steps) {
    if (step.ok) pass(step.message)
    else fail(step.message, step.detail)
  }

  // Structured log sanity.
  const logFile = join(userData, 'logs', 'moth.log')
  if (existsSync(logFile)) {
    const contents = readFileSync(logFile, 'utf8')
    const lines = contents.trim().split('\n').filter(Boolean)
    let parsedOk = true
    for (const line of lines) {
      try {
        JSON.parse(line)
      } catch {
        parsedOk = false
        break
      }
    }
    if (parsedOk) pass(`rotating log wrote ${lines.length} valid NDJSON records`)
    else fail('log file contains a line that is not valid JSON')
  } else {
    fail('no log file was produced')
  }

  // The database must have survived the run and be a real SQLite file.
  const dbFile = join(userData, 'moth.db')
  if (existsSync(dbFile)) {
    const header = readFileSync(dbFile).subarray(0, 15).toString('latin1')
    if (header === 'SQLite format 3') pass('database file is a valid SQLite database')
    else fail(`unexpected database header: ${JSON.stringify(header)}`)
  } else {
    fail('no database file was created')
  }

  // Guard against the failure mode this harness originally had: a synthetic
  // file appearing in the user's real Downloads folder. --user-data-dir does
  // not redirect app.getPath('downloads'), so this is a real risk.
  const strays = listFiles(realDownloads).filter((f) => !beforeDownloads.has(f))
  if (strays.length > 0) {
    fail(`smoke test leaked ${strays.length} file(s) into the real Downloads folder: ${strays.join(', ')}`)
  } else {
    pass('no files leaked into the real Downloads folder')
  }

  server.close()
  await rm(userData, { recursive: true, force: true }).catch(() => {})
  await rm(downloadDir, { recursive: true, force: true }).catch(() => {})

  if (failures > 0) {
    console.error(`\n  ${failures} smoke check(s) failed\n`)
    process.exitCode = 1
  } else {
    console.log('\n  All smoke checks passed.\n')
  }

  void exitCode
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
