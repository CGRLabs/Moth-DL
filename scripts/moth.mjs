/**
 * Moth agent/test CLI: drive a running app over its loopback ingest endpoint.
 *
 * Every command prints JSON to stdout; failures go to stderr with a non-zero
 * exit. Connection defaults to the real app profile
 * (`%APPDATA%/moth-dlm`); `--profile` points anywhere else, `--port` and
 * `--token` override the profile lookup. The token is read from the profile
 * database exactly the way `testIngest.mjs` does it.
 *
 *   node scripts/moth.mjs status
 *   node scripts/moth.mjs add <url|magnet> [--format video|audio] [--video-quality 360|480|720|1080|1440|2160] [--audio-format source|mp3] [--filename n] [--no-start]
 *   node scripts/moth.mjs list
 *   node scripts/moth.mjs get <id>
 *   node scripts/moth.mjs pause|resume|retry|cancel <id>
 *   node scripts/moth.mjs wait <id> [--timeout ms]
 *   node scripts/moth.mjs logs [--lines <n>]
 *   node scripts/moth.mjs doctor
 *   node scripts/moth.mjs repair [--id <id>]
 *   node scripts/moth.mjs boot [--profile <dir>] [--download-dir <dir>]
 *   node scripts/moth.mjs kill --pid <n>
 *   node scripts/moth.mjs run <url> [--format video|audio] [--video-quality 360|480|720|1080|1440|2160] [--audio-format source|mp3] [--filename n] [--expect-sha256 <hex>] [--timeout ms] [--keep]
 *
 * `boot` launches the built bundle detached with a scratch profile, waits for
 * the ingest port, and prints { pid, port, token, profile } for the calls
 * above. It refuses to boot the real profile (pass it explicitly only to
 * `status`/`add`/`list`/`get`/`wait`, never to `boot`).
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

const out = (value) => console.log(JSON.stringify(value))
const fail = (message) => {
  console.error(`moth: ${message}`)
  process.exitCode = 1
}

function argValue(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  const next = index >= 0 ? process.argv[index + 1] : undefined
  return next && !next.startsWith('--') ? next : undefined
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function mediaOptions() {
  const options = {}
  const quality = argValue('video-quality')
  if (quality !== undefined) {
    const parsed = Number(quality)
    if (![360, 480, 720, 1080, 1440, 2160].includes(parsed)) {
      throw new Error('video-quality must be 360, 480, 720, 1080, 1440, or 2160')
    }
    options.videoQuality = parsed
  }
  const audioFormat = argValue('audio-format')
  if (audioFormat !== undefined) {
    if (audioFormat !== 'source' && audioFormat !== 'mp3') {
      throw new Error('audio-format must be source or mp3')
    }
    options.audioFormat = audioFormat
  }
  return options
}

function realProfileDir() {
  return join(process.env.APPDATA || join(process.env.HOME || tmpdir(), 'AppData', 'Roaming'), 'moth-dlm')
}

function readSetting(dbPath, key) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return row?.value ?? null
  } finally {
    db.close()
  }
}

/** Token + port for a profile directory. Throws when the profile is unusable. */
function connectionFor(profileDir) {
  const portArg = argValue('port')
  const tokenArg = argValue('token')
  if (portArg && tokenArg) return { port: Number(portArg), token: tokenArg }
  const apiUrl = process.env.MOTH_API_URL
  const envToken = process.env.MOTH_API_TOKEN
  if (apiUrl) {
    let parsed
    try {
      parsed = new URL(apiUrl)
    } catch {
      throw new Error('MOTH_API_URL must be a valid loopback URL')
    }
    const port = Number(parsed.port)
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('MOTH_API_URL must be http://127.0.0.1:<port>')
    }
    const token = tokenArg ?? envToken
    if (!token) throw new Error('MOTH_API_TOKEN is required when MOTH_API_URL is set')
    return { port, token }
  }
  const dbPath = join(profileDir, 'moth.db')
  if (!existsSync(dbPath)) {
    throw new Error(`no database at ${dbPath} — is the app running with --user-data-dir=${profileDir}?`)
  }
  const token = readSetting(dbPath, 'ingestToken')
  const portRaw = readSetting(dbPath, 'ingestPort')
  if (!token || !portRaw) throw new Error(`profile at ${profileDir} has no ingest pairing yet`)
  return { port: Number(portRaw), token: String(token) }
}

async function callJson(port, token, path, init) {
  // Every call is deadline-bounded: without this, one wedged server hangs
  // the poll loops below forever (their timeouts only fire *between* calls).
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...(init ?? {}),
    // First-run helper downloads (yt-dlp ~18 MB, FFmpeg ~80 MB) plus the
    // resolver run can keep `/ingest` busy well past half a minute.
    signal: AbortSignal.timeout(180000),
    headers: { ...(init?.headers ?? {}), 'x-moth-token': token }
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status} from ${path}`)
  }
  return body
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      reject(new Error(`app process ${child.pid} did not exit after termination`))
    }, 10000)
    const onExit = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
    child.kill()
  })
}

async function waitForStatus(port, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await callJson(port, token, '/status')
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`ingest port ${port} never answered`)
      await sleep(500)
    }
  }
}

async function waitFor(port, token, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const body = await callJson(port, token, `/downloads/${encodeURIComponent(id)}`)
    const status = body.download?.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return body
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${id}`)
    await sleep(500)
  }
}

async function main() {
  const [command, positional] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const profile = argValue('profile') ?? realProfileDir()

  if (command === 'boot') {
    if (!argValue('profile')) {
      // A fresh scratch profile every time: booting the agent CLI against
      // the user's real library would queue test downloads into it.
      const dir = mkdtempSync(join(tmpdir(), 'moth-cli-'))
      return void (await bootWith(dir, argValue('download-dir')))
    }
    return void (await bootWith(resolve(argValue('profile')), argValue('download-dir')))
  }

  if (command === 'kill') {
    const pid = Number(argValue('pid'))
    if (!Number.isFinite(pid)) return void fail('kill needs --pid=<n>')
    try {
      process.kill(pid)
    } catch (err) {
      return void fail(`could not kill ${pid}: ${err.message}`)
    }
    return void out({ ok: true, killed: pid })
  }

  const { port, token } = connectionFor(profile)

  if (command === 'status') {
    return void out(await callJson(port, token, '/api/v1/status'))
  }

  if (command === 'doctor') {
    const [status, downloads] = await Promise.all([
      callJson(port, token, '/api/v1/status'),
      callJson(port, token, '/api/v1/downloads')
    ])
    const rows = downloads.data
    const failed = rows
      .filter((download) => download.status === 'failed')
      .map((download) => ({
        id: download.id,
        filename: download.filename,
        code: download.errorCode,
        message: download.errorMessage
      }))
    const queued = rows.filter((download) => download.status === 'queued').length
    const active = rows.filter((download) => ['downloading', 'connecting'].includes(download.status)).length
    const report = {
      healthy: failed.length === 0,
      checks: [
        { name: 'Moth API', ok: true, detail: 'Authenticated loopback API responded' },
        { name: 'Download records', ok: failed.length === 0, failed: failed.length, active, queued }
      ],
      failed,
      suggestions: [
        ...(failed.length > 0 ? ['Review failed download messages and retry after addressing their cause.'] : []),
        ...(queued > 0 && active === 0 ? ['Downloads are queued but none are active; check pause and auto-start settings.'] : [])
      ],
      stats: status.data.stats
    }
    if (!report.healthy) process.exitCode = 1
    return void out({ ok: true, data: report })
  }

  if (command === 'repair') {
    const id = argValue('id')
    return void out(
      await callJson(port, token, '/api/v1/maintenance/rescan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(id ? { id } : {})
      })
    )
  }

  if (command === 'logs') {
    const lines = Number(argValue('lines') ?? 100)
    if (!Number.isInteger(lines) || lines < 1 || lines > 500) {
      return void fail('logs --lines must be an integer from 1 to 500')
    }
    return void out(await callJson(port, token, `/api/v1/logs?lines=${lines}`))
  }

  if (command === 'add') {
    if (!positional || (!/^https?:/i.test(positional) && !/^magnet:/i.test(positional))) {
      return void fail('add needs an http(s) URL, BitTorrent v1/v2 magnet link, or .torrent URL')
    }
    const magnet = /^magnet:/i.test(positional)
    let torrentFileUrl = false
    if (!magnet && /^https?:/i.test(positional)) {
      try {
        torrentFileUrl = new URL(positional).pathname.toLowerCase().endsWith('.torrent')
      } catch {
        torrentFileUrl = false
      }
    }
    const torrent = magnet || torrentFileUrl
    const media = mediaOptions()
    const format = argValue('format')
    if (format !== undefined && format !== 'video' && format !== 'audio') {
      return void fail('format must be video or audio')
    }
    if (torrent && (format !== undefined || Object.keys(media).length > 0)) {
      return void fail('torrent downloads do not support --format, --video-quality, or --audio-format')
    }
    const filename = argValue('filename')
    if (torrent) {
      const body = await callJson(port, token, '/api/v1/downloads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: positional,
          ...(filename ? { filename } : {}),
          ...(hasFlag('no-start') ? { scheduledStartAt: Date.now() + 5 * 60_000 } : {})
        })
      })
      return void out(body)
    }
    const body = await callJson(port, token, '/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: positional,
        ...(filename ? { filename } : {}),
        ...(format ? { format } : {}),
        ...media,
        ...(hasFlag('no-start') ? { autoStart: false } : {})
      })
    })
    return void out(body)
  }

  if (command === 'list') {
    return void out(await callJson(port, token, '/downloads'))
  }

  if (command === 'get') {
    if (!positional) return void fail('get needs an id')
    return void out(await callJson(port, token, `/downloads/${encodeURIComponent(positional)}`))
  }

  if (['pause', 'resume', 'retry', 'cancel'].includes(command)) {
    if (!positional) return void fail(`${command} needs an id`)
    return void out(
      await callJson(port, token, `/api/v1/downloads/${encodeURIComponent(positional)}/${command}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
    )
  }

  if (command === 'wait') {
    if (!positional) return void fail('wait needs an id')
    const timeoutMs = Number(argValue('timeout') ?? 120000)
    const body = await waitFor(port, token, positional, timeoutMs)
    const status = body.download?.status
    if (status === 'failed' || status === 'cancelled') {
      console.error(`moth: download ended as ${status}`)
      process.exitCode = 2
    }
    return void out(body)
  }

  if (command === 'run') {
    // One-shot agent download: scratch profile, add, wait, optionally verify
    // the digest, then tear everything down. A single invocation so it works
    // in shells that reap stray processes between commands.
    if (!positional || !/^https?:/i.test(positional)) return void fail('run needs an http(s) URL')
    const media = mediaOptions()
    const format = argValue('format')
    const filename = argValue('filename')
    if (format !== undefined && format !== 'video' && format !== 'audio') {
      return void fail('format must be video or audio')
    }
    const profileDir = mkdtempSync(join(tmpdir(), 'moth-run-'))
    const downloadDir = mkdtempSync(join(tmpdir(), 'moth-run-dl-'))
    console.error('moth: booting scratch instance…')
    const booted = await bootWith(profileDir, downloadDir)
    console.error(`moth: up on port ${booted.port}, adding ${positional}`)
    try {
      const added = await callJson(booted.port, booted.token, '/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: positional,
          ...(format ? { format } : {}),
          ...(filename ? { filename } : {}),
          ...media
        })
      })
      console.error(`moth: queued as ${added.id}, waiting…`)
      const timeoutMs = Number(argValue('timeout') ?? 300000)
      const body = await waitFor(booted.port, booted.token, added.id, timeoutMs)
      const expected = argValue('expect-sha256')
      let digest = null
      if (expected) {
        const { createHash } = await import('node:crypto')
        const { readFileSync } = await import('node:fs')
        const finalPath = body.download?.finalPath
        if (!finalPath) throw new Error('download has no final path to verify')
        digest = createHash('sha256').update(readFileSync(finalPath)).digest('hex')
        if (digest.toLowerCase() !== expected.toLowerCase()) {
          throw new Error(`digest mismatch: expected ${expected}, got ${digest}`)
        }
      }
      out({ ...body, digest })
    } finally {
      await stopChild(booted.child)
      if (!hasFlag('keep')) {
        const { rmSync } = await import('node:fs')
        rmSync(profileDir, { recursive: true, force: true })
        rmSync(downloadDir, { recursive: true, force: true })
      }
    }
    return
  }

  fail(
    `unknown command: ${command ?? '(none)'} — status|add|list|get|pause|resume|retry|cancel|wait|logs|doctor|repair|boot|kill|run`
  )
}

async function bootWith(profileDir, downloadDir) {
  const outMain = join(projectRoot, 'out', 'main', 'index.js')
  if (!existsSync(outMain)) {
    throw new Error('build missing — run npm run build first')
  }
  const electron = process.platform === 'win32'
    ? join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(projectRoot, 'node_modules', 'electron', 'dist', 'electron')
  const child = spawn(electron, ['.', `--user-data-dir=${profileDir}`, '--no-sandbox'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      // Without this the scratch instance inherits the OS download folder.
      ...(downloadDir ? { MOTH_SMOKE_DOWNLOAD_DIR: downloadDir } : {})
    },
    // Mirrors smoke.mjs: no detached/unref. Detached survivors get reaped by
    // sandboxed shells; a plain child lives exactly as long as the caller
    // needs it (`run` kills it explicitly, interactive `boot` on a real
    // terminal keeps it after exit like any other process).
    stdio: 'ignore',
    windowsHide: true
  })
  // The token only exists after first launch writes it; poll the database,
  // then the port, the same way a human pairing flow would.
  const deadline = Date.now() + 90000
  let conn = null
  for (;;) {
    try {
      conn = connectionFor(profileDir)
      break
    } catch {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error('app never wrote its ingest pairing')
      }
      await sleep(500)
    }
  }
  await waitForStatus(conn.port, conn.token, 60000)
  out({ pid: child.pid, port: conn.port, token: conn.token, profile: profileDir })
  return { pid: child.pid, port: conn.port, token: conn.token, profile: profileDir, child }
}

main().catch((err) => fail(err.message || String(err)))
