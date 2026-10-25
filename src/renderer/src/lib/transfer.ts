import { isYouTubeUrl } from '@shared/mediaUrl.js'
import { isTorrentSource } from '@shared/torrent.js'

/** How a download is actually being transferred. */
export type TransferKind = 'torrent' | 'media' | 'http'

/**
 * Classifies a download from its source URL.
 *
 * Both surfaces that render a download list (the queue rows and the Flow
 * visualization) must agree on this, otherwise the same download looks like two
 * different things in two places. Keep this the only classifier.
 */
export function getTransferKind(url: string): TransferKind {
  if (isTorrentSource(url)) return 'torrent'
  if (isYouTubeUrl(url)) return 'media'
  return 'http'
}

const LABELS: Record<TransferKind, string> = {
  torrent: 'Torrent',
  media: 'Media',
  http: 'HTTP'
}

/** Short badge text, e.g. for a list row. */
export function transferLabel(kind: TransferKind): string {
  return LABELS[kind]
}

/** Longer label naming the engine behind the transfer. */
export function transferEngineName(kind: TransferKind): string {
  if (kind === 'torrent') return 'Transmission'
  if (kind === 'media') return 'yt-dlp'
  return 'HTTP range'
}