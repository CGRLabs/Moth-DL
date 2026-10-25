import { getTransferKind, transferLabel, type TransferKind } from '../lib/transfer.js'

const TONE: Record<TransferKind, string> = {
  torrent: 'border-[color:var(--color-info)]/40 bg-[color:var(--color-info)]/10 text-[color:var(--color-info)]',
  media: 'border-[color:var(--color-warn)]/40 bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn)]',
  http: 'border-line bg-[color:var(--surface-3)] text-muted'
}

/**
 * Marks how a download is transferred. Torrents are verified piece-by-piece by
 * Transmission and media transfers run through yt-dlp, so neither uses Moth's
 * chunk map - without a badge the two are indistinguishable in a list.
 */
export function TransferBadge({
  url,
  title
}: {
  url: string
  title?: string
}): React.ReactElement {
  const kind = getTransferKind(url)
  if (kind === 'http') return <></>
  return (
    <span
      title={title ?? `Transferred by ${transferLabel(kind).toLowerCase()} engine`}
      className={`shrink-0 rounded border px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide ${TONE[kind]}`}
    >
      {transferLabel(kind)}
    </span>
  )
}