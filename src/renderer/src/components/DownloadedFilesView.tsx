import type { DownloadCategory, DownloadSnapshot } from '@shared/types.js'
import { isTorrentSource } from '@shared/torrent.js'
import { CategoryBadge } from './CategoryBadge.js'
import { DownloadContextMenu, useDownloadContextMenu } from './DownloadContextMenu.js'
import { IconExternal, IconFolder } from './Icons.js'
import { CATEGORY_LABEL, formatBytes, formatDateTime } from '../lib/format.js'

interface Props {
  downloads: DownloadSnapshot[]
  category: DownloadCategory | 'all'
  developerMode: boolean
  onOpenFile: (id: string) => void
  onOpenFolder: (id: string) => void
  onOpenSource: (id: string) => void
  onViewSource: (id: string) => void
  onCopySource: (id: string) => void
  onCopyPath: (path: string) => void
  onReveal: (id: string) => void
  onRemove: (id: string) => void
}

export function DownloadedFilesView({
  downloads,
  category,
  developerMode,
  onOpenFile,
  onOpenFolder,
  onOpenSource,
  onViewSource,
  onCopySource,
  onCopyPath,
  onReveal,
  onRemove
}: Props): React.ReactElement {
  return (
    <div className="mx-auto max-w-[1120px]">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5 sm:px-6">
        <h1 className="text-[12px] font-semibold text-ink">
          {category === 'all' ? 'Downloaded files' : CATEGORY_LABEL[category]}
        </h1>
        <span className="font-mono text-[10.5px] tabular-nums text-muted">
          {downloads.length} {downloads.length === 1 ? 'file' : 'files'}
        </span>
      </div>
      <ul>
        {downloads.map((download) => (
          <FilesRow
            key={download.id}
            download={download}
            developerMode={developerMode}
            onOpenFile={onOpenFile}
            onOpenFolder={onOpenFolder}
            onOpenSource={onOpenSource}
            onViewSource={onViewSource}
            onCopySource={onCopySource}
            onCopyPath={onCopyPath}
            onReveal={onReveal}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </div>
  )
}

function FilesRow({
  download,
  developerMode,
  onOpenFile,
  onOpenFolder,
  onOpenSource,
  onViewSource,
  onCopySource,
  onCopyPath,
  onReveal,
  onRemove
}: Omit<Props, 'downloads' | 'category'> & { download: DownloadSnapshot }): React.ReactElement {
  const contextMenu = useDownloadContextMenu()
  const torrent = isTorrentSource(download.url)
  return (
    <li
      onContextMenu={contextMenu.onContextMenu}
      className="relative border-b border-line px-4 py-2.5 transition-colors hover:bg-[color:var(--surface-2)] sm:px-6"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <CategoryBadge category={download.category} completed size="sm" />
        <div className="min-w-0 flex-1">
          <p className="selectable truncate text-[12px] font-medium text-ink" title={download.filename}>
            {download.filename}
          </p>
          <p className="mt-0.5 truncate text-[10.5px] text-muted">
            {CATEGORY_LABEL[download.category] ?? 'File'} · {formatBytes(download.fileSize)} · downloaded{' '}
            <time dateTime={new Date(download.completedAt ?? download.updatedAt).toISOString()}>
              {formatDateTime(download.completedAt ?? download.updatedAt)}
            </time>
          </p>
          {developerMode && download.finalPath ? (
            <p className="selectable mt-1 break-all font-mono text-[10px] text-muted">
              {download.finalPath}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onOpenFile(download.id)}
            title={torrent ? 'Open torrent folder' : 'Open downloaded file'}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10.5px] font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink"
          >
            <IconExternal size={12} /> Open
          </button>
          <button
            type="button"
            onClick={() => onOpenFolder(download.id)}
            title={torrent ? 'Open the torrent folder' : 'Open the containing folder'}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10.5px] font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink"
          >
            <IconFolder size={12} /> {torrent ? 'Torrent folder' : 'Open folder'}
          </button>
        </div>
      </div>
      <DownloadContextMenu
        download={download}
        position={contextMenu.position}
        menuRef={contextMenu.menuRef}
        onClose={contextMenu.close}
        onOpenSource={onOpenSource}
        onViewSource={onViewSource}
        onCopySource={onCopySource}
        onOpenFile={onOpenFile}
        onReveal={onReveal}
        onCopyPath={onCopyPath}
        onRemove={onRemove}
      />
    </li>
  )
}
