/**
 * The renderer's single source of truth.
 *
 * All state lives in one hook so that progress events (2 Hz per download) can
 * be coalesced into a single React commit per frame instead of one per event.
 * Downloads are held in a `Map` so an update to one row does not require
 * rebuilding the list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  Download,
  DownloadId,
  DownloadSnapshot,
  EngineStats,
  SpeedSample
} from '@shared/types.js'
import type { DownloadProgressEvent, RecoveryReportEvent } from '@shared/ipc.js'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
}

export interface MothStore {
  downloads: DownloadSnapshot[]
  byId: Map<DownloadId, DownloadSnapshot>
  settings: AppSettings | null
  stats: EngineStats | null
  samples: SpeedSample[]
  recovery: RecoveryReportEvent | null
  toasts: Toast[]
  loading: boolean
  /** Sum of live per-download connections from the latest progress events. */
  activeConnections: number
  /** Live range-worker counts keyed by download id. */
  connectionsById: ReadonlyMap<DownloadId, number>
  refresh: () => Promise<void>
  dismissToast: (id: number) => void
  notify: (kind: Toast['kind'], message: string) => void
  /** Applies a progress event to the local cache without waiting for a list reload. */
  applyProgress: (event: DownloadProgressEvent) => void
}

let toastSeq = 0
const TERMINAL_TOAST_WINDOW_MS = 1500

export function useMothStore(): MothStore {
  const [downloads, setDownloads] = useState<DownloadSnapshot[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [samples, setSamples] = useState<SpeedSample[]>([])
  const [recovery, setRecovery] = useState<RecoveryReportEvent | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [loading, setLoading] = useState(true)
  const [activeConnections, setActiveConnections] = useState(0)

  // Latest per-download connection count, keyed by download id. Updated by
  // every progress event; the visible total is recomputed on flush so the
  // live bar and the rows can never disagree by more than a frame.
  const connections = useRef(new Map<DownloadId, number>())
  const terminalToast = useRef({ completed: 0, failed: 0, firstFilename: '', firstFailure: '' })
  const terminalToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Progress arrives far more often than React should re-render, so updates are
  // staged in a ref and flushed on an animation frame.
  const pending = useRef(new Map<DownloadId, DownloadProgressEvent>())
  const frame = useRef<number | null>(null)

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    const id = ++toastSeq
    setToasts((current) => [...current.slice(-3), { id, kind, message }])
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, kind === 'error' ? 7000 : 4000)
  }, [])

  const notifyTerminal = useCallback(
    (kind: 'success' | 'error', detail: string) => {
      if (kind === 'success') {
        terminalToast.current.completed += 1
        if (!terminalToast.current.firstFilename) terminalToast.current.firstFilename = detail
      } else {
        terminalToast.current.failed += 1
        if (!terminalToast.current.firstFailure) terminalToast.current.firstFailure = detail
      }
      if (terminalToastTimer.current) return
      terminalToastTimer.current = setTimeout(() => {
        terminalToastTimer.current = null
        const { completed, failed, firstFilename, firstFailure } = terminalToast.current
        terminalToast.current = { completed: 0, failed: 0, firstFilename: '', firstFailure: '' }
        if (completed === 1 && failed === 0) notify('success', `${firstFilename} finished`)
        else if (completed === 0 && failed === 1) notify('error', firstFailure)
        else notify(failed > 0 ? 'error' : 'success', `${completed} completed, ${failed} failed`)
      }, TERMINAL_TOAST_WINDOW_MS)
    },
    [notify]
  )

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const flush = useCallback(() => {
    frame.current = null
    const updates = pending.current
    if (updates.size === 0) return
    pending.current = new Map()

    setDownloads((current) => {
      let changed = false
      const next = current.map((download) => {
        const update = updates.get(download.id)
        if (!update) return download
        changed = true
        return {
          ...download,
          downloadedBytes: update.downloadedBytes,
          fileSize: update.fileSize > 0 ? update.fileSize : download.fileSize,
          speed: update.speed,
          eta: update.eta,
          chunksComplete: update.chunksComplete,
          chunksTotal: update.chunksTotal,
          chunkBitmap: update.chunkBitmap
        }
      })
      return changed ? next : current
    })

    let total = 0
    for (const count of connections.current.values()) total += count
    setActiveConnections(total)
  }, [])

  const applyProgress = useCallback(
    (event: DownloadProgressEvent) => {
      pending.current.set(event.id, event)
      connections.current.set(event.id, event.activeConnections)
      if (frame.current === null) {
        frame.current = requestAnimationFrame(flush)
      }
    },
    [flush]
  )

  const refresh = useCallback(async () => {
    try {
      const list = await window.moth.invoke.listDownloads()
      setDownloads(list)
    } catch (err) {
      notify('error', `Could not load downloads: ${describe(err)}`)
    } finally {
      setLoading(false)
    }
  }, [notify])

  // Initial load.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [list, loaded] = await Promise.all([
          window.moth.invoke.listDownloads(),
          window.moth.invoke.getSettings()
        ])
        if (cancelled) return
        setDownloads(list)
        setSettings(loaded)
      } catch (err) {
        if (!cancelled) notify('error', `Startup failed: ${describe(err)}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [notify])

  // Event subscriptions.
  useEffect(() => {
    const api = window.moth

    const offUpsert = api.on.downloadUpserted((download: Download) => {
      setDownloads((current) => {
        const index = current.findIndex((row) => row.id === download.id)
        if (index === -1) {
          // A newly added download: pull the full snapshot so the chunk counts
          // and bitmap are populated.
          void api.invoke.getDownload({ id: download.id }).then((snapshot) => {
            if (!snapshot) return
            setDownloads((rows) => [...rows.filter((r) => r.id !== snapshot.id), snapshot])
          })
          return current
        }
        const next = [...current]
        const existing = next[index] as DownloadSnapshot
        next[index] = {
          ...existing,
          ...download,
          // Preserve live fields the event does not carry.
          speed: existing.speed,
          eta: existing.eta,
          chunksComplete: existing.chunksComplete,
          chunksTotal: existing.chunksTotal,
          chunkBitmap: existing.chunkBitmap
        }
        return next
      })
    })

    const offRemoved = api.on.downloadRemoved(({ ids }) => {
      const removed = new Set(ids)
      let dropped = 0
      for (const id of removed) {
        if (connections.current.delete(id)) dropped += 1
      }
      if (dropped > 0) {
        let total = 0
        for (const count of connections.current.values()) total += count
        setActiveConnections(total)
      }
      setDownloads((current) => current.filter((row) => !removed.has(row.id)))
    })

    const offProgress = api.on.downloadProgress(applyProgress)

    const offStats = api.on.engineStats((next) => setStats(next))

    const offSpeed = api.on.speedHistory(({ samples: next }) => setSamples(next))

    const offSettings = api.on.settingsChanged((next) => setSettings(next))

    const offFinished = api.on.downloadFinished((payload) => {
      notifyTerminal('success', payload.filename)
      connections.current.delete(payload.id)
      setActiveConnections(
        [...connections.current.values()].reduce((sum, count) => sum + count, 0)
      )
      // The row's stored fields are authoritative after completion.
      void api.invoke.getDownload({ id: payload.id }).then((snapshot) => {
        if (!snapshot) return
        setDownloads((current) => current.map((row) => (row.id === snapshot.id ? snapshot : row)))
      })
    })

    const offFailed = api.on.downloadFailed((payload) => {
      notifyTerminal('error', payload.message)
    })

    const offRecovery = api.on.recoveryReport((report) => {
      setRecovery(report)
      if (report.repaired > 0) {
        notify('info', `Recovered ${report.repaired} download(s) after restart`)
      }
    })

    // Metadata resolved after a download completes, or edited by the user.
    const offMedia = api.on.mediaUpdated(({ id }) => {
      void api.invoke.getMediaMetadata({ id }).then((metadata) => {
        setDownloads((current) =>
          current.map((row) => (row.id === id ? { ...row, metadata: metadata ?? undefined } : row))
        )
      })
    })

    return () => {
      offUpsert()
      offRemoved()
      offProgress()
      offStats()
      offSpeed()
      offSettings()
      offFinished()
      offFailed()
      offRecovery()
      offMedia()
    }
  }, [applyProgress, notify, notifyTerminal])

  // Cancel a pending frame on unmount so no state update lands after teardown.
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      if (terminalToastTimer.current) clearTimeout(terminalToastTimer.current)
    },
    []
  )

  const byId = useMemo(() => new Map(downloads.map((row) => [row.id, row])), [downloads])

  return {
    downloads,
    byId,
    settings,
    stats,
    samples,
    recovery,
    toasts,
    loading,
    activeConnections,
    connectionsById: connections.current,
    refresh,
    dismissToast,
    notify,
    applyProgress
  }
}

export function describe(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return String(err)
}
