/**
 * URL-first Add dialog: paste a link, the app recognises it, then offers
 * exactly the choice that matters.
 *
 *   - One direct file  -> file card (name, size, type, resumable?) + Add.
 *   - One media page   -> Video / MP3 cards, no settings homework.
 *   - Several lines    -> classic batch mode (one row per URL, no preview).
 *   - Probe failed     -> honest "couldn't read details", still queueable.
 *
 * Advanced (category, connections, speed, schedule, checksum) lives in a
 * collapsed section. A "not what you expected" escape flips page <-> direct
 * when the heuristic guesses wrong.
 */

import { useEffect, useRef, useState } from 'react'
import type {
  AddDownloadRequest,
  AudioOutputFormat,
  DownloadCategory,
  DuplicateMediaResult,
  MediaPlaylistPreview,
  PreviewDownloadResult,
  VideoCaptureFormat,
  VideoQuality
} from '@shared/types.js'
import { isYouTubePlaylistUrl } from '@shared/mediaUrl.js'
import {
  isImportedTorrentFileUri,
  isTorrentSource,
  parseMagnetUri
} from '@shared/torrent.js'
import { Field, Modal, inputClass } from './Modal.js'
import { describe } from '../hooks/useMothStore.js'
import { formatBytes } from '../lib/format.js'
import { IconAudio, IconVideo } from './Icons.js'

interface Props {
  onClose: () => void
  onAdd: (requests: AddDownloadRequest[]) => void
  onError: (message: string) => void
  defaultDirectory: string
  initialUrl?: string
  reviewId?: string
  initialRequest?: AddDownloadRequest
  onConfigureReview?: (id: string, request: AddDownloadRequest) => Promise<void>
}

const CATEGORIES: readonly (DownloadCategory | 'auto')[] = [
  'auto',
  'video',
  'audio',
  'document',
  'archive',
  'executable',
  'image',
  'other'
] as const

type PreviewState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; preview: PreviewDownloadResult }
  | { status: 'error'; message: string }

const isHttpUrl = (line: string): boolean => /^https?:\/\//i.test(line.trim())
const isDownloadLink = (line: string): boolean =>
  isHttpUrl(line) || isTorrentSource(line) || isImportedTorrentFileUri(line)

function splitUrls(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('#'))
}

export function AddDownloadDialog({
  onClose,
  onAdd,
  onError,
  defaultDirectory,
  initialUrl = '',
  reviewId,
  initialRequest,
  onConfigureReview
}: Props): React.ReactElement {
  const [text, setText] = useState(initialUrl)
  const [selectedTorrentFile, setSelectedTorrentFile] = useState<{
    fileName: string
    metainfo: string
    sha256: string
  } | null>(null)
  const [torrentFileError, setTorrentFileError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' })
  const [kindOverride, setKindOverride] = useState<'direct' | 'page' | null>(
    initialRequest?.format ? 'page' : null
  )
  const [choice, setChoice] = useState<VideoCaptureFormat>(initialRequest?.format ?? 'video')
  const [audioFormat, setAudioFormat] = useState<AudioOutputFormat>(initialRequest?.audioFormat ?? 'mp3')
  const [subtitleLanguagesText, setSubtitleLanguagesText] = useState(initialRequest?.subtitleLanguages?.join(',') ?? '')
  const [namingTemplate, setNamingTemplate] = useState(initialRequest?.namingTemplate ?? '')
  const [embedMetadata, setEmbedMetadata] = useState(initialRequest?.embedMetadata ?? true)
  const [playlist, setPlaylist] = useState<MediaPlaylistPreview | null>(null)
  const [playlistOnlyNew, setPlaylistOnlyNew] = useState(false)
  const [selectedPlaylistIds, setSelectedPlaylistIds] = useState<Set<string>>(new Set())
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [playlistError, setPlaylistError] = useState<string | null>(null)
  const [duplicateMedia, setDuplicateMedia] = useState<DuplicateMediaResult | null>(null)
  const [duplicateError, setDuplicateError] = useState<string | null>(null)
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(initialRequest?.videoQuality ?? 720)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [category, setCategory] = useState<string>(initialRequest?.category ?? 'auto')
  const [checksum, setChecksum] = useState(initialRequest?.expectedChecksum ?? '')
  const checksumAlgorithm = initialRequest?.checksumAlgorithm
  const [speedLimit, setSpeedLimit] = useState(initialRequest?.speedLimit ? `${initialRequest.speedLimit}B/s` : '')
  const [scheduled, setScheduled] = useState(
    initialRequest?.scheduledStartAt ? localDateTimeValue(new Date(initialRequest.scheduledStartAt)) : ''
  )
  const [connections, setConnections] = useState(String(initialRequest?.connections ?? '4'))
  const requestId = useRef(0)

  const urls = splitUrls(text)
  const singleUrl = urls.length === 1 ? (urls[0] as string) : null
  const magnet = singleUrl ? parseMagnetUri(singleUrl) : null
  const torrentSource = singleUrl ? isTorrentSource(singleUrl) || isImportedTorrentFileUri(singleUrl) : false
  const localTorrentSelected = Boolean(
    singleUrl &&
    selectedTorrentFile &&
    isImportedTorrentFileUri(singleUrl) &&
    singleUrl.toLowerCase() === `moth-torrent-file:${selectedTorrentFile.sha256}`.toLowerCase()
  )
  const batch = urls.length > 1
  const invalid = urls.filter((url) => !isDownloadLink(url))
  const automaticPlaylistUrl = singleUrl !== null && isYouTubePlaylistUrl(singleUrl)

  // Offer the clipboard URL on open so a copy -> click flow needs zero typing.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const clip = await navigator.clipboard.readText()
        if (!cancelled && clip && isDownloadLink(clip) && splitUrls(clip).length === 1) {
          setText((current) => (current.trim() === '' ? clip.trim() : current))
        }
      } catch {
        /* clipboard unavailable — the user types instead */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Playlist URLs can be read immediately; ordinary URLs use a short preview debounce.
  useEffect(() => {
    if (torrentSource && singleUrl) {
      requestId.current += 1
      setPreview({
        status: 'ready',
        preview: {
          kind: 'torrent',
          finalUrl: singleUrl,
          host: 'BitTorrent',
          filename: magnet?.displayName ??
            selectedTorrentFile?.fileName ??
            (isImportedTorrentFileUri(singleUrl) ? 'Selected .torrent file' : singleUrl),
          fileSize: null,
          contentType: 'application/x-bittorrent',
          acceptRanges: false,
          resumeSupport: 'unknown',
          category: 'other',
          undetermined: true
        }
      })
      setKindOverride(null)
      setPlaylist(null)
      setPlaylistLoading(false)
      setPlaylistError(null)
      setSelectedPlaylistIds(new Set())
      return
    }
    if (!singleUrl || !isHttpUrl(singleUrl)) {
      requestId.current += 1
      setPreview({ status: 'idle' })
      setKindOverride(initialRequest?.format ? 'page' : null)
      setPlaylist(null)
      setPlaylistLoading(false)
      setPlaylistError(null)
      setSelectedPlaylistIds(new Set())
      return
    }
    const id = requestId.current + 1
    requestId.current = id
    setKindOverride(initialRequest?.format ? 'page' : null)
    setPlaylist(null)
    setPlaylistError(null)
    setPlaylistLoading(false)

    if (isYouTubePlaylistUrl(singleUrl)) {
      setPreview({
        status: 'ready',
        preview: {
          kind: 'page',
          finalUrl: singleUrl,
          host: new URL(singleUrl).hostname.toLowerCase(),
          filename: '',
          fileSize: null,
          contentType: null,
          acceptRanges: false,
          resumeSupport: 'unknown',
          category: 'video',
          undetermined: true
        }
      })
      setPlaylistLoading(true)
      void window.moth.invoke.previewMediaPlaylist({ url: singleUrl }).then(
        (resolved) => {
          if (requestId.current !== id) return
          setPlaylist(resolved)
          setSelectedPlaylistIds(new Set(
            resolved.entries.filter((entry) => !entry.alreadyDownloaded).map((entry) => entry.id)
          ))
        },
        (err: unknown) => {
          if (requestId.current === id) setPlaylistError(describe(err))
        }
      ).finally(() => {
        if (requestId.current === id) setPlaylistLoading(false)
      })
      return () => {
        if (requestId.current === id) requestId.current += 1
      }
    }

    setPreview({ status: 'checking' })
    const timer = setTimeout(() => {
      void window.moth.invoke
        .previewDownload({ url: singleUrl })
        .then((result) => {
          if (requestId.current !== id) return
          setPreview({ status: 'ready', preview: result })
          setKindOverride(initialRequest?.format ? 'page' : null)
        })
        .catch((err) => {
          if (requestId.current !== id) return
          setPreview({ status: 'error', message: describe(err) })
        })
    }, 450)
    return () => {
      clearTimeout(timer)
      if (requestId.current === id) requestId.current += 1
    }
  }, [singleUrl, initialRequest?.format, torrentSource, selectedTorrentFile])

  const effectiveKind =
    kindOverride ??
    (preview.status === 'ready'
      ? preview.preview.kind
      : reviewId && initialRequest?.format ? 'page' : null)
  const isPage = effectiveKind === 'page'
  const isTorrent = effectiveKind === 'torrent'

  useEffect(() => {
    if (!singleUrl || !isPage || automaticPlaylistUrl) {
      setDuplicateMedia(null)
      setDuplicateError(null)
      return
    }
    let cancelled = false
    setDuplicateMedia(null)
    setDuplicateError(null)
    void window.moth.invoke.checkMediaDuplicate({ url: singleUrl }).then(
      (result) => {
        if (!cancelled) setDuplicateMedia(result)
      },
      (err: unknown) => {
        if (!cancelled) setDuplicateError(describe(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [singleUrl, isPage, automaticPlaylistUrl])

  const primaryLabel = (): string => {
    if (playlistLoading) return 'Reading playlist…'
    if (playlist) return `Add ${selectedPlaylistIds.size} playlist items`
    if (batch) return `Add ${urls.length} links`
    if (reviewId) return 'Save settings'
    if (isTorrent) return 'Add torrent'
    if (preview.status === 'checking') return 'Add to queue'
    if (isPage) return choice === 'audio'
      ? `Download ${audioFormat === 'mp3' ? 'MP3' : 'source audio'}`
      : 'Download video'
    return urls.length === 1 ? 'Download' : 'Add'
  }

  const canSubmit =
    urls.length > 0 &&
    invalid.length === 0 &&
    !playlistLoading &&
    (!playlist || selectedPlaylistIds.size > 0)

  const buildRequest = (url: string): AddDownloadRequest => {
    const request: AddDownloadRequest = { url }
    // The card the user is looking at is the decision, including the "send as a
    // direct file instead" override, so record it instead of letting the engine
    // re-guess a URL whose text says nothing.
    if (!batch && (effectiveKind === 'direct' || effectiveKind === 'page')) {
      request.sourceKind = effectiveKind
    }
    const torrentLink = isTorrentSource(url) || isImportedTorrentFileUri(url)
    if (isImportedTorrentFileUri(url)) {
      if (!localTorrentSelected || !selectedTorrentFile) {
        throw new Error('Choose the .torrent file again before adding it')
      }
      request.torrentMetainfo = selectedTorrentFile.metainfo
      request.filename = selectedTorrentFile.fileName.replace(/\.torrent$/i, '')
    }
    if (isPage) {
      request.format = choice
      if (choice === 'video') request.videoQuality = videoQuality
      if (choice === 'audio') request.audioFormat = audioFormat
      if (namingTemplate.trim()) request.namingTemplate = namingTemplate.trim()
      request.embedMetadata = embedMetadata
      const subtitleLanguages = subtitleLanguagesText
        .split(',')
        .map((language) => language.trim())
        .filter(Boolean)
      if (subtitleLanguages.length > 0) {
        if (subtitleLanguages.length > 8 || subtitleLanguages.some((language) => !/^[A-Za-z0-9_-]{1,35}$/.test(language))) {
          throw new Error('Enter up to 8 subtitle language codes, separated by commas (for example: en,es)')
        }
        request.subtitleLanguages = [...new Set(subtitleLanguages)]
      }
    }
    if (category !== 'auto') request.category = category as DownloadCategory
    if (!torrentLink && checksum.trim()) {
      request.expectedChecksum = checksum.trim()
      if (checksumAlgorithm) request.checksumAlgorithm = checksumAlgorithm
    }
    if (!torrentLink && speedLimit.trim()) {
      const parsed = parseRate(speedLimit)
      if (parsed === null) throw new Error(`Could not read speed limit "${speedLimit}" — try 1.5MB/s`)
      request.speedLimit = parsed
    }
    if (scheduled) {
      const when = new Date(scheduled).getTime()
      if (Number.isNaN(when)) throw new Error('Invalid start time')
      request.scheduledStartAt = when
    }
    const parsedConnections = Number.parseInt(connections, 10)
    if (!torrentLink && Number.isFinite(parsedConnections) && parsedConnections > 0) {
      request.connections = parsedConnections
    }
    return request
  }

  const loadPlaylist = async (): Promise<void> => {
    if (!singleUrl) return
    const id = requestId.current
    setPlaylistLoading(true)
    setPlaylistError(null)
    setPlaylist(null)
    try {
      const resolved = await window.moth.invoke.previewMediaPlaylist({ url: singleUrl })
      if (requestId.current !== id) return
      setPlaylist(resolved)
      setSelectedPlaylistIds(new Set(resolved.entries.filter((entry) => !entry.alreadyDownloaded).map((entry) => entry.id)))
    } catch (err) {
      if (requestId.current === id) setPlaylistError(describe(err))
    } finally {
      if (requestId.current === id) setPlaylistLoading(false)
    }
  }

  const visiblePlaylistEntries = playlist?.entries.filter(
    (entry) => !playlistOnlyNew || !entry.alreadyDownloaded
  ) ?? []

  const submit = async (): Promise<void> => {
    if (urls.length === 0) {
      onError('Paste a file, media, or BitTorrent magnet link first')
      return
    }
    if (invalid.length > 0) {
      onError(`Not a supported http(s) or BitTorrent v1 magnet link: ${invalid[0]}`)
      return
    }
    try {
      if (playlist) {
        const selected = playlist.entries.filter(
          (entry) => selectedPlaylistIds.has(entry.id) && (!playlistOnlyNew || !entry.alreadyDownloaded)
        )
        if (selected.length === 0) {
          onError('Select at least one playlist item')
          return
        }
        const requests = selected.map((entry) => buildRequest(entry.url))
        if (reviewId) {
          if (!onConfigureReview) throw new Error('Download settings are not available')
          await onConfigureReview(reviewId, requests[0]!)
        }
        else onAdd(requests)
      } else {
        const requests = urls.map((url) => buildRequest(url))
        if (reviewId) {
          if (!onConfigureReview) throw new Error('Download settings are not available')
          await onConfigureReview(reviewId, requests[0]!)
        }
        else onAdd(requests)
      }
      onClose()
    } catch (err) {
      onError(describe(err))
    }
  }

  return (
    <Modal
      title={reviewId ? 'Configure download' : 'Add a download'}
      subtitle={reviewId ? 'Adjust the options before you start this download.' : 'Paste a link. Moth will take it from there.'}
      wide={batch || Boolean(playlist) || automaticPlaylistUrl}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-on-brand transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {primaryLabel()}
          </button>
        </>
      }
    >
      <Field label={batch ? 'Links' : 'Link'} hint="Paste a file, video, or playlist link.">
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setSelectedTorrentFile(null)
            setTorrentFileError(null)
          }}
          readOnly={Boolean(reviewId)}
          rows={batch ? 3 : 1}
          spellCheck={false}
          autoFocus
          placeholder="https://example.com/file.zip or magnet:?xt=urn:btih:…"
          className={`${inputClass} min-h-12 resize-y rounded-xl px-3 py-3 font-mono text-sm`}
        />
      </Field>
      {!reviewId && !batch ? (
        <div className="-mt-2 mb-3">
          <button
            type="button"
            onClick={() => {
              void window.moth.invoke.selectTorrentFile({}).then(
                (file) => {
                  if (!file) return
                  setSelectedTorrentFile(file)
                  setText(`moth-torrent-file:${file.sha256}`)
                  setTorrentFileError(null)
                },
                (err: unknown) => setTorrentFileError(describe(err))
              )
            }}
            className="text-[11px] font-semibold text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Choose a .torrent file…
          </button>
          {torrentFileError ? (
            <p role="alert" className="mt-1 text-[11px] text-[color:var(--color-bad)]">{torrentFileError}</p>
          ) : null}
        </div>
      ) : null}

      <p className="mb-2 -mt-2 text-[11px] text-muted">
        {defaultDirectory ? `Downloads go to ${defaultDirectory}` : 'Choose a destination in Settings.'}
      </p>

      {invalid.length > 0 ? (
        <p className="rounded-lg border border-[color:var(--color-bad)]/40 bg-[color:var(--color-bad)]/10 px-3 py-2 text-xs text-ink">
          That doesn’t look like a supported http(s), BitTorrent magnet, or .torrent URL: <span className="font-mono">{invalid[0]}</span>
        </p>
      ) : null}

      {batch ? (
        <div className="animate-slide-down rounded-lg border border-line bg-[color:var(--surface-2)] px-3 py-2.5 text-xs text-ink-2">
          <span className="font-semibold text-ink">{urls.length} links</span> — they’ll queue one by
          one with the same settings. Tip: paste a single video page alone to pick Video / MP3.
        </div>
      ) : null}

      {!batch && preview.status === 'checking' ? (
        <p role="status" className="animate-slide-down flex items-center gap-2 text-xs text-muted">
          <span className="size-1.5 animate-pulse-soft rounded-full bg-[color:var(--color-brand-500)]" />
          Checking the link…
        </p>
      ) : null}

      {!batch && preview.status === 'error' ? (
        <p className="animate-slide-down rounded-lg border border-line bg-[color:var(--surface-2)] px-3 py-2 text-xs text-ink-2">
          Couldn’t read the details ({preview.message}) — you can still hit Download and we’ll try
          directly.
        </p>
      ) : null}

      {!batch && preview.status === 'ready' && effectiveKind === 'direct' ? (
        <div key="file-details" className="animate-slide-down rounded-lg border border-line bg-[color:var(--surface-2)] px-3 py-2.5">
          <p className="truncate font-mono text-xs font-semibold text-ink" title={preview.preview.filename}>
            {preview.preview.filename}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
            <span>{preview.preview.fileSize !== null ? formatBytes(preview.preview.fileSize) : 'Size unknown'}</span>
            <span aria-hidden>·</span>
            <span className="capitalize">{preview.preview.category}</span>
          </p>
          {preview.preview.undetermined ? (
            <p className="mt-1 text-[11px] text-muted">
              Couldn’t read the full details — queuing still works, we’ll probe again on start.
            </p>
          ) : null}
          <p
            className={[
              'mt-1 text-[11px]',
              preview.preview.resumeSupport === 'safe'
                ? 'text-[color:var(--color-ok)]'
                : preview.preview.resumeSupport === 'restart'
                  ? 'text-[color:var(--color-warn)]'
                  : 'text-muted'
            ].join(' ')}
            role="status"
          >
            {preview.preview.resumeSupport === 'safe'
              ? 'Safe resume supported'
              : preview.preview.resumeSupport === 'restart'
                ? 'Cannot safely resume — will restart'
                : 'Resume support not confirmed'}
          </p>
          <button
            type="button"
            onClick={() => setKindOverride('page')}
            className="mt-1.5 text-[11px] text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            This is a video page, not a file
          </button>
        </div>
      ) : null}

      {!batch && preview.status === 'ready' && isTorrent ? (
        <div className="animate-slide-down rounded-lg border border-line bg-[color:var(--surface-2)] px-3 py-2.5">
          <p className="truncate font-mono text-xs font-semibold text-ink" title={preview.preview.filename}>
            {preview.preview.filename}
          </p>
          <p className="mt-1 text-[11px] text-muted">
            BitTorrent magnet or .torrent source · size and availability appear after Transmission reads its metadata.
          </p>
        </div>
      ) : null}

      {!batch && preview.status === 'ready' && isPage ? (
        <div key={`media-details-${singleUrl}`} className="animate-slide-down">
          {singleUrl ? (
            <div className="mb-3 rounded-lg border border-line bg-[color:var(--surface-2)] p-3">
              {automaticPlaylistUrl && !playlist ? (
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-ink">
                    {playlistLoading ? 'Reading playlist…' : playlistError ? 'Couldn’t read this playlist' : 'Reading playlist…'}
                  </p>
                  <p className="text-[11px] text-muted">
                    {playlistError
                      ? 'You can retry or download the pasted link by itself.'
                      : 'The items will appear here as soon as their details are ready.'}
                  </p>
                  {playlistError ? (
                    <button
                      type="button"
                      onClick={() => void loadPlaylist()}
                      className="text-[11px] font-semibold text-ink-2 underline decoration-dotted underline-offset-2"
                    >
                      Try again
                    </button>
                  ) : null}
                </div>
              ) : !playlist ? (
                <button
                  type="button"
                  disabled={playlistLoading}
                  onClick={() => void loadPlaylist()}
                  className="text-xs font-semibold text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-50"
                >
                  {playlistLoading ? 'Reading playlist…' : 'Choose items from a playlist'}
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-semibold text-ink" title={playlist.title}>
                      {playlist.title} · {playlist.entries.length} items
                    </p>
                    <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-2">
                      <input
                        type="checkbox"
                        checked={playlistOnlyNew}
                        onChange={(event) => {
                          const onlyNew = event.target.checked
                          setPlaylistOnlyNew(onlyNew)
                          if (onlyNew) {
                            setSelectedPlaylistIds((current) => new Set(
                              playlist.entries.filter((entry) =>
                                current.has(entry.id) && !entry.alreadyDownloaded
                              ).map((entry) => entry.id)
                            ))
                          }
                        }}
                      />
                      Only new
                    </label>
                  </div>
                  <div className="flex items-center gap-3 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setSelectedPlaylistIds((current) => {
                        const next = new Set(current)
                        for (const entry of visiblePlaylistEntries) next.add(entry.id)
                        return next
                      })}
                      className="font-medium text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedPlaylistIds((current) => {
                        const next = new Set(current)
                        for (const entry of visiblePlaylistEntries) next.delete(entry.id)
                        return next
                      })}
                      className="font-medium text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink"
                    >
                      Unselect all
                    </button>
                    <span className="ml-auto text-muted">
                      {visiblePlaylistEntries.filter((entry) => selectedPlaylistIds.has(entry.id)).length} selected
                    </span>
                  </div>
                  {playlist.truncated ? (
                    <p className="text-[11px] text-muted">Showing the first 500 items.</p>
                  ) : null}
                  <div data-playlist-scroll className="max-h-48 space-y-1 overflow-y-auto">
                    {visiblePlaylistEntries.map((entry) => (
                      <label key={entry.id} className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-[color:var(--surface-3)]">
                        <input
                          type="checkbox"
                          checked={selectedPlaylistIds.has(entry.id)}
                          disabled={playlistOnlyNew && entry.alreadyDownloaded}
                          onChange={(event) =>
                            setSelectedPlaylistIds((current) => {
                              const next = new Set(current)
                              if (event.target.checked) next.add(entry.id)
                              else next.delete(entry.id)
                              return next
                            })
                          }
                        />
                        <PlaylistThumbnail url={entry.thumbnailUrl ?? null} title={entry.title} />
                        <span className="min-w-0 flex-1 truncate text-ink" title={entry.title}>{entry.title}</span>
                        {entry.alreadyDownloaded ? <span className="text-[10px] text-muted">Downloaded</span> : null}
                      </label>
                    ))}
                  </div>
                  {!automaticPlaylistUrl ? (
                    <button
                      type="button"
                      onClick={() => {
                        setPlaylist(null)
                        setPlaylistError(null)
                      }}
                      className="text-[11px] text-ink-2 underline decoration-dotted underline-offset-2"
                    >
                      Close playlist selection
                    </button>
                  ) : null}
                </div>
              )}
              {playlistError ? <p className="mt-1 text-[11px] text-[color:var(--color-bad)]">{playlistError}</p> : null}
            </div>
          ) : null}
          {duplicateMedia?.duplicate ? (
            <p className="mb-2 rounded-lg border border-[color:var(--color-warn)]/40 bg-[color:var(--color-warn)]/10 px-3 py-2 text-xs text-ink-2">
              Already downloaded{duplicateMedia.title ? `: ${duplicateMedia.title}` : ''}.
              {duplicateMedia.filename ? ` Existing file: ${duplicateMedia.filename}.` : ''} You can still download it again.
            </p>
          ) : null}
          {duplicateError ? (
            <p className="mb-2 text-[11px] text-muted">Couldn’t check download history: {duplicateError}</p>
          ) : null}
          <p className="mb-2 text-xs font-medium text-ink-2">
            Download from <span className="font-mono text-muted">{preview.preview.host}</span> as
          </p>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="What to grab">
            <button
              type="button"
              role="radio"
              aria-checked={choice === 'video'}
              onClick={() => setChoice('video')}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                choice === 'video'
                  ? 'border-[color:var(--color-brand-500)] bg-[color:var(--color-brand-500)]/10'
                  : 'border-line bg-[color:var(--surface-2)] hover:border-[color:var(--color-brand-500)]/50'
              }`}
            >
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                <IconVideo size={15} /> Video
              </span>
              <span className="mt-0.5 block text-[11px] text-muted">Up to {videoQuality}p with sound</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={choice === 'audio'}
              onClick={() => setChoice('audio')}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                choice === 'audio'
                  ? 'border-[color:var(--color-brand-500)] bg-[color:var(--color-brand-500)]/10'
                  : 'border-line bg-[color:var(--surface-2)] hover:border-[color:var(--color-brand-500)]/50'
              }`}
            >
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                <IconAudio size={15} /> Audio
              </span>
              <span className="mt-0.5 block text-[11px] text-muted">
                {audioFormat === 'mp3' ? 'MP3, converted when needed' : 'Keep the available source format'}
              </span>
            </button>
          </div>
          <div key={choice} className="animate-slide-down mt-2">
            {choice === 'video' ? (
              <Field label="Video quality">
                <select
                  value={videoQuality}
                  onChange={(event) => setVideoQuality(Number(event.target.value) as VideoQuality)}
                  className={inputClass}
                >
                  {[
                    { height: 360, label: 'Up to 360p' },
                    { height: 480, label: 'Up to 480p' },
                    { height: 720, label: 'Up to 720p' },
                    { height: 1080, label: 'Up to 1080p' },
                    { height: 1440, label: 'Up to 1440p (2K)' },
                    { height: 2160, label: 'Up to 2160p (4K)' }
                  ].map(({ height, label }) => (
                    <option key={height} value={height}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Audio output">
                <select
                  value={audioFormat}
                  onChange={(event) => setAudioFormat(event.target.value as AudioOutputFormat)}
                  className={inputClass}
                >
                  <option value="mp3">MP3</option>
                  <option value="source">Keep source format</option>
                </select>
              </Field>
            )}
          </div>
          <details className="mt-2 rounded-lg border border-line">
            <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-medium text-ink-2 hover:text-ink">
              More video options
            </summary>
            <div className="details-content space-y-3 border-t border-line px-3 py-3">
              <Field label="Subtitle languages" hint="Optional; comma-separated codes such as en,es.">
                <input
                  value={subtitleLanguagesText}
                  onChange={(event) => setSubtitleLanguagesText(event.target.value)}
                  placeholder="en,es"
                  className={inputClass}
                />
              </Field>
              <Field
                label="Filename template"
                hint="Optional. Use {title}, {id}, {host}, and {ext}."
              >
                <input
                  value={namingTemplate}
                  onChange={(event) => setNamingTemplate(event.target.value)}
                  placeholder="{title} - {host}.{ext}"
                  className={inputClass}
                />
              </Field>
              <label className="flex items-start gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={embedMetadata}
                  onChange={(event) => setEmbedMetadata(event.target.checked)}
                />
                <span>Fetch artwork and embed available audio tags</span>
              </label>
            </div>
          </details>
          <button
            type="button"
            onClick={() => setKindOverride('direct')}
            className="mt-1.5 text-[11px] text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            Not what you expected? Send as a direct file instead
          </button>
        </div>
      ) : null}

      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
        className="animate-slide-down rounded-lg border border-line"
      >
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-ink-2 hover:text-ink">
          Fine-tune (optional)
        </summary>
        <div className="details-content space-y-3 border-t border-line px-3 py-3">
        {isTorrent ? (
          <p className="text-[10.5px] text-muted">
            This prototype uses Transmission’s piece verification and stops seeding on completion. Per-download speed limits, connection counts, expected checksums, and file selection are not available for torrents.
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Save as">
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className={inputClass}
              >
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {value === 'auto' ? 'Auto-detect' : value}
                  </option>
                ))}
              </select>
            </Field>

            {!isTorrent ? (
              <Field label="Connections" hint="Parallel range requests.">
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={connections}
                  onChange={(event) => setConnections(event.target.value)}
                  className={inputClass}
                />
              </Field>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {!isTorrent ? (
              <Field label="Speed limit" hint="Leave empty for unlimited.">
                <input
                  value={speedLimit}
                  onChange={(event) => setSpeedLimit(event.target.value)}
                  placeholder="e.g. 2MB/s"
                  className={inputClass}
                />
              </Field>
            ) : null}

            <Field label="Start at" hint="Optional schedule.">
              <input
                type="datetime-local"
                value={scheduled}
                onChange={(event) => setScheduled(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          {!isTorrent ? (
            <Field label="Expected checksum" hint="Optional. MD5, SHA-1, SHA-256 or SHA-512.">
              <input
                value={checksum}
                onChange={(event) => setChecksum(event.target.value)}
                spellCheck={false}
                placeholder="sha256=… or a bare hex digest"
                className={`${inputClass} font-mono text-xs`}
              />
            </Field>
          ) : null}
        </div>
      </details>
    </Modal>
  )
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function PlaylistThumbnail({ url, title }: { url: string | null; title: string }): React.ReactElement {
  const targetRef = useRef<HTMLSpanElement | null>(null)
  const visibleRef = useRef(false)
  const pendingRef = useRef(false)
  const [source, setSource] = useState<string | null>(null)

  useEffect(() => {
    setSource(null)
    if (!url) return
    const target = targetRef.current
    if (!target) return
    let active = true
    const load = (): void => {
      if (!active || pendingRef.current || !visibleRef.current) return
      pendingRef.current = true
      void window.moth.invoke.getPlaylistThumbnail({ url }).then(
        (dataUrl) => {
          if (active && visibleRef.current && dataUrl) setSource(dataUrl)
        },
        () => {
          // An unavailable thumbnail must not delay or block playlist selection.
        }
      ).finally(() => {
        pendingRef.current = false
      })
    }
    const observer = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(([entry]) => {
          if (!entry) return
          visibleRef.current = entry.isIntersecting
          if (entry.isIntersecting) load()
          else setSource(null)
        }, { root: target.closest('[data-playlist-scroll]') })

    if (observer) observer.observe(target)
    else {
      visibleRef.current = true
      load()
    }
    return () => {
      active = false
      visibleRef.current = false
      observer?.disconnect()
    }
  }, [url])

  return (
    <span ref={targetRef} className="grid h-8 w-12 shrink-0 place-items-center overflow-hidden rounded bg-[color:var(--surface-3)]">
      {source ? <img src={source} alt="" title={title} className="h-full w-full object-cover" /> : null}
    </span>
  )
}

/** Parses "1.5MB/s" / "500kbps" into bytes per second. */
function parseRate(input: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?(?:ps|\/s)?$/i.exec(input.trim())
  if (!match) return null
  const value = Number.parseFloat(match[1] as string)
  const prefix = (match[2] ?? '').toLowerCase()
  const exponents: Record<string, number> = { '': 0, k: 1, m: 2, g: 3, t: 4 }
  const exponent = exponents[prefix] ?? 0
  return Math.round(value * 1024 ** exponent)
}
