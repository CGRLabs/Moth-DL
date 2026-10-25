/**
 * Resolves and applies media metadata for a download.
 *
 * One entry point used by three callers — the download task on completion, the
 * ingest endpoint when the extension supplies page metadata, and the UI when the
 * user edits a field by hand. Keeping the merge rules in one place is what
 * stops "the extension said one thing and the file says another" from becoming
 * a second implementation.
 *
 * Merge precedence, highest first: `manual` > `page` > `file` > `filename`.
 * A manual edit is never overwritten by an automatic pass.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  MediaFormat,
  MediaHint,
  MediaMetadataSource,
  MediaMetadataView,
  MediaTags,
  MediaWriteResult
} from '@shared/media.js'
import { emptyTags, hasAnyTag } from '@shared/media.js'
import { getLogger } from '../util/logger.js'
import { readTagsFromFile, writeTagsToFile } from './write.js'
import { storeArtwork } from './artwork.js'
import type { MediaMetadataRow, MediaRepository } from '../db/mediaRepository.js'
import type { SettingsStore } from '../core/settingsStore.js'

const log = getLogger('media.service')

/** Builds the view the UI consumes, turning a stored path into a URL. */
export function toView(
  row: MediaMetadataRow,
  artworkBase: string
): MediaMetadataView {
  return {
    downloadId: row.downloadId,
    format: row.format,
    title: row.title,
    artist: row.artist,
    albumArtist: row.albumArtist,
    album: row.album,
    track: row.track,
    disc: row.disc,
    year: row.year,
    genre: row.genre,
    // Only the filename travels in the URL. A full path would not parse as a
    // URL host, and the handler resolves the real location server-side.
    artworkUrl: row.artworkPath ? `${artworkBase}${encodeURIComponent(basename(row.artworkPath))}` : null,
    artworkMime: row.artworkMime as MediaMetadataView['artworkMime'],
    artworkBytes: row.artworkBytes,
    source: row.source,
    writtenAt: row.writtenAt
  }
}

export interface MediaServiceOptions {
  repos: MediaRepository
  settings: SettingsStore
  /** Base URL the artwork protocol is mounted on. */
  artworkBase: string
  /** User-data directory, where artwork is stored. */
  userDataDir: string
}

export interface MediaResolutionOptions {
  writeTags?: boolean
  fetchArtwork?: boolean
}

export class MediaService {
  constructor(private readonly options: MediaServiceOptions) {}

  getView(downloadId: string): MediaMetadataView | null {
    const row = this.options.repos.get(downloadId)
    return row ? toView(row, this.options.artworkBase) : null
  }

  /** Stores page title and artwork as soon as a media page has been resolved. */
  async resolvePageHint(downloadId: string, hint: MediaHint): Promise<MediaMetadataView | null> {
    if (!hint.title && !hint.pageImage) return this.getView(downloadId)

    try {
      const existing = this.options.repos.get(downloadId)
      const tags = hintToTags(hint, existing?.format ?? 'unknown')
      let artworkPath = existing?.artworkPath ?? null
      let artworkMime = existing?.artworkMime ?? null
      let artworkBytes = existing?.artworkBytes ?? null

      if (hint.pageImage && !artworkPath) {
        const stored = await this.fetchArtwork(hint.pageImage)
        if (stored) {
          artworkPath = stored.path
          artworkMime = stored.mime
          artworkBytes = stored.bytes
        }
      }

      const now = Date.now()
      this.options.repos.upsert({
        downloadId,
        format: existing?.format ?? tags.format,
        title: existing?.source === 'manual' ? existing.title : tags.title ?? existing?.title ?? null,
        artist: existing?.artist ?? tags.artist,
        albumArtist: existing?.albumArtist ?? tags.albumArtist,
        album: existing?.album ?? tags.album,
        track: existing?.track ?? tags.track,
        disc: existing?.disc ?? tags.disc,
        year: existing?.year ?? tags.year,
        genre: existing?.genre ?? tags.genre,
        artworkPath,
        artworkMime,
        artworkBytes,
        source: existing?.source === 'manual' ? 'manual' : 'page',
        writtenAt: existing?.writtenAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
      return this.getView(downloadId)
    } catch (err) {
      log.warn('Could not store page artwork before download completion', { downloadId, error: err })
      return null
    }
  }

  /**
   * Resolves metadata for a just-finished download.
   *
   * Order: use page metadata if the caller supplied any, otherwise read what is
   * already embedded in the file. Then, if the settings ask for it and there is
   * something to write, write the tags into the file.
   *
   * Every failure is logged and swallowed. Metadata is an enhancement; it must
   * never be the reason a download fails.
   */
  async resolveAfterDownload(
    downloadId: string,
    filePath: string,
    hint?: MediaHint,
    behavior: MediaResolutionOptions = {}
  ): Promise<MediaMetadataView | null> {
    try {
      const settings = this.options.settings.get()
      const existing = this.options.repos.get(downloadId)

      let tags: MediaTags
      let source: MediaMetadataSource

      if (hint && hasHintContent(hint)) {
        tags = hintToTags(hint, existing?.format ?? 'unknown')
        source = 'page'
      } else if (settings.readEmbeddedTags) {
        tags = await readTagsFromFile(filePath)
        source = hasAnyTag(tags) ? 'file' : 'filename'
      } else {
        return existing ? toView(existing, this.options.artworkBase) : null
      }

      // Fetch and store page artwork if one was offered.
      let artworkPath = existing?.artworkPath ?? null
      let artworkMime = existing?.artworkMime ?? null
      let artworkBytes = existing?.artworkBytes ?? null
      if (behavior.fetchArtwork !== false && hint?.pageImage) {
        const stored = await this.fetchArtwork(hint.pageImage)
        if (stored) {
          artworkPath = stored.path
          artworkMime = stored.mime
          artworkBytes = stored.bytes
        }
      }

      const row: MediaMetadataRow = {
        downloadId,
        format: tags.format,
        title: tags.title,
        artist: tags.artist,
        albumArtist: tags.albumArtist,
        album: tags.album,
        track: tags.track,
        disc: tags.disc,
        year: tags.year,
        genre: tags.genre,
        artworkPath,
        artworkMime,
        artworkBytes,
        source,
        writtenAt: existing?.writtenAt ?? null,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now()
      }
      this.options.repos.upsert(row)

      // Write tags into the file, but only when there is something to write and
      // the user has not turned the feature off.
      if (settings.writeMediaTags && behavior.writeTags !== false && hasAnyTag(tags)) {
        const result = await writeTagsToFile(filePath, tags, {
          title: tags.title ?? undefined,
          artist: tags.artist ?? undefined,
          album: tags.album ?? undefined
        })
        if (result.written) {
          this.options.repos.markWritten(downloadId, Date.now())
          row.writtenAt = Date.now()
        } else if (result.reason) {
          log.info('Tags were not written to the file', { downloadId, reason: result.reason })
        }
      }

      return toView(row, this.options.artworkBase)
    } catch (err) {
      log.warn('Metadata resolution failed; download is unaffected', { downloadId, error: err })
      return this.getView(downloadId)
    }
  }

  /** Applies a manual edit from the UI. `manual` outranks every other source. */
  async applyManualEdit(
    downloadId: string,
    patch: Partial<Omit<MediaMetadataView, 'downloadId' | 'artworkUrl'>>
  ): Promise<MediaMetadataView | null> {
    const existing = this.options.repos.get(downloadId)
    if (!existing) return null

    const next: MediaMetadataRow = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.artist !== undefined ? { artist: patch.artist } : {}),
      ...(patch.albumArtist !== undefined ? { albumArtist: patch.albumArtist } : {}),
      ...(patch.album !== undefined ? { album: patch.album } : {}),
      ...(patch.track !== undefined ? { track: patch.track } : {}),
      ...(patch.disc !== undefined ? { disc: patch.disc } : {}),
      ...(patch.year !== undefined ? { year: patch.year } : {}),
      ...(patch.genre !== undefined ? { genre: patch.genre } : {}),
      source: 'manual',
      updatedAt: Date.now()
    }
    this.options.repos.upsert(next)
    return toView(next, this.options.artworkBase)
  }

  /** Pushes the current metadata into the downloaded file on demand. */
  async writeToFile(downloadId: string, filePath: string): Promise<MediaWriteResult> {
    const row = this.options.repos.get(downloadId)
    if (!row) return { written: false, reason: 'No metadata for this download' }

    const tags: MediaTags = {
      format: row.format,
      title: row.title,
      artist: row.artist,
      albumArtist: row.albumArtist,
      album: row.album,
      track: row.track,
      disc: row.disc,
      year: row.year,
      genre: row.genre,
      artwork: row.artworkPath ? await this.loadArtwork(row.artworkPath) : null
    }

    const result = await writeTagsToFile(filePath, tags, {
      title: row.title ?? undefined,
      artist: row.artist ?? undefined,
      album: row.album ?? undefined
    })
    if (result.written) this.options.repos.markWritten(downloadId, Date.now())
    return result
  }

  /** Downloads a page image and stores it content-addressed. */
  private async fetchArtwork(url: string): Promise<{ path: string; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; bytes: number } | null> {
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) return null
      const bytes = new Uint8Array(await response.arrayBuffer())
      return storeArtwork(bytes, this.options.userDataDir)
    } catch (err) {
      log.warn('Could not fetch page artwork', { url, error: err })
      return null
    }
  }

  private async loadArtwork(path: string): Promise<MediaTags['artwork']> {
    try {
      const buf = await readFile(path)
      return { data: new Uint8Array(buf), mime: 'image/jpeg' }
    } catch {
      return null
    }
  }
}

function hasHintContent(hint: MediaHint): boolean {
  return Boolean(
    hint.title ||
      hint.artist ||
      hint.album ||
      hint.albumArtist ||
      hint.year !== undefined ||
      hint.track !== undefined ||
      hint.pageImage
  )
}

/** Maps extension-supplied hints onto a tag set. */
function hintToTags(hint: MediaHint, format: MediaFormat): MediaTags {
  const tags = emptyTags(format)
  if (hint.title) tags.title = hint.title
  if (hint.artist) tags.artist = hint.artist
  if (hint.album) tags.album = hint.album
  if (hint.albumArtist) tags.albumArtist = hint.albumArtist
  if (hint.genre) tags.genre = hint.genre
  if (hint.year !== undefined && Number.isFinite(hint.year)) tags.year = hint.year
  if (hint.track !== undefined && Number.isFinite(hint.track)) tags.track = hint.track
  return tags
}
