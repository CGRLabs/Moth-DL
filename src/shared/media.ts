/**
 * Media metadata contract.
 *
 * Shared by the main process (parsers, writers, persistence), the preload
 * bridge and the renderer, so it holds no runtime logic and imports nothing.
 *
 * Every field is nullable by design. Tag data in the wild is partial, malformed
 * and frequently wrong, and a parser that throws or invents a value is worse
 * than one that reports what it could actually read.
 */

/** Container formats Moth can read tags from. */
export type MediaFormat =
  | 'mp3'
  | 'mp4'
  | 'matroska'
  | 'flac'
  | 'ogg'
  | 'wav'
  | 'unknown'

/** Image types accepted for artwork. Determined by magic bytes, never headers. */
export type ArtworkMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface MediaArtwork {
  data: Uint8Array
  mime: ArtworkMime
}

export interface MediaTags {
  format: MediaFormat
  title: string | null
  artist: string | null
  albumArtist: string | null
  album: string | null
  track: number | null
  disc: number | null
  year: number | null
  genre: string | null
  artwork: MediaArtwork | null
}

/** Where a metadata value came from. `manual` always wins over inference. */
export type MediaMetadataSource = 'file' | 'page' | 'filename' | 'manual'

/**
 * A resolved metadata record, as persisted and as shown in the UI.
 * `artworkPath` is a `moth-artwork://` URL, never a filesystem path: the
 * renderer has no filesystem access and must not be handed one.
 */
export interface MediaMetadataView {
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
  artworkUrl: string | null
  artworkMime: ArtworkMime | null
  artworkBytes: number | null
  source: MediaMetadataSource
  /** True once the tags have been written into the downloaded file. */
  writtenAt: number | null
}

/** Metadata offered by the browser extension, or inferred from a URL. */
export interface MediaHint {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  year?: number
  track?: number
  /** Absolute URL of a poster frame or cover image to fetch and store. */
  pageImage?: string
}

/** A manual edit. Omitted fields are left alone; explicit nulls clear. */
export type MediaMetadataPatch = {
  title?: string | null
  artist?: string | null
  albumArtist?: string | null
  album?: string | null
  track?: number | null
  disc?: number | null
  year?: number | null
  genre?: string | null
}

export interface MediaWriteResult {
  written: boolean
  reason?: string
}

/** An all-null tag set, so callers never build one by hand. */
export const emptyTags = (format: MediaFormat = 'unknown'): MediaTags => ({
  format,
  title: null,
  artist: null,
  albumArtist: null,
  album: null,
  track: null,
  disc: null,
  year: null,
  genre: null,
  artwork: null
})

/** True when at least one human-meaningful field is populated. */
export function hasAnyTag(tags: MediaTags): boolean {
  return Boolean(
    tags.title ||
      tags.artist ||
      tags.albumArtist ||
      tags.album ||
      tags.genre ||
      tags.year !== null ||
      tags.track !== null ||
      tags.disc !== null ||
      tags.artwork
  )
}
