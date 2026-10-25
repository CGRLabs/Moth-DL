/**
 * Media metadata persistence.
 *
 * Owns the `media_metadata` table. Kept in its own file rather than folded into
 * `repositories.ts`, which is already large enough that adding a second
 * responsibility to it would make the file harder to navigate.
 *
 * Row mapping follows the same defensive style as the other repositories: every
 * column is coerced with an explicit fallback, because a database written by a
 * different version must not be able to produce a half-populated record.
 */

import type { MediaFormat, MediaMetadataSource } from '@shared/media.js'
import type { Database, Row, SqlValue } from './driver.js'

const COLUMNS = /* sql */ `
  download_id, format, title, artist, album_artist, album, track, disc, year,
  genre, artwork_path, artwork_mime, artwork_bytes, source, written_at,
  created_at, updated_at
`

// Derived from the column list rather than hand-counted: a mismatch here is a
// runtime error on the first write, which is exactly the kind of thing that
// should be impossible to get wrong.
const PLACEHOLDERS = COLUMNS.split(',')
  .map(() => '?')
  .join(',')

/** A row as stored, before any coercion. */
export interface MediaMetadataRow {
  downloadId: string
  format: MediaFormat
  title: string | null
  artist: string | null
  albumArtist: string | null
  album: string | null
  track: number | null
  disc: number | null
  year: number | null
  genre: string | null
  artworkPath: string | null
  artworkMime: string | null
  artworkBytes: number | null
  source: MediaMetadataSource
  writtenAt: number | null
  createdAt: number
  updatedAt: number
}

const FORMATS: ReadonlySet<string> = new Set<MediaFormat>([
  'mp3',
  'mp4',
  'matroska',
  'flac',
  'ogg',
  'wav',
  'unknown'
])

const SOURCES: ReadonlySet<string> = new Set<MediaMetadataSource>([
  'file',
  'page',
  'filename',
  'manual'
])

function strOrNull(value: SqlValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numOrNull(value: SqlValue | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function rowToMetadata(row: Row): MediaMetadataRow {
  const format = String(row.format ?? 'unknown')
  const source = String(row.source ?? 'file')
  return {
    downloadId: String(row.download_id ?? ''),
    format: (FORMATS.has(format) ? format : 'unknown') as MediaFormat,
    title: strOrNull(row.title),
    artist: strOrNull(row.artist),
    albumArtist: strOrNull(row.album_artist),
    album: strOrNull(row.album),
    track: numOrNull(row.track),
    disc: numOrNull(row.disc),
    year: numOrNull(row.year),
    genre: strOrNull(row.genre),
    artworkPath: strOrNull(row.artwork_path),
    artworkMime: strOrNull(row.artwork_mime),
    artworkBytes: numOrNull(row.artwork_bytes),
    source: (SOURCES.has(source) ? source : 'file') as MediaMetadataSource,
    writtenAt: numOrNull(row.written_at),
    createdAt: numOrNull(row.created_at) ?? 0,
    updatedAt: numOrNull(row.updated_at) ?? 0
  }
}

export class MediaRepository {
  constructor(private readonly db: Database) {}

  get(downloadId: string): MediaMetadataRow | null {
    const row = this.db.get<Row>(
      `SELECT ${COLUMNS} FROM media_metadata WHERE download_id = ?`,
      downloadId
    )
    return row ? rowToMetadata(row) : null
  }

  /**
   * Inserts or replaces the metadata for a download.
   *
   * Null fields are written as NULL rather than ignored, so clearing a value
   * (the user removing a wrong title) actually clears it.
   */
  upsert(metadata: MediaMetadataRow): void {
    this.db.run(
      `INSERT INTO media_metadata (${COLUMNS})
       VALUES (${PLACEHOLDERS})
       ON CONFLICT(download_id) DO UPDATE SET
         format=excluded.format, title=excluded.title, artist=excluded.artist,
         album_artist=excluded.album_artist, album=excluded.album,
         track=excluded.track, disc=excluded.disc, year=excluded.year,
         genre=excluded.genre, artwork_path=excluded.artwork_path,
         artwork_mime=excluded.artwork_mime, artwork_bytes=excluded.artwork_bytes,
         source=excluded.source, written_at=excluded.written_at,
         updated_at=excluded.updated_at`,
      metadata.downloadId,
      metadata.format,
      metadata.title,
      metadata.artist,
      metadata.albumArtist,
      metadata.album,
      metadata.track,
      metadata.disc,
      metadata.year,
      metadata.genre,
      metadata.artworkPath,
      metadata.artworkMime,
      metadata.artworkBytes,
      metadata.source,
      metadata.writtenAt,
      metadata.createdAt,
      metadata.updatedAt
    )
  }

  /** Records that tags were written into the file. */
  markWritten(downloadId: string, at: number): void {
    this.db.run(
      'UPDATE media_metadata SET written_at = ?, updated_at = ? WHERE download_id = ?',
      at,
      at,
      downloadId
    )
  }

  remove(downloadId: string): void {
    this.db.run('DELETE FROM media_metadata WHERE download_id = ?', downloadId)
  }

  /** Every record, for a bulk view. */
  list(): MediaMetadataRow[] {
    return this.db.all<Row>(`SELECT ${COLUMNS} FROM media_metadata`).map(rowToMetadata)
  }
}
