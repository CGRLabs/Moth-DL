/**
 * SQLite driver built on Node's *built-in* `node:sqlite` module.
 *
 * Moth intentionally avoids native addons (better-sqlite3, sql.js): the
 * built-in module means no node-gyp, no prebuilt-binary ABI drift, and no
 * MSVC toolchain on the user's machine. Everything is synchronous, which is
 * exactly what we want: SQLite writes are microseconds, and a synchronous API
 * removes a whole class of "committed but not yet flushed" bugs from the
 * crash-recovery path.
 *
 * Durability settings matter enormously here. If the process dies at 70% we
 * MUST see the chunk state that was actually written, so we use
 * `journal_mode=WAL` + `synchronous=FULL`, which survives a hard power loss.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getLogger } from '../util/logger.js'

const log = getLogger('db')

export type SqlValue = string | number | bigint | null | Uint8Array
export type Row = Record<string, SqlValue>

export interface DatabaseOptions {
  /** Absolute path to the database file, or `:memory:`. */
  location: string
  /** `FULL` survives OS crash; `NORMAL` is faster and survives app crash. */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA'
  readonly?: boolean
  /** Injectable for tests. */
  verbose?: boolean
}

export class Database {
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private closed = false
  private txDepth = 0

  constructor(private readonly options: DatabaseOptions) {
    if (options.location !== ':memory:') {
      mkdirSync(dirname(options.location), { recursive: true })
    }
    this.db = new DatabaseSync(options.location, {
      open: true,
      readOnly: options.readonly ?? false,
      enableForeignKeyConstraints: true
    })

    // WAL gives readers concurrency while a writer is active; FULL sync means
    // a committed chunk map survives sudden power loss.
    if (!(options.readonly ?? false)) {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec(`PRAGMA synchronous = ${options.synchronous ?? 'FULL'}`)
      this.db.exec('PRAGMA foreign_keys = ON')
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.db.exec('PRAGMA temp_store = MEMORY')
      // Bounded WAL growth: checkpoint opportunistically.
      this.db.exec('PRAGMA wal_autocheckpoint = 512')
    }
  }

  /** Prepared statements are cached: planning is the expensive part. */
  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  exec(sql: string): void {
    this.assertOpen()
    this.db.exec(sql)
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    this.assertOpen()
    const result = this.prepare(sql).run(...params)
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid)
    }
  }

  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    this.assertOpen()
    return this.prepare(sql).get(...params) as T | undefined
  }

  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
    this.assertOpen()
    return this.prepare(sql).all(...params) as T[]
  }

  /** Convenience for `SELECT count(*)`. */
  count(sql: string, ...params: SqlValue[]): number {
    const row = this.get<{ n: number }>(sql, ...params)
    return Number(row?.n ?? 0)
  }

  /**
   * Runs `fn` inside a transaction.
   *
   * `IMMEDIATE` takes the write lock up-front, which converts a potential
   * mid-transaction `SQLITE_BUSY` into a clean wait governed by `busy_timeout`.
   * Nested calls use SAVEPOINTs so repository methods can be composed freely.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen()
    const isOuter = this.txDepth === 0
    const savepoint = `sp_${this.txDepth}`

    if (isOuter) this.db.exec('BEGIN IMMEDIATE')
    else this.db.exec(`SAVEPOINT ${savepoint}`)
    this.txDepth += 1

    try {
      const result = fn()
      this.txDepth -= 1
      if (isOuter) this.db.exec('COMMIT')
      else this.db.exec(`RELEASE ${savepoint}`)
      return result
    } catch (err) {
      this.txDepth -= 1
      try {
        if (isOuter) this.db.exec('ROLLBACK')
        else this.db.exec(`ROLLBACK TO ${savepoint}`)
      } catch (rollbackErr) {
        log.error('Transaction rollback failed', { error: rollbackErr })
      }
      throw err
    }
  }

  /** Truncates the WAL into the main database file. Call on clean shutdown. */
  checkpoint(): void {
    if (this.options.readonly) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (err) {
      log.warn('WAL checkpoint failed', { error: err })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.statements.clear()
    try {
      if (!this.options.readonly) this.checkpoint()
    } catch {
      /* best effort */
    }
    try {
      this.db.close()
    } catch (err) {
      log.warn('Database close failed', { error: err })
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Database is closed')
  }
}

export function openDatabase(options: DatabaseOptions): Database {
  const db = new Database(options)
  log.info('Database opened', { location: options.location, synchronous: options.synchronous ?? 'FULL' })
  return db
}

/** `node:sqlite` is only present on Node 22.5+; fail loudly and early if absent. */
export function assertSqliteAvailable(): void {
  if (typeof DatabaseSync !== 'function') {
    throw new Error(
      'node:sqlite is unavailable. Moth requires Node 22.5+ (bundled with Electron 32+). ' +
        'Do not run the main process under an older Node.'
    )
  }
}
