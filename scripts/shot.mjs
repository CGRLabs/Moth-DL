/**
 * Captures a screenshot of the running app.
 *
 * Uses the app's own `capturePage()` rather than a screen grab, so the result
 * is the real render at the real DPI regardless of what else is on screen.
 *
 * Two modes:
 *   (default)  the real user profile, so the shot shows actual downloads
 *   --seed     a throwaway profile with a chosen theme and sample rows in
 *              every status, so both themes can be checked deterministically
 *
 * Seeding deliberately lets the app create and migrate the schema itself on a
 * throwaway first launch, rather than duplicating the DDL here and letting the
 * two drift apart.
 *
 * Run with: node scripts/shot.mjs <out.png> [--theme dark|light] [--seed] [--empty]
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises'
import {
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  ftruncateSync as fsTruncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const electronBinary = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

const outputPath = resolve(process.argv[2] ?? join(projectRoot, 'tmp', 'ui.png'))
const themeIndex = process.argv.indexOf('--theme')
const theme = themeIndex !== -1 ? process.argv[themeIndex + 1] : 'dark'
const wantSeed = process.argv.includes('--seed')
const wantEmpty = process.argv.includes('--empty')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await mkdir(dirname(outputPath), { recursive: true })

const realProfile = join(process.env.APPDATA || '', 'moth-dlm')
let userData = wantSeed
  ? await mkdtemp(join(tmpdir(), 'moth-shot-'))
  : existsSync(realProfile)
    ? realProfile
    : await mkdtemp(join(tmpdir(), 'moth-shot-'))

/**
 * Launches the app against a specific profile.
 *
 * `--user-data-dir` only redirects `app.getPath('userData')`. It does *not*
 * redirect `app.getPath('downloads')`, which is why the smoke test has to
 * sandbox the download directory explicitly; here it is enough, because the
 * seeded rows point at the temp directory.
 */
function launch({ shotPath }) {
  const child = spawn(
    electronBinary,
    ['.', `--user-data-dir=${userData}`, '--no-sandbox', '--enable-logging'],
    {
      cwd: projectRoot,
      env: shotPath
        ? {
            ...process.env,
            MOTH_SCREENSHOT: shotPath,
            ...(wantSeed ? { MOTH_SCREENSHOT_EXPAND_YOUTUBE: '1' } : {}),
            ELECTRON_ENABLE_LOGGING: '1'
          }
        : { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  child.stdout.on('data', (d) => {
    const text = d.toString()
    if (/\[moth\]\s+(ERROR|WARN)/.test(text)) process.stdout.write(text)
    if (/Artwork/.test(text)) process.stdout.write(text)
  })
  child.stderr.on('data', (d) => {
    // Electron forwards renderer console messages here.
    const text = d.toString()
    if (/ROW|CONSOLE/.test(text)) process.stdout.write(text)
  })
  return child
}

// First launch on a throwaway profile: the app creates and migrates the schema.
if (wantSeed) {
  const first = launch({})
  await sleep(3500)
  first.kill()
  await sleep(900)
  seedProfile(userData, theme, !wantEmpty)
}

await rm(outputPath, { force: true }).catch(() => {})
const child = launch({ shotPath: outputPath })

const deadline = Date.now() + 50_000
while (Date.now() < deadline) {
  if (existsSync(outputPath)) break
  if (child.exitCode !== null) break
  await sleep(250)
}

child.kill()
await sleep(700)

if (existsSync(outputPath)) {
  const { size } = await stat(outputPath)
  console.log(`screenshot written: ${outputPath} (${(size / 1024).toFixed(0)} KB)`)
} else {
  console.error(`screenshot was not produced at ${outputPath}`)
  process.exitCode = 1
}

if (wantSeed && !process.env.MOTH_KEEP) await rm(userData, { recursive: true, force: true }).catch(() => {})

/**
 * Populates an already-migrated profile: a chosen theme plus one sample row per
 * status, so every visual state is visible in a single shot.
 */
function seedProfile(dir, chosenTheme, withRows) {
  const db = new DatabaseSync(join(dir, 'moth.db'))
  const now = Date.now()

  const settings = {
    downloadDirectory: dir,
    categoryFolders: {
      video: 'Video', audio: 'Music', document: 'Documents', archive: 'Archives',
      executable: 'Executables', image: 'Images', installer: 'Installers', other: 'Other'
    },
    autoCategorize: false,
    globalSpeedLimit: 5 * 1024 * 1024,
    maxConcurrentDownloads: 3,
    defaultConnections: 4,
    chunkSize: 2 * 1024 * 1024,
    maxRetries: 5,
    verifyChecksums: true,
    autoStartDownloads: true,
    minimizeToTray: true,
    closeToTray: true,
    notificationsEnabled: true,
    theme: chosenTheme,
    logLevel: 'info',
    confirmOnRemove: true,
    maxSpeedHistoryPoints: 120,
    browserIntegration: false,
    ingestPort: 24678,
    ingestToken: '0'.repeat(64),
    watchDownloadFolder: false
  }
  for (const [key, value] of Object.entries(settings)) {
    // The first launch already persists `downloadDirectory`, so upsert rather
    // than insert.
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, typeof value === 'string' ? value : JSON.stringify(value), now)
  }

  if (withRows) {
    const rows = [
      ['ubuntu-24.04-desktop-amd64.iso', 'downloading', 'archive', 5_800_000_000, 3_940_000_000, 1, null],
      ['Blender-4.2.1-windows-x64.msi', 'verifying', 'installer', 312_000_000, 312_000_000, 1, null],
      ['Sintel.1080p.x264.mkv', 'paused', 'video', 1_240_000_000, 380_000_000, 1, null],
      ['YouTube output sample.mp4', 'completed', 'video', 24_000_000, 24_000_000, 0, null],
      ['quarterly-report.pdf', 'failed', 'document', 2_400_000, 1_180_000, 1,
        'Checksum mismatch: expected a1b2c3d4… but got 9f8e7d6c…'],
      ['setup-tools.sh', 'scheduled', 'other', 48_000, 0, 0, null]
    ]

    const insertDownload = db.prepare(`
      INSERT INTO downloads (id, url, final_url, filename, temp_path, final_path, file_size,
        accept_ranges, category, status, downloaded_bytes, error_code, error_message,
        priority, retry_count, max_retries, headers, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    const insertChunk = db.prepare(`
      INSERT INTO chunks (id, download_id, idx, start_byte, end_byte, size, status,
        bytes_written, attempts, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `)

    rows.forEach((row, index) => {
      const [filename, status, category, size, done, ranges, error] = row
      const id = `shot${String(index).padStart(26, '0')}`

      // The recovery pass reconciles the database against real files, so a row
      // with no partial file on disk is correctly reset to paused at 0%. The
      // seed therefore has to write the partial file, or every row ends up
      // looking identical.
      const tempPath = join(dir, `${filename}.mothpart`)
      const chunkCount = 64
      const chunkSize = Math.ceil(size / chunkCount)
      const complete = Math.round((done / size) * chunkCount)

      if (done > 0) {
        // Sparse: only the completed prefix is actually allocated, matching how
        // the engine preallocates.
        const handle = openSync(tempPath, 'w')
        fsTruncateSync(handle, size)
        for (let c = 0; c < complete; c += 1) {
          const start = c * chunkSize
          const length = Math.min(chunkSize, size - start)
          writeSync(handle, Buffer.alloc(length, c & 0xff), 0, length, start)
        }
        closeSync(handle)
      }

      insertDownload.run(
        id,
        index === 3
          ? 'https://www.youtube.com/watch?v=ui-output-sample'
          : `https://releases.ubuntu.com/24.04/${filename}`,
        null,
        filename,
        tempPath,
        join(dir, filename),
        size,
        ranges,
        category,
        status,
        done,
        error ? 'CHECKSUM_MISMATCH' : null,
        error,
        index,
        0,
        5,
        '{}',
        now - index * 90_000,
        now
      )

      if (index === 3) {
        db.prepare(`
          INSERT INTO youtube_video_output_details
            (download_id, requested_quality, width, height, video_codec, audio_codec, validated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, 2160, 1920, 1080, 'h264', 'aac', now)
      }

      for (let c = 0; c < chunkCount; c += 1) {
        const start = c * chunkSize
        const end = Math.min(size - 1, start + chunkSize - 1)
        insertChunk.run(
          `${id}c${c}`, id, c, start, end, end - start + 1,
          c < complete ? 'complete' : 'pending',
          c < complete ? end - start + 1 : 0,
          0,
          now
        )
      }

      // Give the first row real metadata and artwork, so the media UI has
      // something to render.
      if (index === 0) {
        // The artwork directory is where the custom protocol looks.
        const artworkDir = join(dir, 'artwork')
        mkdirSync(artworkDir, { recursive: true })
        const artwork = join(artworkDir, 'cover.png')
        const png = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
          0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
          0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
          0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
          0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
          0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
        ])
        writeFileSync(artwork, png)

        db.prepare(`
          INSERT INTO media_metadata (download_id, format, title, artist, album_artist, album,
            track, disc, year, genre, artwork_path, artwork_mime, artwork_bytes, source,
            written_at, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          id, 'mp4', 'Ubuntu 24.04 LTS', 'Canonical', 'Canonical', 'Desktop ISO',
          1, 1, 2024, 'Operating System', artwork, 'image/png', png.length, 'page',
          null, now, now
        )
      }
    })
  }

  const n = db.prepare('SELECT COUNT(*) AS n FROM media_metadata').get()
  const d = db.prepare('SELECT COUNT(*) AS n FROM downloads').get()
  console.log('SEED CHECK downloads=' + d.n + ' media=' + n.n)
  db.close()
}
