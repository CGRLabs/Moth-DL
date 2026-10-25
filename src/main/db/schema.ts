/**
 * Schema definition and forward-only migrations.
 *
 * Each migration is applied exactly once and recorded in `schema_migrations`.
 * Migrations are append-only: never edit a shipped migration, add a new one.
 */

import type { Database } from './driver.js'
import { getLogger } from '../util/logger.js'

const log = getLogger('db.schema')

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS downloads (
        id                  TEXT PRIMARY KEY,
        url                 TEXT NOT NULL,
        final_url           TEXT,
        filename            TEXT NOT NULL,
        temp_path           TEXT NOT NULL,
        final_path          TEXT,
        file_size           INTEGER NOT NULL DEFAULT 0,
        accept_ranges       INTEGER NOT NULL DEFAULT 0,
        etag                TEXT,
        last_modified       TEXT,
        content_type        TEXT,
        category            TEXT NOT NULL DEFAULT 'other',
        status              TEXT NOT NULL,
        downloaded_bytes    INTEGER NOT NULL DEFAULT 0,
        expected_algorithm  TEXT,
        expected_checksum   TEXT,
        computed_checksum   TEXT,
        priority            INTEGER NOT NULL DEFAULT 0,
        retry_count         INTEGER NOT NULL DEFAULT 0,
        max_retries         INTEGER NOT NULL DEFAULT 5,
        error_code          TEXT,
        error_message       TEXT,
        speed_limit         INTEGER,
        scheduled_start_at  INTEGER,
        connections         INTEGER,
        headers             TEXT NOT NULL DEFAULT '{}',
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        started_at          INTEGER,
        completed_at        INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_downloads_status     ON downloads(status);
      CREATE INDEX IF NOT EXISTS idx_downloads_priority   ON downloads(priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_downloads_scheduled  ON downloads(scheduled_start_at);

      CREATE TABLE IF NOT EXISTS chunks (
        id            TEXT PRIMARY KEY,
        download_id   TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
        idx           INTEGER NOT NULL,
        start_byte    INTEGER NOT NULL,
        end_byte      INTEGER NOT NULL,
        size          INTEGER NOT NULL,
        status        TEXT NOT NULL,
        bytes_written INTEGER NOT NULL DEFAULT 0,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        checksum      TEXT,
        updated_at    INTEGER NOT NULL,
        UNIQUE (download_id, idx)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_download ON chunks(download_id, idx);
      CREATE INDEX IF NOT EXISTS idx_chunks_status   ON chunks(download_id, status);

      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        download_id TEXT NOT NULL,
        at          INTEGER NOT NULL,
        level       TEXT NOT NULL,
        message     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activity_download ON activity(download_id, at DESC);
    `
  },
  {
    version: 2,
    name: 'media_metadata',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS media_metadata (
        download_id   TEXT PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
        format        TEXT NOT NULL DEFAULT 'unknown',
        title         TEXT,
        artist        TEXT,
        album_artist  TEXT,
        album         TEXT,
        track         INTEGER,
        disc          INTEGER,
        year          INTEGER,
        genre         TEXT,
        artwork_path  TEXT,
        artwork_mime  TEXT,
        artwork_bytes INTEGER,
        source        TEXT NOT NULL DEFAULT 'file',
        written_at    INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_media_source ON media_metadata(source);
    `
  },
  {
    version: 3,
    name: 'pending_video_merges',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS pending_video_merges (
        download_id TEXT PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
        audio_url   TEXT NOT NULL,
        container   TEXT NOT NULL,
        headers     TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL
      );
    `
  },
  {
    version: 4,
    name: 'pending_media_resolutions',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS pending_media_resolutions (
        download_id TEXT PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
        format TEXT NOT NULL CHECK (format IN ('video', 'audio')),
        video_quality INTEGER CHECK (video_quality IN (360, 480, 720, 1080)),
        requested_filename TEXT,
        requested_destination TEXT,
        created_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 5,
    name: 'pending_audio_transcodes',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS pending_audio_transcodes (
        download_id TEXT PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE
      );
    `
  },
  {
    version: 6,
    name: 'media_audio_output_format',
    sql: /* sql */ `
      ALTER TABLE pending_media_resolutions
        ADD COLUMN audio_format TEXT NOT NULL DEFAULT 'mp3'
        CHECK (audio_format IN ('source', 'mp3'));
    `
  },
  {
    version: 7,
    name: 'persistent_media_source',
    sql: /* sql */ `
      ALTER TABLE pending_media_resolutions
        ADD COLUMN source_page_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE pending_media_resolutions
        ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1));
      ALTER TABLE pending_media_resolutions
        ADD COLUMN media_id TEXT;
      ALTER TABLE pending_media_resolutions
        ADD COLUMN media_title TEXT;
      ALTER TABLE pending_media_resolutions
        ADD COLUMN subtitle_languages TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE pending_media_resolutions
        ADD COLUMN naming_template TEXT;
      ALTER TABLE pending_media_resolutions
        ADD COLUMN embed_metadata INTEGER NOT NULL DEFAULT 1 CHECK (embed_metadata IN (0, 1));
      CREATE TABLE IF NOT EXISTS media_history (
        source_key TEXT PRIMARY KEY,
        source_page_url TEXT NOT NULL,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 8,
    name: 'support_high_resolution_video',
    sql: /* sql */ `
      CREATE TABLE pending_media_resolutions_new (
        download_id TEXT PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
        format TEXT NOT NULL CHECK (format IN ('video', 'audio')),
        video_quality INTEGER CHECK (video_quality IN (360, 480, 720, 1080, 1440, 2160)),
        requested_filename TEXT,
        requested_destination TEXT,
        created_at INTEGER NOT NULL,
        audio_format TEXT NOT NULL DEFAULT 'mp3' CHECK (audio_format IN ('source', 'mp3')),
        source_page_url TEXT NOT NULL DEFAULT '',
        resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
        media_id TEXT,
        media_title TEXT,
        subtitle_languages TEXT NOT NULL DEFAULT '[]',
        naming_template TEXT,
        embed_metadata INTEGER NOT NULL DEFAULT 1 CHECK (embed_metadata IN (0, 1))
      );
      INSERT INTO pending_media_resolutions_new (
        download_id, format, video_quality, requested_filename, requested_destination,
        created_at, audio_format, source_page_url, resolved, media_id, media_title,
        subtitle_languages, naming_template, embed_metadata
      )
      SELECT
        download_id, format, video_quality, requested_filename, requested_destination,
        created_at, audio_format, source_page_url, resolved, media_id, media_title,
        subtitle_languages, naming_template, embed_metadata
      FROM pending_media_resolutions;
      DROP TABLE pending_media_resolutions;
      ALTER TABLE pending_media_resolutions_new RENAME TO pending_media_resolutions;
    `
  },
  {
    version: 9,
    name: 'youtube_video_output_details',
    sql: /* sql */ `
      CREATE TABLE youtube_video_output_details (
        download_id TEXT PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
        requested_quality INTEGER NOT NULL CHECK (requested_quality IN (360, 480, 720, 1080, 1440, 2160)),
        width INTEGER,
        height INTEGER,
        video_codec TEXT,
        audio_codec TEXT,
        validated_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 10,
    name: 'queue_plans',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS queue_plans (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        download_ids      TEXT NOT NULL,
        starts_at         INTEGER NOT NULL,
        duration_minutes  INTEGER NOT NULL,
        strategy          TEXT NOT NULL CHECK (strategy IN ('queue-order', 'smallest-first')),
        end_action        TEXT NOT NULL CHECK (end_action IN ('pause', 'continue')),
        status            TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'completed', 'canceled')),
        created_at        INTEGER NOT NULL,
        ended_at          INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_queue_plans_status_start ON queue_plans(status, starts_at);
    `
  },
  {
    version: 11,
    name: 'download_quota',
    sql: /* sql */ `
      ALTER TABLE downloads ADD COLUMN quota_bytes INTEGER;
    `
  },
  {
    version: 12,
    name: 'torrent_selection_and_upload_limit',
    sql: /* sql */ `
      ALTER TABLE downloads ADD COLUMN upload_speed_limit INTEGER;
      ALTER TABLE downloads ADD COLUMN torrent_files TEXT;
    `
  }
]

const MIGRATION_TABLE = /* sql */ `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`

/**
 * Brings the database up to the latest schema version.
 * Returns the versions that were applied during this call.
 */
export function migrate(db: Database): number[] {
  db.exec(MIGRATION_TABLE)

  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => Number(r.version))
  )

  const performed: number[] = []
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    log.info('Applying migration', { version: migration.version, name: migration.name })
    db.transaction(() => {
      db.exec(migration.sql)
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.name,
        Date.now()
      )
    })
    performed.push(migration.version)
  }
  return performed
}

export function currentSchemaVersion(db: Database): number {
  try {
    const row = db.get<{ max: number | null }>('SELECT MAX(version) AS max FROM schema_migrations')
    return Number(row?.max ?? 0)
  } catch {
    return 0
  }
}
