import { useEffect, useId, useRef, useState } from 'react'
import { isYouTubeUrl } from '@shared/mediaUrl.js'
import { isTorrentSource } from '@shared/torrent.js'
import { getHttpResumeCapability } from '@shared/resumeCapability.js'
import type {
  ChecksumAlgorithm,
  DownloadSnapshot,
  DownloadVerificationResult,
  TorrentFileView
} from '@shared/types.js'
import { fromQuotaBytes, toQuotaBytes } from '@shared/quota.js'
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRate,
  shortenUrl,
  STATUS_LABELS
} from '../lib/format.js'
import { ChunkMap } from './ChunkMap.js'
import { Modal } from './Modal.js'
import { StatusPill } from './StatusPill.js'
import { MediaPanel } from './MediaPanel.js'
import { RefreshLinkDialog } from './RefreshLinkDialog.js'
import {
  IconClose,
  IconExternal,
  IconFolder,
  IconLink,
  IconPause,
  IconPlay,
  IconRetry
} from './Icons.js'

interface Props {
  download: DownloadSnapshot
  activeConnections: number
  developerMode: boolean
  onClose: () => void
  onPause?: (id: string) => void
  onResume?: (id: string) => void
  onRetry?: (id: string) => void
  onCancel?: (id: string) => void
  onRemove?: (id: string) => void
  onStartReview?: (id: string) => void
  onConfigureReview?: (id: string) => void
  onRefreshUrl?: (id: string, url: string) => Promise<void>
  onVerifyDownload?: (id: string) => Promise<DownloadVerificationResult>
  onReveal?: (id: string) => void
  onOpenFolder?: (id: string) => void
  onOpenFile?: (id: string) => void
  onOpenSource?: (id: string) => void
  onCopySource?: (id: string) => void
  onCopyPath?: (path: string) => void
  onSetPriority?: (id: string, priority: number) => void
  onSetSpeedLimit?: (id: string, speedLimit: number | null) => void
  onSetUploadSpeedLimit?: (id: string, speedLimit: number | null) => void
  onSetTorrentFiles?: (id: string, indexes: number[]) => Promise<void>
  onSetQuota?: (id: string, quotaBytes: number | null) => void
  onSaveMetadata?: (id: string, patch: Record<string, string | number | null>) => Promise<void>
  onWriteTags?: (id: string) => Promise<{ written: boolean; reason?: string }>
}

const SAMPLE_INTERVAL_MS = 500
const SAMPLE_COUNT = 60

export function DownloadDetailsDialog({
  download,
  activeConnections,
  developerMode,
  onClose,
  onPause,
  onResume,
  onRetry,
  onCancel,
  onRemove,
  onStartReview,
  onConfigureReview,
  onRefreshUrl,
  onVerifyDownload,
  onReveal,
  onOpenFolder,
  onOpenFile,
  onOpenSource,
  onCopySource,
  onCopyPath,
  onSetPriority,
  onSetSpeedLimit,
  onSetUploadSpeedLimit,
  onSetTorrentFiles,
  onSetQuota,
  onSaveMetadata,
  onWriteTags
}: Props): React.ReactElement {
  const live = download.status === 'connecting' || download.status === 'downloading'
  const speedRef = useRef(live ? download.speed : 0)
  const [speedSamples, setSpeedSamples] = useState<number[]>([Math.max(0, live ? download.speed : 0)])
  const [priority, setPriority] = useState(String(download.priority))
  const [quota, setQuota] = useState(download.quotaBytes === null ? '' : fromQuotaBytes(download.quotaBytes))
  const [refreshOpen, setRefreshOpen] = useState(false)
  const [verification, setVerification] = useState<DownloadVerificationResult | null>(null)
  const [verificationError, setVerificationError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [torrentFiles, setTorrentFiles] = useState<TorrentFileView[] | null>(null)
  const [torrentFilesError, setTorrentFilesError] = useState<string | null>(null)
  const [torrentFileQuery, setTorrentFileQuery] = useState('')
  const [selectedTorrentFiles, setSelectedTorrentFiles] = useState<Set<number>>(
    () => new Set(download.torrentFiles ?? [])
  )
  const [torrentFilesSaving, setTorrentFilesSaving] = useState(false)
  const chartId = useId().replace(/:/g, '')
  const fraction = download.fileSize > 0
    ? Math.min(1, Math.max(0, download.downloadedBytes / download.fileSize))
    : 0
  const percent = Math.round(fraction * 100)
  const isMediaPipeline = isYouTubeUrl(download.url)
  const isTorrent = isTorrentSource(download.url)
  const resumeCapability = getHttpResumeCapability({
    fileSize: download.fileSize,
    acceptRanges: download.acceptRanges,
    etag: download.etag,
    lastModified: download.lastModified
  })
  const displayedRate = live ? download.speed : 0
  const displayedConnections = live ? activeConnections : 0
  const visibleTorrentFiles = (torrentFiles ?? [])
    .filter((file) => file.name.toLowerCase().includes(torrentFileQuery.trim().toLowerCase()))
    .slice(0, 200)

  useEffect(() => {
    if (!isTorrent) return
    let active = true
    let pending = false
    const loadFiles = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const files = await window.moth.invoke.getTorrentFiles({ id: download.id })
        if (!active) return
        setTorrentFiles(files)
        setTorrentFilesError(null)
        if (files && selectedTorrentFiles.size === 0) {
          setSelectedTorrentFiles(new Set(
            download.torrentFiles ?? files.filter((file) => file.wanted).map((file) => file.index)
          ))
        }
      } catch (error) {
        if (active) setTorrentFilesError(error instanceof Error ? error.message : String(error))
      } finally {
        pending = false
      }
    }
    void loadFiles()
    const timer = setInterval(() => {
      if (!torrentFiles) void loadFiles()
    }, 2500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [isTorrent, download.id, download.torrentFiles, torrentFiles])

  speedRef.current = displayedRate

  useEffect(() => {
    const timer = setInterval(() => {
      setSpeedSamples((current) => [
        ...current.slice(-(SAMPLE_COUNT - 1)),
        Math.max(0, speedRef.current)
      ])
    }, SAMPLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [download.id])

  const maxRate = Math.max(1, ...speedSamples)
  const line = speedSamples.map((rate, index) => {
    const x = ((SAMPLE_COUNT - speedSamples.length + index) / (SAMPLE_COUNT - 1)) * 600
    const y = 104 - (rate / maxRate) * 92
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
  const firstX = ((SAMPLE_COUNT - speedSamples.length) / (SAMPLE_COUNT - 1)) * 600
  const area = `${line} L 600 112 L ${firstX.toFixed(1)} 112 Z`
  const connectionsToShow = Math.min(displayedConnections, 16)

  const verifyDownload = async (): Promise<void> => {
    if (!onVerifyDownload) return
    setVerification(null)
    setVerificationError(null)
    setVerifying(true)
    try {
      setVerification(await onVerifyDownload(download.id))
    } catch (error) {
      setVerificationError(error instanceof Error ? error.message : String(error))
    } finally {
      setVerifying(false)
    }
  }

  return (
    <>
      <Modal
        title="Download details"
        subtitle={download.filename}
        onClose={onClose}
        wide
      >
      <div className="space-y-4">
        <section className="panel overflow-hidden p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill
                  status={download.status}
                  label={STATUS_LABELS[download.status] ?? download.status}
                  live={live && download.speed > 0}
                />
                {live ? (
                  <span className="text-[10.5px] font-medium text-[color:var(--color-brand-300)]">
                    LIVE
                  </span>
                ) : null}
              </div>
              <h3 className="mt-3 break-words text-base font-semibold text-ink">{download.filename}</h3>
              <p className="mt-1 truncate text-[11px] text-muted" title={shortenUrl(download.url, 120)}>
                {shortenUrl(download.url, 100)}
              </p>
            </div>
            <ProgressRing fraction={fraction} percent={percent} indeterminate={download.fileSize <= 0 && live} />
          </div>

          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[11px]">
              <span className="font-mono tabular-nums text-ink-2">
                {formatBytes(download.downloadedBytes)}
                {download.fileSize > 0 ? ` of ${formatBytes(download.fileSize)}` : ' received'}
              </span>
              <span className="font-mono tabular-nums text-muted">
                {download.fileSize > 0 ? `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%` : 'Total size unknown'}
              </span>
            </div>
            <div className="bar h-2">
              {download.fileSize > 0 ? (
                <div className="bar-fill transition-[width] duration-500" style={{ width: `${fraction * 100}%` }} />
              ) : live ? (
                <div className="animate-indeterminate h-full w-1/4 rounded-full bg-[color:var(--color-brand-500)]" />
              ) : null}
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-[minmax(0,1.55fr)_minmax(210px,1fr)]">
          <div className="panel p-3.5">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Transfer speed
                </h3>
                <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-ink">
                  {formatRate(displayedRate)}
                </p>
              </div>
              <span className="pt-0.5 text-[10px] text-muted">Last 30 seconds</span>
            </div>
            <svg
              viewBox="0 0 600 116"
              preserveAspectRatio="none"
              role="img"
              aria-label={`Download speed over the last 30 seconds; current ${formatRate(displayedRate)}, sampled twice per second`}
              className="h-24 w-full overflow-visible"
            >
              <defs>
                <linearGradient id={`${chartId}-fill`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-brand-400)" stopOpacity=".35" />
                  <stop offset="100%" stopColor="var(--color-brand-400)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[12, 58, 104].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2="600"
                  y1={y}
                  y2={y}
                  stroke="var(--line)"
                  strokeDasharray="3 5"
                />
              ))}
              <path d={area} fill={`url(#${chartId}-fill)`} />
              <path
                d={line}
                fill="none"
                stroke="var(--color-brand-400)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <div className="mt-1 flex justify-between font-mono text-[9.5px] tabular-nums text-muted">
              <span>30s ago</span>
              <span>now</span>
            </div>
          </div>

          <div className="panel flex flex-col p-3.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {isTorrent ? 'Connected peers' : 'Connection workers'}
            </h3>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-ink">
              {isMediaPipeline ? 'yt-dlp' : displayedConnections}
            </p>
            <p className="mt-0.5 text-[10.5px] text-muted">
              {isMediaPipeline
                ? 'Provider-managed media transfer'
                : isTorrent
                  ? displayedConnections === 1 ? 'connected peer' : 'connected peers'
                  : displayedConnections === 1
                    ? 'active connection'
                    : 'active connections'}
            </p>
            {!isMediaPipeline ? (
              <div className="mt-3 flex min-h-5 flex-wrap items-center gap-1.5" aria-hidden>
                {Array.from({ length: connectionsToShow }, (_, index) => (
                  <span
                    key={index}
                    className={`size-2.5 rounded-full ${live ? 'animate-pulse-soft bg-[color:var(--color-brand-400)]' : 'bg-[color:var(--line-strong)]'}`}
                    style={live ? { animationDelay: `${index * 70}ms` } : undefined}
                  />
                ))}
                {displayedConnections > connectionsToShow ? (
                  <span className="ml-1 font-mono text-[10px] text-muted">+{displayedConnections - connectionsToShow}</span>
                ) : null}
                {displayedConnections === 0 ? (
                  <span className="text-[10.5px] text-muted">
                    {isTorrent ? 'No peers connected' : 'No workers active'}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="mt-auto pt-4">
              <div className="flex justify-between gap-2 text-[10.5px]">
                <span className="text-muted">Remaining</span>
                <span className="font-medium tabular-nums text-ink-2">
                  {live ? formatDuration(download.eta) : download.status === 'completed' ? 'Complete' : '—'}
                </span>
              </div>
              {!isTorrent ? (
                <div className="mt-1.5 flex justify-between gap-2 text-[10.5px]">
                  <span className="text-muted">Speed cap</span>
                  <span className="font-medium tabular-nums text-ink-2">
                    {download.speedLimit ? formatRate(download.speedLimit) : 'Unlimited'}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {isMediaPipeline ? (
          <section className="panel p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Media transfer
                </h3>
                <p className="mt-1 text-[11px] text-ink-2">
                  yt-dlp manages the media fragments. Moth displays aggregate progress; individual fragment states are not exposed.
                </p>
              </div>
              <span className="rounded-full border border-line px-2 py-1 text-[10px] font-medium text-ink-2">yt-dlp</span>
            </div>
            {download.mediaRequest?.format === 'video' || download.youtubeVideoOutput ? (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Requested quality" value={`Up to ${download.youtubeVideoOutput?.requestedQuality ?? download.mediaRequest?.videoQuality}p`} />
                <Metric
                  label="Validated output"
                  value={download.youtubeVideoOutput?.height
                    ? `${download.youtubeVideoOutput.height}p`
                    : 'After processing'}
                />
                <Metric
                  label="Video / audio"
                  value={download.youtubeVideoOutput
                    ? `${download.youtubeVideoOutput.videoCodec ?? '—'} / ${download.youtubeVideoOutput.audioCodec ?? '—'}`
                    : 'Processing'}
                />
                <Metric
                  label="Full decode"
                  value={download.youtubeVideoOutput ? 'Passed' : 'Pending'}
                />
              </div>
            ) : null}
          </section>
        ) : isTorrent ? (
          <section className="panel p-3.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Transmission torrent</h3>
            <p className="mt-1 text-[10.5px] text-muted">
              Transmission verifies torrent pieces. Seeding stops when the torrent completes.
            </p>
            <Metric label="Connected peers" value={String(displayedConnections)} />
            {torrentFilesError ? (
              <p role="alert" className="mt-2 text-[11px] text-[color:var(--color-bad)]">{torrentFilesError}</p>
            ) : null}
            {torrentFiles === null ? (
              <p className="mt-2 text-[11px] text-muted">
                {download.status === 'connecting' || download.status === 'downloading'
                  ? 'Waiting for torrent metadata from peers…'
                  : 'Start or resume the torrent to retrieve its file list.'}
              </p>
            ) : torrentFiles.length > 0 ? (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="sr-only" htmlFor="torrent-file-search">Filter torrent files</label>
                  <input
                    id="torrent-file-search"
                    type="search"
                    value={torrentFileQuery}
                    onChange={(event) => setTorrentFileQuery(event.target.value)}
                    placeholder="Filter files…"
                    className="min-w-0 flex-1 rounded-md border border-line bg-[color:var(--surface)] px-2 py-1.5 text-[11px] text-ink"
                  />
                  <span className="text-[10px] text-muted">
                    {selectedTorrentFiles.size} selected / {torrentFiles.length}
                  </span>
                </div>
                <div className="max-h-56 overflow-y-auto rounded-md border border-line">
                  {visibleTorrentFiles.map((file) => (
                    <label
                      key={file.index}
                      className="flex items-start gap-2 border-b border-line px-2 py-1.5 last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        checked={selectedTorrentFiles.has(file.index)}
                        onChange={(event) => {
                          setSelectedTorrentFiles((current) => {
                            const next = new Set(current)
                            if (event.target.checked) next.add(file.index)
                            else next.delete(file.index)
                            return next
                          })
                        }}
                        className="mt-0.5 accent-[color:var(--color-brand-500)]"
                      />
                      <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-2" title={file.name}>
                        {file.name}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted">
                        {formatBytes(file.size)}
                      </span>
                    </label>
                  ))}
                  {visibleTorrentFiles.length === 0 ? (
                    <p className="px-2 py-2 text-[10px] text-muted">No matching files.</p>
                  ) : null}
                  {torrentFiles.filter((file) => file.name.toLowerCase().includes(torrentFileQuery.trim().toLowerCase())).length > 200 ? (
                    <p className="border-t border-line px-2 py-1.5 text-[10px] text-muted">
                      Showing the first 200 matches. Filter by name to narrow the list.
                    </p>
                  ) : null}
                </div>
                {onSetTorrentFiles ? (
                  <button
                    type="button"
                    disabled={selectedTorrentFiles.size === 0 || torrentFilesSaving}
                    onClick={() => {
                      setTorrentFilesSaving(true)
                      void onSetTorrentFiles(download.id, [...selectedTorrentFiles])
                        .finally(() => setTorrentFilesSaving(false))
                    }}
                    className="rounded-md border border-line px-2.5 py-1.5 text-[10px] font-medium text-ink-2 hover:bg-[color:var(--surface-3)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Save file selection
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-muted">No downloadable files were reported for this torrent.</p>
            )}
          </section>
        ) : (
          <section className="panel p-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Completed range map
                </h3>
                <p className="mt-1 text-[10.5px] text-muted">
                  Each lit segment represents ranges durably completed and verified by Moth.
                </p>
              </div>
              <span className="font-mono text-[11px] font-medium tabular-nums text-ink-2">
                {download.chunksComplete} / {download.chunksTotal}
              </span>
            </div>
            {download.fileSize > 0 ? (
              <div className="mt-3">
                <ChunkMap
                  bitmap={download.chunkBitmap}
                  total={download.chunksTotal}
                  active={live}
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted">
                  <span>{download.chunksTotal} planned ranges</span>
                  <span>Received-byte progress and durable ranges are measured separately.</span>
                </div>
              </div>
            ) : (
              <p className="mt-3 rounded-md bg-[color:var(--surface-3)] px-3 py-2 text-[11px] text-muted">
                Range details appear after Moth discovers the file size and plans the transfer.
              </p>
            )}
          </section>
        )}

        <section className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-line bg-[color:var(--surface)] p-3.5 sm:grid-cols-3">
          <Metric label="Transfer method" value={isMediaPipeline ? 'yt-dlp media' : isTorrent ? 'Transmission torrent' : download.acceptRanges ? 'HTTP byte ranges' : 'Single HTTP stream'} />
          {!isMediaPipeline && !isTorrent ? (
            <div className="min-w-0">
              <Metric label="Resume safety" value={resumeCapability.label} />
              <p className="mt-1 text-[10px] leading-relaxed text-muted">{resumeCapability.explanation}</p>
            </div>
          ) : null}
          <Metric label="Retries" value={`${download.retryCount} of ${download.maxRetries}`} />
          <Metric label="Source" value={shortenUrl(download.url, 48)} />
          <Metric label="Started" value={download.startedAt ? new Date(download.startedAt).toLocaleString() : 'Not started'} />
          <Metric label="Downloaded" value={download.completedAt !== null ? formatDateTime(download.completedAt) : 'Not completed'} />
          <Metric label="Expected checksum" value={download.expectedChecksum?.algorithm.toUpperCase() ?? 'None'} />
          <Metric label="Category" value={download.category} />
          {developerMode ? (
            <>
              <Metric label="Download ID" value={download.id} />
              <Metric label="Content type" value={download.contentType ?? 'Unknown'} />
              <Metric label="Source validators" value={`${download.etag ? 'ETag' : ''}${download.etag && download.lastModified ? ' + ' : ''}${download.lastModified ? 'Last-Modified' : ''}` || 'None'} />
            </>
          ) : null}
        </section>

        {download.status === 'completed' && onVerifyDownload && !isTorrent ? (
          <section className="panel space-y-3 p-3.5">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">File verification</h3>
              <p className="mt-1 text-[10.5px] text-muted">
                {download.expectedChecksum
                  ? `Recalculate ${checksumAlgorithmLabel(download.expectedChecksum.algorithm)} and compare it with the expected checksum.`
                  : 'Calculate a SHA-256 digest. Without a trusted expected checksum, this cannot confirm the file matches an official copy.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void verifyDownload()}
              disabled={verifying}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[10px] font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink disabled:cursor-wait disabled:opacity-60"
            >
              {verifying ? 'Calculating digest…' : download.expectedChecksum ? 'Verify file' : 'Calculate SHA-256'}
            </button>
            {verifying ? (
              <p className="text-[10.5px] text-muted" role="status">
                Reading the complete file; large files may take some time.
              </p>
            ) : null}
            {verification?.outcome === 'verified' ? (
              <VerificationMessage tone="good" title="Checksum matches">
                {checksumAlgorithmLabel(verification.algorithm)} {verification.actual}
              </VerificationMessage>
            ) : null}
            {verification?.outcome === 'mismatch' ? (
              <VerificationMessage tone="bad" title="Checksum does not match">
                Expected {verification.expected}; calculated {checksumAlgorithmLabel(verification.algorithm)} {verification.actual}
              </VerificationMessage>
            ) : null}
            {verification?.outcome === 'unverified' ? (
              <VerificationMessage tone="neutral" title="Digest calculated; file not authenticated">
                SHA-256 {verification.actual}. No expected checksum was supplied to compare against.
              </VerificationMessage>
            ) : null}
            {verification?.outcome === 'unavailable' ? (
              <VerificationMessage tone="bad" title="File is unavailable">
                Moth could not find a completed file at its recorded destination.
              </VerificationMessage>
            ) : null}
            {verificationError ? (
              <VerificationMessage tone="bad" title="Verification failed">
                {verificationError}
              </VerificationMessage>
            ) : null}
          </section>
        ) : null}

        {download.status === 'failed' && download.errorMessage ? (
          <p className="rounded-lg border border-[color:var(--color-bad)]/30 bg-[color:var(--color-bad-soft)] px-3 py-2.5 text-[11px] text-[color:var(--color-bad)]">
            <strong>{download.errorCode ?? 'Download failed'}:</strong> {download.errorMessage}
          </p>
        ) : null}

        <div className="flex flex-wrap items-start gap-x-2 gap-y-1 text-[10px] text-muted">
          <span className="shrink-0 font-medium text-ink-2">Saved to</span>
          <span className="selectable min-w-0 break-all font-mono">{download.finalPath ?? download.tempPath}</span>
        </div>

        <section className="panel space-y-3 p-3.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Source and destination</h3>
          <p className="selectable break-all font-mono text-[10px] text-ink-2">{download.url}</p>
          <div className="flex flex-wrap gap-2">
            {onOpenSource ? <DetailsAction onClick={() => onOpenSource(download.id)}><IconExternal size={13} /> Open source</DetailsAction> : null}
            {onCopySource ? <DetailsAction onClick={() => onCopySource(download.id)}><IconLink size={13} /> Copy link</DetailsAction> : null}
            {onReveal ? <DetailsAction onClick={() => onReveal(download.id)}><IconFolder size={13} /> Show in folder</DetailsAction> : null}
            {onOpenFolder ? <DetailsAction onClick={() => onOpenFolder(download.id)}>Open containing folder</DetailsAction> : null}
            {download.finalPath && onOpenFile ? <DetailsAction onClick={() => onOpenFile(download.id)}>Open downloaded file</DetailsAction> : null}
            {onCopyPath ? <DetailsAction onClick={() => onCopyPath(download.finalPath ?? download.tempPath)}>Copy file path</DetailsAction> : null}
            {onRefreshUrl && (download.status === 'paused' || download.status === 'failed') && !isMediaPipeline ? (
              <DetailsAction onClick={() => setRefreshOpen(true)}><IconLink size={13} /> Replace link</DetailsAction>
            ) : null}
          </div>
        </section>

        <section className="panel space-y-3 p-3.5">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Queue and controls</h3>
            <p className="mt-1 text-[10.5px] text-muted">
              Priority {download.priority} · 0 is highest. Current status: {STATUS_LABELS[download.status] ?? download.status}.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(download.status === 'downloading' || download.status === 'connecting') && onPause ? (
              <DetailsAction onClick={() => onPause(download.id)}><IconPause size={13} /> Pause</DetailsAction>
            ) : null}
            {download.status === 'paused' && onResume ? (
              <DetailsAction onClick={() => onResume(download.id)}><IconPlay size={13} /> Resume</DetailsAction>
            ) : null}
            {download.status === 'failed' && onRetry ? (
              <DetailsAction onClick={() => onRetry(download.id)}><IconRetry size={13} /> Retry</DetailsAction>
            ) : null}
            {download.status === 'review' && onConfigureReview ? (
              <DetailsAction onClick={() => { onClose(); onConfigureReview(download.id) }}>Configure download</DetailsAction>
            ) : null}
            {download.status === 'review' && onStartReview ? (
              <DetailsAction onClick={() => onStartReview(download.id)}>Start download</DetailsAction>
            ) : null}
            {live && onCancel ? (
              <DetailsAction onClick={() => onCancel(download.id)}><IconClose size={13} /> Cancel</DetailsAction>
            ) : null}
            {onRemove ? (
              <DetailsAction onClick={() => { onClose(); onRemove(download.id) }}><IconClose size={13} /> Remove</DetailsAction>
            ) : null}
          </div>
          {onSetPriority && download.status !== 'completed' && download.status !== 'canceled' ? (
            <label className="flex flex-wrap items-center gap-2 text-[10.5px] text-ink-2">
              Queue priority
              <input
                type="number"
                min="0"
                max="1000"
                step="1"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                className="w-24 rounded-md border border-line bg-[color:var(--surface)] px-2 py-1.5 text-ink"
                aria-label="Queue priority, 0 is highest"
              />
              <button
                type="button"
                disabled={!Number.isInteger(Number(priority)) || Number(priority) < 0 || Number(priority) > 1000}
                onClick={() => {
                  const value = Number(priority)
                  if (Number.isInteger(value) && value >= 0 && value <= 1000) onSetPriority(download.id, value)
                }}
                className="rounded-md border border-line px-2.5 py-1.5 text-[10px] font-medium text-ink-2 hover:bg-[color:var(--surface-3)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save priority
              </button>
            </label>
          ) : null}
          {onSetSpeedLimit && download.status !== 'completed' && download.status !== 'canceled' ? (
            <label className="flex flex-wrap items-center gap-2 text-[10.5px] text-ink-2">
              {isTorrent ? 'Torrent download cap' : 'Speed cap'}
              <select
                value={download.speedLimit ?? ''}
                onChange={(event) => onSetSpeedLimit(download.id, event.target.value ? Number(event.target.value) : null)}
                className="rounded-md border border-line bg-[color:var(--surface)] px-2 py-1.5 text-ink"
                aria-label="Download speed cap"
              >
                <option value="">Unlimited</option>
                {download.speedLimit !== null && ![1, 2, 5, 10, 20, 50, 100, 128, 300, 512, 1024, 2048, 5120, 10240].some((rate) => rate * 1024 === download.speedLimit) ? (
                  <option key={download.speedLimit} value={download.speedLimit}>{formatRate(download.speedLimit)}</option>
                ) : null}
                {(isTorrent
                  ? [1, 2, 5, 10, 20, 50, 100, 128, 300, 512, 1024, 2048, 5120, 10240]
                  : [128, 300, 512, 1024, 2048, 5120, 10240]
                ).map((rate) => (
                  <option key={rate} value={rate * 1024}>{formatRate(rate * 1024)}</option>
                ))}
              </select>
            </label>
          ) : null}
          {isTorrent && onSetUploadSpeedLimit && download.status !== 'completed' && download.status !== 'canceled' ? (
            <label className="flex flex-wrap items-center gap-2 text-[10.5px] text-ink-2">
              Torrent upload cap
              <select
                value={download.uploadSpeedLimit ?? ''}
                onChange={(event) => onSetUploadSpeedLimit(download.id, event.target.value ? Number(event.target.value) : null)}
                className="rounded-md border border-line bg-[color:var(--surface)] px-2 py-1.5 text-ink"
                aria-label="Torrent upload speed cap"
              >
                <option value="">Unlimited</option>
                {download.uploadSpeedLimit !== null && download.uploadSpeedLimit !== undefined &&
                ![1, 2, 5, 10, 20, 50, 100, 128, 300, 512, 1024, 2048, 5120, 10240].some((rate) => rate * 1024 === download.uploadSpeedLimit) ? (
                  <option key={download.uploadSpeedLimit} value={download.uploadSpeedLimit}>
                    {formatRate(download.uploadSpeedLimit)}
                  </option>
                ) : null}
                {[1, 2, 5, 10, 20, 50, 100, 128, 300, 512, 1024, 2048, 5120, 10240].map((rate) => (
                  <option key={rate} value={rate * 1024}>{formatRate(rate * 1024)}</option>
                ))}
              </select>
            </label>
          ) : null}
          {onSetQuota && download.status !== 'completed' && download.status !== 'canceled' && !isMediaPipeline && !isTorrent ? (
            <label className="flex flex-wrap items-center gap-2 text-[10.5px] text-ink-2">
              Quota (MB)
              <input
                type="number"
                min="0"
                step="any"
                value={quota}
                onChange={(event) => setQuota(event.target.value)}
                className="w-28 rounded-md border border-line bg-[color:var(--surface)] px-2 py-1.5 text-ink"
                aria-label="Download quota in megabytes"
              />
              <button
                type="button"
                onClick={() => {
                  if (!quota.trim()) onSetQuota(download.id, null)
                  else {
                    const bytes = toQuotaBytes(quota)
                    if (bytes !== null) onSetQuota(download.id, bytes)
                  }
                }}
                disabled={Boolean(quota.trim()) && toQuotaBytes(quota) === null}
                className="rounded-md border border-line px-2.5 py-1.5 text-[10px] font-medium text-ink-2 hover:bg-[color:var(--surface-3)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save quota
              </button>
            </label>
          ) : null}
        </section>

        {download.metadata && onSaveMetadata && onWriteTags ? (
          <MediaPanel
            metadata={download.metadata}
            onSave={(patch) => onSaveMetadata(download.id, patch)}
            onWriteTags={() => onWriteTags(download.id)}
          />
        ) : null}
      </div>
      </Modal>
      {refreshOpen && onRefreshUrl ? (
        <RefreshLinkDialog
          download={download}
          onClose={() => setRefreshOpen(false)}
          onSubmit={onRefreshUrl}
        />
      ) : null}
    </>
  )
}

function VerificationMessage({
  tone,
  title,
  children
}: {
  tone: 'good' | 'bad' | 'neutral'
  title: string
  children: React.ReactNode
}): React.ReactElement {
  const toneClass = tone === 'good'
    ? 'border-[color:var(--color-ok)]/30 bg-[color:var(--color-ok-soft)] text-[color:var(--color-ok)]'
    : tone === 'bad'
      ? 'border-[color:var(--color-bad)]/30 bg-[color:var(--color-bad-soft)] text-[color:var(--color-bad)]'
      : 'border-line bg-[color:var(--surface-3)] text-ink-2'
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`break-words rounded-md border px-3 py-2 text-[10.5px] ${toneClass}`}>
      <strong>{title}:</strong> {children}
    </div>
  )
}

function checksumAlgorithmLabel(algorithm: ChecksumAlgorithm): string {
  switch (algorithm) {
    case 'fast': return 'CRC-32'
    case 'md5': return 'MD5'
    case 'sha1': return 'SHA-1'
    case 'sha256': return 'SHA-256'
    case 'sha512': return 'SHA-512'
  }
}

function DetailsAction({
  children,
  onClick
}: {
  children: React.ReactNode
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[10px] font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink"
    >
      {children}
    </button>
  )
}

function ProgressRing({
  fraction,
  percent,
  indeterminate
}: {
  fraction: number
  percent: number
  indeterminate: boolean
}): React.ReactElement {
  const circumference = 2 * Math.PI * 38
  return (
    <div
      className="relative grid size-[88px] shrink-0 place-items-center"
      role="img"
      aria-label={indeterminate ? 'Progress being measured' : `${percent}% downloaded`}
    >
      <svg viewBox="0 0 88 88" className="absolute inset-0 size-full -rotate-90" aria-hidden>
        <circle cx="44" cy="44" r="38" fill="none" stroke="var(--line)" strokeWidth="6" />
        {indeterminate ? (
          <circle
            cx="44"
            cy="44"
            r="38"
            fill="none"
            stroke="var(--color-brand-400)"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${circumference * 0.22} ${circumference}`}
            className="animate-spin origin-center"
          />
        ) : (
          <circle
            cx="44"
            cy="44"
            r="38"
            fill="none"
            stroke="var(--color-brand-400)"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${circumference * fraction} ${circumference}`}
            className="transition-[stroke-dasharray] duration-500"
          />
        )}
      </svg>
      <span className="font-mono text-sm font-semibold tabular-nums text-ink">
        {indeterminate ? '…' : `${percent}%`}
      </span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 break-words text-[11px] font-medium text-ink-2">{value || '—'}</p>
    </div>
  )
}
