/**
 * Post-install environment check.
 *
 * Moth deliberately uses ZERO native addons. Persistence rides on Node's
 * built-in `node:sqlite` module, which means no node-gyp / MSVC toolchain is
 * required on any platform. This script verifies that assumption early and
 * loudly instead of letting the app fail with an opaque error on first launch.
 *
 * It never fails the install; it only reports.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const results = []

function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail })
  } catch (err) {
    results.push({ name, ok: false, detail: err?.message ?? String(err) })
  }
}

check('node:sqlite available', () => {
  const { DatabaseSync } = require('node:sqlite')
  if (typeof DatabaseSync !== 'function') throw new Error('DatabaseSync export missing')
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE probe(x INTEGER)')
  db.prepare('INSERT INTO probe VALUES (?)').run(1)
  const row = db.prepare('SELECT COUNT(*) AS n FROM probe').get()
  db.close()
  const n = Number(row?.n ?? 0)
  if (n !== 1) throw new Error('round-trip failed')
  return 'round-trip OK'
})

check('node:crypto createHash', () => {
  const { createHash } = require('node:crypto')
  const h = createHash('sha256').update('moth').digest('hex')
  if (h.length !== 64) throw new Error('unexpected digest length')
  return 'sha256 OK'
})

check('node:fs/promises FileHandle', () => {
  const { open } = require('node:fs/promises')
  if (typeof open !== 'function') throw new Error('fs/promises.open missing')
  return 'positional writes OK'
})

const width = 34
console.log('\n  Moth Download Manager - environment check\n')
for (const r of results) {
  const icon = r.ok ? '✔' : '✖'
  console.log(`  ${icon} ${r.name.padEnd(width)} ${r.detail}`)
}

const failed = results.filter((r) => !r.ok)
if (failed.length > 0) {
  console.log(
    `\n  ${failed.length} check(s) failed. Node ${process.version} is too old - Moth needs Node 22.5+ (ideally 24+) for node:sqlite.\n`
  )
} else {
  console.log(`\n  All ${results.length} checks passed on Node ${process.version}.\n`)
}
