import { useCallback, useEffect, useRef, useState } from 'react'
import type { DownloadSnapshot } from '@shared/types.js'
import { isYouTubeUrl } from '@shared/mediaUrl.js'
import { isTorrentSource } from '@shared/torrent.js'
import { formatBytes, formatRate, isActive } from '../lib/format.js'

interface Position {
  x: number
  y: number
}

interface MenuProps {
  download: DownloadSnapshot
  position: Position | null
  menuRef: React.RefObject<HTMLDivElement | null>
  onClose: (action: () => void) => void
  onViewSource: (id: string) => void
  onOpenSource: (id: string) => void
  onCopySource: (id: string) => void
  onOpenFile: (id: string) => void
  onReveal: (id: string) => void
  onCopyPath: (path: string) => void
  onPause?: (id: string) => void
  onResume?: (id: string) => void
  onRetry?: (id: string) => void
  onReplaceLink?: () => void
  onOpenDetails?: () => void
  onStartReview?: (id: string) => void
  onConfigureReview?: (id: string) => void
  onCancel?: (id: string) => void
  onOpenLimit?: () => void
  onOpenPriority?: () => void
  onOpenQuota?: () => void
  onRemove: (id: string) => void
}

export function useDownloadContextMenu(): {
  position: Position | null
  menuRef: React.RefObject<HTMLDivElement | null>
  onContextMenu: React.MouseEventHandler<HTMLElement>
  close: (action?: () => void) => void
} {
  const [position, setPosition] = useState<Position | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!position) return
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) {
        setPosition(null)
      }
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPosition(null)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [position])

  const onContextMenu = useCallback<React.MouseEventHandler<HTMLElement>>((event) => {
    event.stopPropagation()
    event.preventDefault()
    setPosition({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 232)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 480))
    })
  }, [])

  const close = useCallback((action?: () => void): void => {
    setPosition(null)
    action?.()
  }, [])

  return { position, menuRef, onContextMenu, close }
}

export function DownloadContextMenu({
  download,
  position,
  menuRef,
  onClose,
  onViewSource,
  onOpenSource,
  onCopySource,
  onOpenFile,
  onReveal,
  onCopyPath,
  onPause,
  onResume,
  onRetry,
  onReplaceLink,
  onOpenDetails,
  onStartReview,
  onConfigureReview,
  onCancel,
  onOpenLimit,
  onOpenPriority,
  onOpenQuota,
  onRemove
}: MenuProps): React.ReactElement | null {
  if (!position) return null
  const finished = download.status === 'completed'
  const live = isActive(download.status)
  const failed = download.status === 'failed'
  const youtubeTransfer = isYouTubeUrl(download.url)
  const torrentTransfer = isTorrentSource(download.url)
  const completedPath = finished ? download.finalPath : null

  return (
    <div
      ref={menuRef}
      role="group"
      aria-label={`Actions for ${download.filename}`}
      className="fixed z-50 max-h-[calc(100vh-16px)] w-56 overflow-y-auto rounded-lg border border-line-strong bg-[color:var(--surface-2)] p-1 shadow-xl"
      style={{ left: position.x, top: position.y }}
    >
      <ContextAction onClick={() => onClose(() => onViewSource(download.id))}>
        View source link…
      </ContextAction>
      <ContextAction onClick={() => onClose(() => onCopySource(download.id))}>
        Copy source link
      </ContextAction>
      {!torrentTransfer ? (
        <ContextAction onClick={() => onClose(() => onOpenSource(download.id))}>
          Open link in browser
        </ContextAction>
      ) : null}
      {download.status !== 'completed' && onOpenDetails ? (
        <ContextAction onClick={() => onClose(onOpenDetails)}>
          Download details
        </ContextAction>
      ) : null}
      {completedPath ? (
        <>
          <ContextAction onClick={() => onClose(() => onOpenFile(download.id))}>
            {torrentTransfer ? 'Open torrent folder' : 'Open downloaded file'}
          </ContextAction>
          <ContextAction onClick={() => onClose(() => onReveal(download.id))}>
            {torrentTransfer ? 'Show torrent folder in Explorer' : 'Show downloaded file in folder'}
          </ContextAction>
          <ContextAction onClick={() => onClose(() => onCopyPath(completedPath))}>
            {torrentTransfer ? 'Copy torrent folder path' : 'Copy file path'}
          </ContextAction>
        </>
      ) : null}
      {live && onPause ? (
        <ContextAction onClick={() => onClose(() => onPause(download.id))}>
          Pause download
        </ContextAction>
      ) : failed && onRetry ? (
        <ContextAction onClick={() => onClose(() => onRetry(download.id))}>
          Retry download
        </ContextAction>
      ) : download.status !== 'canceled' && download.status !== 'review' && !finished && onResume ? (
        <ContextAction onClick={() => onClose(() => onResume(download.id))}>
          Resume download
        </ContextAction>
      ) : null}
      {download.status === 'review' && onConfigureReview && onStartReview ? (
        <>
          <ContextAction onClick={() => onClose(() => onConfigureReview(download.id))}>
            Configure download
          </ContextAction>
          <ContextAction onClick={() => onClose(() => onStartReview(download.id))}>
            Start download
          </ContextAction>
        </>
      ) : null}
      {live && onCancel ? (
        <ContextAction onClick={() => onClose(() => onCancel(download.id))}>
          Cancel download
        </ContextAction>
      ) : null}
      {(failed || download.status === 'paused') && !youtubeTransfer && !torrentTransfer && onReplaceLink ? (
        <ContextAction onClick={() => onClose(onReplaceLink)}>
          Replace download link
        </ContextAction>
      ) : null}
      <div className="my-1 border-t border-line" />
      {onOpenLimit || onOpenPriority || onOpenQuota ? (
        <>
          <div className="my-1 border-t border-line" />
          {onOpenLimit ? (
            <ContextAction onClick={() => onClose(onOpenLimit)}>
              <span className="flex items-center justify-between gap-3">
                <span>Limit</span>
                <span className="text-muted">{download.speedLimit === null ? 'Not set' : formatRate(download.speedLimit)}</span>
              </span>
            </ContextAction>
          ) : null}
          {onOpenPriority ? (
            <ContextAction onClick={() => onClose(onOpenPriority)}>
              <span className="flex items-center justify-between gap-3">
                <span>Priority</span>
                <span className="text-muted">{download.priority}</span>
              </span>
            </ContextAction>
          ) : null}
          {onOpenQuota ? (
            <ContextAction onClick={() => onClose(onOpenQuota)}>
              <span className="flex items-center justify-between gap-3">
                <span>Quota</span>
                <span className="text-muted">{download.quotaBytes === null ? 'Not set' : `${formatBytes(download.quotaBytes)} total`}</span>
              </span>
            </ContextAction>
          ) : null}
        </>
      ) : null}
      <div className="my-1 border-t border-line" />
      <ContextAction danger onClick={() => onClose(() => onRemove(download.id))}>
        Remove download…
      </ContextAction>
    </div>
  )
}

function ContextAction({
  children,
  onClick,
  danger = false
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'block w-full rounded-md px-2.5 py-1.5 text-left text-[11.5px] transition-colors',
        danger
          ? 'text-[color:var(--color-bad)] hover:bg-[color:var(--color-bad-soft)]'
          : 'text-ink-2 hover:bg-[color:var(--surface-3)] hover:text-ink'
      ].join(' ')}
    >
      {children}
    </button>
  )
}
