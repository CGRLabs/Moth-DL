/**
 * Inspects the live Moth database and the files it references.
 * Written as a file because inline `node -e` gets mangled by PowerShell
 * quoting, and this is a diagnostic that must be unambiguous.
 *
 * Run with: node scripts/inspect.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { statSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dbPath = join(process.env.APPDATA || '', 'moth-dlm', 'moth.db')
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: true })

const downloads = db.prepare(`
  SELECT id, filename, status, file_size, downloaded_bytes, accept_ranges,
         retry_count, error_code, error_message, priority, temp_path, final_path
  FROM downloads ORDER BY created_at
`).all()

console.log(`\n  database: ${dbPath}`)
console.log(`  downloads: ${downloads.length}\n`)

for (const d of downloads) {
  console.log(`  ${d.filename}`)
  console.log(`    id              ${d.id}`)
  console.log(`    status          ${d.status}`)
  console.log(`    file_size       ${d.file_size} (${(Number(d.file_size) / 1048576).toFixed(2)} MiB)`)
  console.log(`    downloaded      ${d.downloaded_bytes} (${(Number(d.downloaded_bytes) / 1048576).toFixed(2)} MiB)`)
  console.log(`    accept_ranges   ${d.accept_ranges}`)
  console.log(`    retries         ${d.retry_count}`)
  console.log(`    error           ${d.error_code ?? '-'} ${d.error_message ?? ''}`)

  const stats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END),0) AS complete,
              COALESCE(SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END),0) AS pending,
              COALESCE(SUM(CASE WHEN status='active'    THEN 1 ELSE 0 END),0) AS active,
              COALESCE(SUM(CASE WHEN status='complete' THEN size ELSE 0 END),0) AS verified_bytes
       FROM chunks WHERE download_id = ?`
    )
    .get(d.id)
  console.log(
    `    chunks          ${stats.complete}/${stats.total} complete, ${stats.pending} pending, ${stats.active} active` +
      `  (verified ${(Number(stats.verified_bytes) / 1048576).toFixed(2)} MiB)`
  )

  for (const label of ['temp_path', 'final_path']) {
    const target = d[label]
    if (!target) continue
    if (existsSync(target)) {
      const info = statSync(target)
      console.log(`    ${label.padEnd(15)} ${(info.size / 1048576).toFixed(2)} MiB on disk`)
    } else {
      console.log(`    ${label.padEnd(15)} (absent)`)
    }
  }
  console.log('')
}

const downloadsDir = join(process.env.USERPROFILE || '', 'Downloads', 'Archives')
if (existsSync(downloadsDir)) {
  console.log(`  ${downloadsDir}`)
  for (const name of readdirSync(downloadsDir)) {
    const info = statSync(join(downloadsDir, name))
    console.log(`    ${(info.size / 1048576).toFixed(2)} MiB  ${name}`)
  }
  console.log('')
}

db.close()
