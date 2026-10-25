/**
 * One download row.
 *
 * Redesigned for scannability. The changes that matter:
 *
 *  - **One percentage, not two.** The previous row showed `1.6%` in the size
 *    column and `2%` beside the bar, which reads as a contradiction and
 *    undermines every other number on screen.
 *  - **A continuous bar instead of a 160-cell barcode.** The chunk map is
 *    genuinely useful, but it is diagnostic information. It now lives in the
 *    expanded panel, where it can be labelled and read properly, instead of
 *    competing with the filename for attention.
 *  - **Status as a pill** so a long list can be scanned.
 *  - **A left edge that encodes state** (accent while active, rose on failure),
 *    which is readable even in a narrow window.
 */

import { memo, useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { DownloadSnapshot } from '@shared/types.js'
import { isYouTubeUrl } from '@shared/mediaUrl.js'
import { isTorrentSource } from '@shared/torrent.js'
import { CategoryBadge } from './CategoryBadge.js'
import { StatusPill } from './StatusPill.js'
import { ArtworkThumb } from './ArtworkThumb.js'
import { ChunkMap } from './ChunkMap.js'
import { DownloadDetailsDialog } from './DownloadDetailsDialog.js'
import { Field, Modal, inputClass } from './Modal.js'
import { MediaPanel } from './MediaPanel.js'
import { RefreshLinkDialog } from './RefreshLinkDialog.js'
import { DownloadContextMenu, useDownloadContextMenu } from './DownloadContextMenu.js'
import {
  IconClose,
  IconChart,
  IconExternal,
  IconFolder,
  IconGauge,
  IconPause,
  IconPlay,
  IconRetry,
  IconShield,
  IconLink
} from './Icons.js'
import {
  STATUS_LABELS,
  formatBytes,
  formatDuration,
  formatRate,
  formatRelative,
  isActive
} from '../lib/format.js'
import {
  fromBytesPerSecond,
  SPEED_LIMIT_UNIT_OPTIONS,
  toBytesPerSecond,
  type SpeedLimitUnit
} from '@shared/speedLimit.js'
import { fromQuotaBytes, toQuotaBytes } from '@shared/quota.js'
import { getHttpResumeCapability } from '@shared/resumeCapability.js'
import { TransferBadge } from './TransferBadge.js'

interface Props {
  download: DownloadSnapshot
  developerMode: boolean
  activeConnections: number
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onStartReview: (id: string) => void
  onConfigureReview: (id: string) => void
  onRefreshUrl: (id: string, url: string) => Promise<void>
  onVerifyDownload: NonNullable<React.ComponentProps<typeof DownloadDetailsDialog>['onVerifyDownload']>
  onRemove: (id: string) => void
  onReveal: (id: string) => void
  onOpenFolder: (id: string) => void
  onOpenFile: (id: string) => void
  onOpenSource: (id: string) => void
  onViewSource: (id: string) => void
  onCopySource: (id: string) => void
  onCopyPath: (path: string) => void
  onSetSpeedLimit: (id: string, speedLimit: number | null) => void
  onSetUploadSpeedLimit: (id: string, speedLimit: number | null) => void
  onSetTorrentFiles: (id: string, indexes: number[]) => Promise<void>
  onSetPriority: (id: string, priority: number) => void
  onSetQuota: (id: string, quotaBytes: number | null) => void
  onSaveMetadata: (id: string, patch: Record<string, string | number | null>) => Promise<void>
  onWriteTags: (id: string) => Promise<{ written: boolean; reason?: string }>
}

/** The chunk bitmap, rendered as a continuous strip. */
function DownloadRowComponent(props: Props): React.ReactElement {
  const { download: d } = props
  const [expanded, setExpanded] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [refreshOpen, setRefreshOpen] = useState(false)
  const [optionDialog, setOptionDialog] = useState<'limit' | 'priority' | 'quota' | null>(null)
  const contextMenu = useDownloadContextMenu()
  const [fileIcon, setFileIcon] = useState<{ id: string; path: string; url: string } | null>(null)
  const [failedFileIcon, setFailedFileIcon] = useState(false)

  const fraction = d.fileSize > 0 ? d.downloadedBytes / d.fileSize : 0
  const live = isActive(d.status)
  const finished = d.status === 'completed'
  const failed = d.status === 'failed'
  const quotaPaused = d.status === 'paused' && d.errorCode === 'PAUSED'
  const canConfigureTransfer = d.status !== 'completed' && d.status !== 'canceled'
  const percent = Math.min(100, Math.max(0, fraction * 100))
  const percentText = percent >= 99.95 ? '100' : percent < 10 ? percent.toFixed(1) : percent.toFixed(0)
  const youtubeTransfer = isYouTubeUrl(d.url)
  const torrentTransfer = isTorrentSource(d.url)
  const resumeCapability = getHttpResumeCapability({
    fileSize: d.fileSize,
    acceptRanges: d.acceptRanges,
    etag: d.etag,
    lastModified: d.lastModified
  })
  const hasWindowsExecutableIcon =
    finished &&
    window.moth.platform === 'win32' &&
    d.filename.toLowerCase().endsWith('.exe') &&
    d.finalPath !== null
  const fileIconUrl =
    !failedFileIcon &&
    hasWindowsExecutableIcon &&
    fileIcon?.id === d.id &&
    fileIcon.path === d.finalPath
      ? fileIcon.url
      : null

  const toggle = useCallback(() => setExpanded((value) => !value), [])

  useEffect(() => {
    let cancelled = false
    const finalPath = d.finalPath
    setFailedFileIcon(false)
    if (!hasWindowsExecutableIcon || !finalPath) {
      setFileIcon(null)
      return
    }

    void window.moth.invoke.getDownloadFileIcon({ id: d.id }).then((url) => {
      if (!cancelled) {
        setFileIcon(url ? { id: d.id, path: finalPath, url } : null)
      }
    }).catch((error: unknown) => {
      console.error('Could not load downloaded executable icon', error)
    })

    return () => {
      cancelled = true
    }
  }, [d.id, d.finalPath, hasWindowsExecutableIcon])

  return (
    <div
      data-status={d.status}
      onContextMenu={contextMenu.onContextMenu}
      className={[
        'group relative border-b border-line px-4 py-2.5 transition-colors',
        live ? 'bg-[color:var(--surface-2)]' : 'hover:bg-[color:var(--surface-3)]/50',
        expanded ? 'bg-[color:var(--surface-2)]' : ''
      ].join(' ')}
    >
      {/* Left edge encodes state, readable even in a narrow window. */}
      <span
        aria-hidden
        className={[
          'absolute inset-y-0 left-0 w-[3px] transition-colors',
          failed
            ? 'bg-[color:var(--color-bad)]'
            : live
              ? 'bg-[color:var(--color-brand-500)]'
              : finished
                ? 'bg-[color:var(--color-ok)]'
                : 'bg-transparent'
        ].join(' ')}
      />

      {/* Dense two-line row: icon, name + host, numbers, three actions. */}
      <div className="flex items-center gap-3 pl-1">
        {fileIconUrl ? (
          <img
            src={fileIconUrl}
            alt=""
            title="Downloaded file icon"
            width={32}
            height={32}
            className="size-8 shrink-0 rounded-lg bg-[color:var(--surface-3)] p-0.5 object-contain"
            onError={() => setFailedFileIcon(true)}
          />
        ) : d.metadata?.artworkUrl ? (
          <ArtworkThumb
            artworkUrl={d.metadata.artworkUrl}
            category={d.category}
            completed={finished}
            failed={failed}
          />
        ) : (
          <CategoryBadge category={d.category} completed={finished} failed={failed} />
        )}

        {/* Line one: name. Line two: status pill + host. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className="selectable truncate text-[13.5px] font-medium text-ink"
              title={d.filename}
            >
              {d.filename}
            </span>
            {d.expectedChecksum ? (
              <span
                title={`${d.expectedChecksum.algorithm.toUpperCase()} digest to verify against`}
                className="shrink-0 text-[color:var(--color-ok)]"
              >
                <IconShield size={12} />
              </span>
            ) : null}
            {d.speedLimit ? (
              <span
                title={`Limited to ${formatRate(d.speedLimit)}`}
                className="shrink-0 text-[color:var(--color-info)]"
              >
                <IconGauge size={12} />
              </span>
            ) : null}
            {refreshOpen ? (
              <RefreshLinkDialog
                download={d}
                onClose={() => setRefreshOpen(false)}
                onSubmit={props.onRefreshUrl}
              />
            ) : null}
            {detailsOpen ? (
              <DownloadDetailsDialog
                key={d.id}
                download={d}
                activeConnections={props.activeConnections}
                developerMode={props.developerMode}
                onClose={() => setDetailsOpen(false)}
                onVerifyDownload={props.onVerifyDownload}
                onSetSpeedLimit={props.onSetSpeedLimit}
                onSetUploadSpeedLimit={props.onSetUploadSpeedLimit}
                onSetTorrentFiles={props.onSetTorrentFiles}
              />
            ) : null}
            {optionDialog === 'limit' ? (
              <DownloadLimitDialog
                initialSpeedLimit={d.speedLimit}
                onClose={() => setOptionDialog(null)}
                onSave={(speedLimit) => {
                  props.onSetSpeedLimit(d.id, speedLimit)
                  setOptionDialog(null)
                }}
              />
            ) : optionDialog === 'priority' ? (
              <DownloadPriorityDialog
                initialPriority={d.priority}
                onClose={() => setOptionDialog(null)}
                onSave={(priority) => {
                  props.onSetPriority(d.id, priority)
                  setOptionDialog(null)
                }}
              />
            ) : optionDialog === 'quota' ? (
              <DownloadQuotaDialog
                initialQuotaBytes={d.quotaBytes}
                onClose={() => setOptionDialog(null)}
                onSave={(quotaBytes) => {
                  props.onSetQuota(d.id, quotaBytes)
                  setOptionDialog(null)
                }}
              />
            ) : null}
          </div>

          <div className="mt-1 flex min-w-0 items-center gap-2 text-[11.5px] text-muted">
            <StatusPill status={d.status} live={live} />
            <TransferBadge url={d.url} />
            {/* Transfer progress stands in for the raw URL, which is long and
                mostly tracking noise. Right-click the row to view, copy, or
                replace it. */}
            {torrentTransfer ? (
              <span className="truncate" title="Transmission verifies torrent pieces; Moth keeps no HTTP chunk map for this transfer">
                {live ? `${props.activeConnections} peers · Transmission` : 'Transmission'}
              </span>
            ) : youtubeTransfer ? (
              <span className="truncate" title="Transferred by yt-dlp; Moth keeps no HTTP chunk map for this transfer">
                {live ? `${formatBytes(d.downloadedBytes)} via yt-dlp` : 'yt-dlp'}
              </span>
            ) : d.chunksTotal > 0 ? (
              <span className="truncate font-mono tabular-nums" title="Durable chunk map: ranges fsynced to disk">
                {d.chunksComplete} / {d.chunksTotal} chunks
              </span>
            ) : (
              <span className="truncate">awaiting probe</span>
            )}
            {d.status === 'review' && d.errorMessage ? (
              <span className="shrink-0 text-[color:var(--color-warn)]" title={d.errorMessage}>
                lookup needs attention
              </span>
            ) : null}
            {!youtubeTransfer && !torrentTransfer && !finished ? (
              <span
                className={[
                  'shrink-0',
                  resumeCapability.support === 'safe'
                    ? 'text-[color:var(--color-ok)]'
                    : resumeCapability.support === 'restart'
                      ? 'text-[color:var(--color-warn)]'
                      : 'text-muted'
                ].join(' ')}
                title={resumeCapability.explanation}
              >
                {resumeCapability.label}
              </span>
            ) : null}
          </div>
        </div>

        {/* Numbers: exactly one percentage or live rate, right-aligned. */}
        <div className="hidden w-32 shrink-0 text-right sm:block">
          {live ? (
            <>
              <div className="font-mono text-[13px] font-semibold tabular-nums text-[color:var(--color-brand-600)] dark:text-[color:var(--color-brand-300)]">
                {formatRate(d.speed)}
              </div>
              <div
                className="truncate font-mono text-[10.5px] tabular-nums text-muted"
                title={youtubeTransfer
                  ? `${formatBytes(d.downloadedBytes)} downloaded${
                      d.fileSize > 0 ? ` of ${formatBytes(d.fileSize)}` : ''
                    } · ${d.eta === null ? 'estimating remaining time' : `${formatDuration(d.eta)} remaining`}`
                  : `${props.activeConnections} active connections · ${
                      d.eta === null ? 'estimating remaining time' : `${formatDuration(d.eta)} remaining`
                    }`}
              >
                {youtubeTransfer
                  ? `${formatBytes(d.downloadedBytes)} · ${d.eta === null ? 'estimating' : formatDuration(d.eta)}`
                  : `${props.activeConnections} conn · ${d.eta === null ? 'estimating' : formatDuration(d.eta)}`}
              </div>
            </>
          ) : (
            <>
              <div className="font-mono text-[13px] font-semibold tabular-nums text-ink-2">
                {percentText}%
              </div>
              <div className="font-mono text-[11px] tabular-nums text-muted">
                {finished ? formatBytes(d.fileSize) : STATUS_LABELS[d.status] ?? d.status}
              </div>
            </>
          )}
        </div>

        {/* Actions: primary (pause/play/retry/open), close, expand. */}
        <div className="flex shrink-0 items-center gap-1">
          {!finished ? (
            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink"
              aria-label={`Open download details for ${d.filename}`}
            >
              <IconChart size={14} />
              <span>Details</span>
            </button>
          ) : null}
          {live ? (
            <RowButton label="Pause" onClick={() => props.onPause(d.id)}>
              <IconPause size={14} />
            </RowButton>
          ) : d.status === 'review' ? (
            <>
              <RowButton label="Configure" onClick={() => props.onConfigureReview(d.id)}>
                <IconGauge size={14} />
              </RowButton>
              <RowButton label="Start" onClick={() => props.onStartReview(d.id)} accent>
                <IconPlay size={13} />
              </RowButton>
            </>
          ) : finished ? (
            <RowButton label="Open file" onClick={() => props.onOpenFile(d.id)}>
              <IconExternal size={14} />
            </RowButton>
          ) : d.status === 'canceled' ? null : failed ? (
            <RowButton label="Retry" onClick={() => props.onRetry(d.id)} accent>
              <IconRetry size={14} />
            </RowButton>
          ) : (
            <RowButton label="Resume" onClick={() => props.onResume(d.id)} accent>
              <IconPlay size={13} />
            </RowButton>
          )}

          {(failed || d.status === 'paused') && !youtubeTransfer ? (
            <RowButton label="Replace link" onClick={() => setRefreshOpen(true)}>
              <IconLink size={14} />
            </RowButton>
          ) : null}

          <RowButton label="Remove" onClick={() => props.onRemove(d.id)} danger>
            <IconClose size={14} />
          </RowButton>

          <button
            type="button"
            onClick={toggle}
            className="grid size-9 place-items-center rounded-md text-muted transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink"
            aria-label={expanded ? 'Hide extra download information' : 'Show extra download information'}
            title={expanded ? 'Hide extra information' : 'Show extra information'}
            aria-expanded={expanded}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              aria-hidden
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Thin progress bar spanning the full row. */}
      <div className="mt-2 pl-1">
        {d.status === 'connecting' || (live && d.fileSize <= 0) ? (
          <div className="bar">
            <div
              className={[
                'animate-indeterminate h-full w-1/4 rounded-full',
                d.status === 'connecting' ? 'bg-[color:var(--color-warn)]' : 'bg-[color:var(--color-brand-500)]'
              ].join(' ')}
            />
          </div>
        ) : (
          <div className="bar" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
            <div className="bar-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>

      {/* Error banner. The background is a tint of the danger hue rather than a
          fixed "soft" colour, because a fixed dark tint is unreadable once the
          light theme is applied. */}
      {(failed || quotaPaused) && d.errorMessage ? (
        <p
          data-status="failed"
          className="selectable mt-2 ml-1 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px]"
          style={{
            backgroundColor: `color-mix(in oklch, var(${failed ? '--color-bad' : '--color-warn'}) 12%, transparent)`,
            color: 'var(--tone-fg)'
          }}
        >
          <span className="font-semibold">{d.errorCode ?? 'ERROR'}</span>
          <span className="min-w-0 flex-1">{d.errorMessage}</span>
          <button
            type="button"
            onClick={() => failed ? props.onRetry(d.id) : props.onResume(d.id)}
            className="shrink-0 font-semibold underline underline-offset-2 hover:text-ink"
          >
            {failed ? 'Retry' : 'Resume'}
          </button>
        </p>
      ) : null}

      {/* Expanded details. The chunk map lives here, where it can be labelled. */}
      {expanded ? (
        <div className="animate-slide-down panel mt-2.5 ml-1 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">
              {youtubeTransfer ? 'Media transfer' : torrentTransfer ? 'Torrent transfer' : 'Chunk map'}
            </span>
            <span className="font-mono text-[10.5px] tabular-nums text-ink-2">
              {youtubeTransfer ? 'yt-dlp' : torrentTransfer ? 'Transmission' : `${d.chunksComplete} / ${d.chunksTotal} verified`}
            </span>
          </div>
          {youtubeTransfer ? (
            <>
              <p className="text-[10.5px] text-muted">
                {finished
                  ? 'The yt-dlp transfer and output validation are complete.'
                  : 'YouTube media uses yt-dlp’s single-stream transfer, not Moth’s chunk map. Paused downloads can resume.'}
              </p>
              {d.mediaRequest?.format === 'video' || d.youtubeVideoOutput ? (
                <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1.5 text-[11px] md:grid-cols-4">
                  <Detail
                    label="Requested quality"
                    value={`Up to ${d.youtubeVideoOutput?.requestedQuality ?? d.mediaRequest?.videoQuality}p`}
                  />
                  {d.youtubeVideoOutput ? (
                    <>
                      <Detail
                        label="Actual output"
                        value={
                          d.youtubeVideoOutput.width && d.youtubeVideoOutput.height
                            ? `${d.youtubeVideoOutput.height}p (${d.youtubeVideoOutput.width}x${d.youtubeVideoOutput.height})`
                            : 'Dimensions unavailable'
                        }
                      />
                      <Detail
                        label="Video / audio"
                        value={`${d.youtubeVideoOutput.videoCodec ?? 'unknown'} / ${d.youtubeVideoOutput.audioCodec ?? 'unknown'}`}
                      />
                      <Detail label="Full-decode validation" value="Passed" />
                    </>
                  ) : (
                    <Detail label="Output details" value="Available after validation" />
                  )}
                </div>
              ) : null}
            </>
          ) : torrentTransfer ? (
            <p className="text-[10.5px] text-muted">
              Transmission verifies torrent pieces; Moth does not use HTTP ranges for this transfer. Seeding stops at completion.
            </p>
          ) : (
            <>
              <ChunkMap bitmap={d.chunkBitmap} total={d.chunksTotal} active={live} />
              <p className="mt-1.5 text-[10.5px] text-muted">
                {d.chunksTotal} ranges, {formatBytes(d.fileSize / Math.max(1, d.chunksTotal))} each.
                {finished
                  ? ' All ranges are verified; this download is complete.'
                  : d.status === 'paused'
                    ? ' Verified ranges are retained for resume.'
                    : live
                      ? ' Completed ranges are verified while the remaining ranges download.'
                      : ' Lit ranges have been durably completed and verified.'}
              </p>
            </>
          )}

          <div className="hairline my-3" />

          {d.metadata ? (
            <MediaPanel
              metadata={d.metadata}
              onSave={(patch) => props.onSaveMetadata(d.id, patch)}
              onWriteTags={() => props.onWriteTags(d.id)}
            />
          ) : null}

          <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[11px] md:grid-cols-4">
            <Detail label="Status" value={STATUS_LABELS[d.status] ?? d.status} />
            <Detail label="Size" value={formatBytes(d.fileSize)} />
            <Detail
              label="Downloaded"
              value={`${formatBytes(d.downloadedBytes)}${
                d.fileSize > 0 ? ` / ${formatBytes(d.fileSize)} (${percentText}%)` : ' (total size unknown)'
              }`}
            />
            <Detail label="Speed" value={live ? formatRate(d.speed) : '—'} />
            <Detail
              label={youtubeTransfer ? 'Transfer engine' : torrentTransfer ? 'Connected peers' : 'Active connections'}
              value={youtubeTransfer ? 'yt-dlp' : live ? String(props.activeConnections) : '—'}
            />
            <Detail label="Remaining" value={d.eta === null ? '—' : formatDuration(d.eta)} />
            {!torrentTransfer ? <Detail label="Range support" value={d.acceptRanges ? 'Yes' : 'No'} /> : null}
            <Detail label="Retries" value={`${d.retryCount} / ${d.maxRetries}`} />
            <Detail label="Priority" value={String(d.priority)} />
            {!torrentTransfer ? <Detail label="Speed limit" value={d.speedLimit ? formatRate(d.speedLimit) : 'none'} /> : null}
            {!torrentTransfer ? <Detail label="Quota" value={d.quotaBytes === null ? 'none' : `${formatBytes(d.quotaBytes)} total`} /> : null}
            <Detail label="Expected hash" value={d.expectedChecksum?.algorithm.toUpperCase() ?? 'none'} />
            <Detail
              label="Computed hash"
              value={d.computedChecksum ? `${d.computedChecksum.slice(0, 12)}…` : '—'}
            />
            <Detail label="Added" value={formatRelative(d.createdAt)} />
            {d.scheduledStartAt ? (
              <Detail label="Scheduled" value={new Date(d.scheduledStartAt).toLocaleString()} />
            ) : null}
            {props.developerMode ? (
              <>
                <Detail label="Download ID" value={d.id} />
                <Detail label="Content type" value={d.contentType ?? 'unknown'} />
                <Detail label="ETag validator" value={d.etag ? 'present' : 'absent'} />
                <Detail label="Last-Modified validator" value={d.lastModified ? 'present' : 'absent'} />
                <Detail label="Updated" value={new Date(d.updatedAt).toLocaleString()} />
                <Detail label="Started" value={d.startedAt ? new Date(d.startedAt).toLocaleString() : 'never'} />
              </>
            ) : null}

          </div>

          <div className="mt-2.5">
            <Detail label="Destination" value="" />
            <p className="selectable break-all font-mono text-[10px] text-muted">
              {d.finalPath ?? d.tempPath}
            </p>
          </div>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <TinyButton onClick={() => props.onReveal(d.id)}>
              <IconFolder size={11} /> Show in folder
            </TinyButton>
            <TinyButton onClick={() => props.onOpenFolder(d.id)}>Open containing folder</TinyButton>
            {live ? (
              <TinyButton onClick={() => props.onCancel(d.id)} danger>
                <IconClose size={11} /> Cancel
              </TinyButton>
            ) : null}
          </div>
        </div>
      ) : null}
      <DownloadContextMenu
        download={d}
        position={contextMenu.position}
        menuRef={contextMenu.menuRef}
        onClose={contextMenu.close}
        onViewSource={() => props.onViewSource(d.id)}
        onOpenSource={props.onOpenSource}
        onCopySource={props.onCopySource}
        onOpenFile={props.onOpenFile}
        onReveal={props.onReveal}
        onCopyPath={props.onCopyPath}
        onPause={props.onPause}
        onResume={props.onResume}
        onRetry={props.onRetry}
        onReplaceLink={() => setRefreshOpen(true)}
        onOpenDetails={() => setDetailsOpen(true)}
        onStartReview={props.onStartReview}
        onConfigureReview={props.onConfigureReview}
        onCancel={props.onCancel}
        onOpenLimit={canConfigureTransfer && !torrentTransfer ? () => setOptionDialog('limit') : undefined}
        onOpenPriority={canConfigureTransfer ? () => setOptionDialog('priority') : undefined}
        onOpenQuota={canConfigureTransfer && !youtubeTransfer && !torrentTransfer ? () => setOptionDialog('quota') : undefined}
        onRemove={props.onRemove}
      />
    </div>
  )
}

function DownloadLimitDialog({
  initialSpeedLimit,
  onClose,
  onSave
}: {
  initialSpeedLimit: number | null
  onClose: () => void
  onSave: (speedLimit: number | null) => void
}): React.ReactElement {
  const initial = initialSpeedLimit === null
    ? { value: '', unit: 'MB/s' as const }
    : fromBytesPerSecond(initialSpeedLimit)
  const [value, setValue] = useState(initial.value)
  const [unit, setUnit] = useState<SpeedLimitUnit>(initial.unit)
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!value.trim()) {
      onSave(null)
      return
    }
    const speedLimit = toBytesPerSecond(value, unit)
    if (speedLimit === null) {
      setError('Enter a download rate greater than 0 and no higher than 1 TB/s.')
      return
    }
    onSave(speedLimit)
  }

  return (
    <Modal
      title="Download limit"
      subtitle="Set the maximum download speed for this item."
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-[color:var(--surface-3)]"
          >
            Cancel
          </button>
          <button
            form="download-speed-limit-form"
            type="submit"
            className="rounded-md bg-[color:var(--color-brand-600)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            Save
          </button>
        </>
      }
    >
      <form id="download-speed-limit-form" onSubmit={submit}>
        <Field label="Limit" hint="Download speed only. Upload traffic is not capped. Leave blank for no limit.">
          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              step="any"
              value={value}
              onChange={(event) => {
                setValue(event.target.value)
                setError(null)
              }}
              className={inputClass}
              aria-label="Download speed limit"
            />
            <select
              value={unit}
              onChange={(event) => {
                setUnit(event.target.value as SpeedLimitUnit)
                setError(null)
              }}
              className={inputClass}
              aria-label="Download speed unit"
            >
              {SPEED_LIMIT_UNIT_OPTIONS.map((speedUnit) => (
                <option key={speedUnit} value={speedUnit}>{speedUnit}</option>
              ))}
            </select>
          </div>
        </Field>
        {error ? <p role="alert" className="text-xs text-[color:var(--color-bad)]">{error}</p> : null}
      </form>
    </Modal>
  )
}

function DownloadPriorityDialog({
  initialPriority,
  onClose,
  onSave
}: {
  initialPriority: number
  onClose: () => void
  onSave: (priority: number) => void
}): React.ReactElement {
  const [value, setValue] = useState(String(initialPriority))
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const priority = Number(value)
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
      setError('Enter a whole-number priority from 0 to 1000.')
      return
    }
    onSave(priority)
  }

  return (
    <Modal
      title="Download priority"
      subtitle="Priority controls queue order."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-[color:var(--surface-3)]">
            Cancel
          </button>
          <button form="download-priority-form" type="submit" className="rounded-md bg-[color:var(--color-brand-600)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
            Save
          </button>
        </>
      }
    >
      <form id="download-priority-form" onSubmit={submit}>
        <Field label="Priority" hint="0 is highest; 1000 is lowest.">
          <input
            type="number"
            min="0"
            max="1000"
            step="1"
            required
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            className={inputClass}
            aria-label="Download priority"
          />
        </Field>
        {error ? <p role="alert" className="text-xs text-[color:var(--color-bad)]">{error}</p> : null}
      </form>
    </Modal>
  )
}

function DownloadQuotaDialog({
  initialQuotaBytes,
  onClose,
  onSave
}: {
  initialQuotaBytes: number | null
  onClose: () => void
  onSave: (quotaBytes: number | null) => void
}): React.ReactElement {
  const [value, setValue] = useState(initialQuotaBytes === null ? '' : fromQuotaBytes(initialQuotaBytes))
  const [error, setError] = useState<string | null>(null)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!value.trim()) {
      onSave(null)
      return
    }
    const quotaBytes = toQuotaBytes(value)
    if (quotaBytes === null) {
      setError('Enter a quota greater than 0 MB.')
      return
    }
    onSave(quotaBytes)
  }

  return (
    <Modal
      title="Download quota"
      subtitle="Pause this download when its saved data reaches the quota."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-[color:var(--surface-3)]">
            Cancel
          </button>
          <button form="download-quota-form" type="submit" className="rounded-md bg-[color:var(--color-brand-600)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
            Save
          </button>
        </>
      }
    >
      <form id="download-quota-form" onSubmit={submit}>
        <Field label="Quota (MB)" hint="Download data only. Leave blank for no quota.">
          <input
            type="number"
            min="0"
            step="any"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            className={inputClass}
            aria-label="Download quota in megabytes"
          />
        </Field>
        {error ? <p role="alert" className="text-xs text-[color:var(--color-bad)]">{error}</p> : null}
      </form>
    </Modal>
  )
}

function Detail({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-muted">{label}</span>
      <span className="truncate font-medium text-ink-2">{value || '—'}</span>
    </div>
  )
}

function RowButton({
  children,
  label,
  onClick,
  accent = false,
  danger = false
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  accent?: boolean
  danger?: boolean
}): React.ReactElement {
  const tone = danger
    ? 'hover:bg-[color:var(--color-bad-soft)] hover:text-[color:var(--color-bad)]'
    : accent
      ? 'hover:bg-[color:var(--color-brand-100)] hover:text-[color:var(--color-brand-600)] dark:hover:text-[color:var(--color-brand-300)]'
      : 'hover:bg-[color:var(--surface-3)] hover:text-ink'
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid size-9 place-items-center rounded-md text-muted transition-colors ${tone}`}
    >
      {children}
    </button>
  )
}

function TinyButton({
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
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
        danger
          ? 'border-[color:var(--color-bad)]/40 text-[color:var(--color-bad)] hover:bg-[color:var(--color-bad-soft)]'
          : 'border-line text-ink-2 hover:bg-[color:var(--surface-2)]'
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// Rows re-render twice a second while active; memoising keeps an idle list from
// re-rendering just because its neighbour is transferring.
export const DownloadRow = memo(DownloadRowComponent)
