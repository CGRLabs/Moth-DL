/**
 * Application shell.
 *
 * All downloads stay visible in one searchable, newest-first library.
 *
 * Every command funnels failures through `run`, so a rejected IPC promise never
 * becomes an unhandled rejection in the renderer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DiskUsage } from '@shared/ipc.js'
import type { AddDownloadRequest, DownloadCategory, DownloadSnapshot } from '@shared/types.js'
import { useMothStore, describe } from './hooks/useMothStore.js'
import { Header } from './components/Header.js'
import { Sidebar, type FileCategoryFilter, type SidebarView } from './components/Sidebar.js'
import { DownloadRow } from './components/DownloadRow.js'
import { DownloadedFilesView } from './components/DownloadedFilesView.js'
import { BackgroundContextMenu, useBackgroundContextMenu } from './components/BackgroundContextMenu.js'
import { QueuePlansView } from './components/QueuePlansView.js'

import { RemoveDownloadDialog } from './components/RemoveDownloadDialog.js'
import { SourceLinkDialog } from './components/SourceLinkDialog.js'
import { SpeedGraph } from './components/SpeedGraph.js'
import { DownloadVisualization } from './components/DownloadVisualization.js'
import { AddDownloadDialog } from './components/AddDownloadDialog.js'
import { BrowserIntegrationPanel, SettingsDialog } from './components/SettingsDialog.js'
import { StatusBar, Toasts } from './components/StatusBar.js'
import { CATEGORY_LABEL, formatBytes, formatRate, isActive } from './lib/format.js'
import { selectDownloadedFiles } from '@shared/downloadedFiles.js'
import { isDarkPreset } from '@shared/theme.js'

export function App(): React.ReactElement {
  const store = useMothStore()
  const { downloads, settings, stats, samples, toasts, loading } = store

  const [search, setSearch] = useState('')
  const [downloadFilter, setDownloadFilter] = useState<'all' | 'active' | 'waiting' | 'completed' | 'failed'>('all')
  const [libraryView, setLibraryView] = useState<SidebarView>('queue')
  const [fileCategoryFilter, setFileCategoryFilter] = useState<FileCategoryFilter>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [showVisualization, setShowVisualization] = useState(false)
  const [reviewConfiguration, setReviewConfiguration] = useState<{
    id: string
    request: AddDownloadRequest
  } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [removePrompt, setRemovePrompt] = useState<DownloadSnapshot | null>(null)
  const [sourceLinkId, setSourceLinkId] = useState<string | null>(null)
  const sourceLink = sourceLinkId === null ? null : store.byId.get(sourceLinkId) ?? null
  const [developerMode, setDeveloperMode] = useState(() => {
    try {
      return window.localStorage.getItem('moth.developerMode') === 'true'
    } catch {
      return false
    }
  })
  const [version, setVersion] = useState('1.0.0')
  const [disk, setDisk] = useState<DiskUsage | null | undefined>(undefined)
  const backgroundMenu = useBackgroundContextMenu()
  const addQueue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    const reportError = (event: ErrorEvent): void => {
      window.moth.reportDiagnostic({
        kind: 'uncaught-error',
        message: event.message,
        ...(event.error instanceof Error && event.error.stack ? { stack: event.error.stack } : {}),
        ...(event.filename ? { source: event.filename } : {}),
        ...(event.lineno ? { line: event.lineno } : {}),
        ...(event.colno ? { column: event.colno } : {})
      })
    }
    const reportRejection = (event: PromiseRejectionEvent): void => {
      const reason = event.reason
      let message: string
      if (reason instanceof Error) message = reason.message
      else if (typeof reason === 'string') message = reason
      else {
        try {
          message = String(reason)
        } catch {
          message = '[unprintable rejection reason]'
        }
      }
      window.moth.reportDiagnostic({
        kind: 'unhandled-rejection',
        message,
        ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {})
      })
    }

    window.addEventListener('error', reportError)
    window.addEventListener('unhandledrejection', reportRejection)
    return () => {
      window.removeEventListener('error', reportError)
      window.removeEventListener('unhandledrejection', reportRejection)
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const theme = settings?.theme ?? 'graphite'
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = (): void => {
      const dark = isDarkPreset(theme, systemTheme.matches)
      root.classList.toggle('dark', dark)
      root.dataset.theme = theme === 'system' ? (dark ? 'graphite' : 'light') : theme
    }
    applyTheme()
    systemTheme.addEventListener('change', applyTheme)
    return () => systemTheme.removeEventListener('change', applyTheme)
  }, [settings?.theme])

  useEffect(() => {
    backgroundMenu.close()
  }, [backgroundMenu.close, libraryView])

  useEffect(() => {
    try {
      window.localStorage.setItem('moth.developerMode', String(developerMode))
    } catch {
      // Keep the toggle usable when browser storage is unavailable.
    }
  }, [developerMode])

  useEffect(() => {
    let cancelled = false
    void window.moth.invoke
      .getAppInfo()
      .then((info) => {
        if (!cancelled) setVersion(info.version)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Disk usage backs the sidebar footer and the live bar. Polled, because a
  // startup-only snapshot would go stale within one download.
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.moth.invoke
        .getDiskUsage()
        .then((next) => {
          if (!cancelled) setDisk(next)
        })
        .catch(() => {
          if (!cancelled) setDisk(null)
        })
    }
    load()
    const timer = setInterval(load, 10_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [settings?.downloadDirectory])

  /** Runs a command and funnels any failure into a toast. */
  const run = useCallback(
    (label: string, action: () => Promise<unknown>): void => {
      void (async () => {
        try {
          await action()
        } catch (err) {
          store.notify('error', `${label}: ${describe(err)}`)
        }
      })()
    },
    [store]
  )

  const onPause = useCallback((id: string) => run('Pause', () => window.moth.invoke.pauseDownload({ id })), [run])
  const onResume = useCallback((id: string) => run('Resume', () => window.moth.invoke.resumeDownload({ id })), [run])
  const onCancel = useCallback((id: string) => run('Cancel', () => window.moth.invoke.cancelDownload({ id })), [run])
  const onRetry = useCallback((id: string) => run('Retry', () => window.moth.invoke.retryDownload({ id })), [run])
  const onStartReview = useCallback(
    (id: string) => run('Start download', () => window.moth.invoke.startReviewDownload({ id })),
    [run]
  )
  const onConfigureReview = useCallback(
    (id: string) => run('Configure download', async () => {
      const request = await window.moth.invoke.getReviewRequest({ id })
      setReviewConfiguration({ id, request })
    }),
    [run]
  )
  const onSaveReviewConfiguration = useCallback(
    async (id: string, request: AddDownloadRequest): Promise<void> => {
      await window.moth.invoke.configureReviewDownload({ id, request })
      store.notify('success', 'Download settings saved. Start it whenever you’re ready.')
      await store.refresh()
    },
    [store]
  )
  const onRefreshUrl = useCallback(
    async (id: string, url: string): Promise<void> => {
      const result = await window.moth.invoke.refreshDownloadUrl({ id, url })
      store.notify(
        'success',
        result.keptProgress
          ? 'Link refreshed. The server validator matched; existing progress was kept.'
          : 'Link refreshed. Existing progress was reset because the server could not confirm the same file.'
      )
    },
    [store]
  )
  const onVerifyDownload = useCallback(
    (id: string) => window.moth.invoke.verifyDownload({ id }),
    []
  )
  const onReveal = useCallback((id: string) => run('Show in folder', () => window.moth.invoke.revealFile({ id })), [run])
  const onOpenFolder = useCallback((id: string) => run('Open folder', () => window.moth.invoke.openContainingFolder({ id })), [run])
  const onOpenFile = useCallback((id: string) => run('Open file', () => window.moth.invoke.openFile({ id })), [run])
  const onOpenSource = useCallback(
    (id: string) => run('Open source link', async () => {
      const download = store.byId.get(id)
      if (!download) throw new Error('Download not found')
      const url = new URL(download.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only HTTP and HTTPS source links can be opened')
      }
      window.open(url.href, '_blank', 'noopener,noreferrer')
    }),
    [run, store]
  )
  const onCopySource = useCallback(
    (id: string) => run('Copy source link', async () => {
      const download = store.byId.get(id)
      if (!download) throw new Error('Download not found')
      await navigator.clipboard.writeText(download.url)
      store.notify('success', 'Source link copied')
    }),
    [run, store]
  )
  const onCopyPath = useCallback(
    (path: string) => run('Copy file path', async () => {
      await navigator.clipboard.writeText(path)
      store.notify('success', 'File path copied')
    }),
    [run, store]
  )

  const onRemove = useCallback(
    (id: string) => {
      const download = store.byId.get(id)
      if (!download) return
      setRemovePrompt(download)
    },
    [store]
  )

  const confirmRemove = useCallback(
    (deleteFile: boolean) => {
      if (!removePrompt) return
      const { id } = removePrompt
      setRemovePrompt(null)
      run('Remove', async () => {
        await window.moth.invoke.removeDownload({ id, deleteFile })
      })
    },
    [removePrompt, run]
  )

  const onSetSpeedLimit = useCallback(
    (id: string, speedLimit: number | null) => {
      if (!store.byId.has(id)) return
      run('Speed limit', async () => {
        await window.moth.invoke.setSpeedLimit({ id, speedLimit })
        store.notify(
          'info',
          speedLimit === null ? 'Download limit removed' : `Download limited to ${formatRate(speedLimit)}`
        )
      })
    },
    [run, store]
  )

  const onSetUploadSpeedLimit = useCallback(
    (id: string, speedLimit: number | null) => {
      if (!store.byId.has(id)) return
      run('Torrent upload limit', async () => {
        await window.moth.invoke.setUploadSpeedLimit({ id, speedLimit })
        store.notify(
          'info',
          speedLimit === null ? 'Torrent upload limit removed' : `Torrent upload limited to ${formatRate(speedLimit)}`
        )
      })
    },
    [run, store]
  )

  const onSetTorrentFiles = useCallback(
    async (id: string, indexes: number[]): Promise<void> => {
      try {
        await window.moth.invoke.setTorrentFiles({ id, indexes })
        await store.refresh()
        store.notify('success', 'Torrent file selection saved')
      } catch (error) {
        store.notify('error', `Torrent file selection: ${describe(error)}`)
      }
    },
    [store]
  )

  const onSetGlobalSpeedLimit = useCallback(
    (globalSpeedLimit: number | null) => {
      run('WAN speed cap', async () => {
        await window.moth.invoke.setSettings({ globalSpeedLimit })
        await store.refresh()
        store.notify(
          'success',
          globalSpeedLimit === null ? 'Global speed cap removed' : `Global speed cap set to ${formatRate(globalSpeedLimit)}`
        )
      })
    },
    [run, store]
  )

  const onSetPriority = useCallback(
    (id: string, priority: number) => {
      if (!store.byId.has(id)) return
      run('Priority', async () => {
        await window.moth.invoke.setPriority({ id, priority })
        store.notify('info', `Priority set to ${priority} (0 is highest)`)
      })
    },
    [run, store]
  )

  const onSetQuota = useCallback(
    (id: string, quotaBytes: number | null) => {
      if (!store.byId.has(id)) return
      run('Download quota', async () => {
        await window.moth.invoke.setDownloadQuota({ id, quotaBytes })
        store.notify(
          'info',
          quotaBytes === null
            ? 'Download quota cleared'
            : `Download pauses after ${formatBytes(quotaBytes)}`
        )
      })
    },
    [run, store]
  )

  const onSaveMetadata = useCallback(
    async (id: string, patch: Record<string, string | number | null>): Promise<void> => {
      try {
        await window.moth.invoke.setMediaMetadata({ id, patch })
      } catch (err) {
        store.notify('error', `Save metadata: ${describe(err)}`)
      }
    },
    [store]
  )

  const onWriteTags = useCallback(
    async (id: string): Promise<{ written: boolean; reason?: string }> => {
      try {
        return await window.moth.invoke.writeMediaTags({ id })
      } catch (err) {
        store.notify('error', `Write tags: ${describe(err)}`)
        return { written: false, reason: describe(err) }
      }
    },
    [store]
  )

  const onPauseAll = useCallback(() => run('Pause all', () => window.moth.invoke.pauseAll()), [run])
  const onResumeAll = useCallback(() => run('Resume all', () => window.moth.invoke.resumeAll()), [run])

  const onAddDownloads = useCallback(
    (requests: AddDownloadRequest[]) => {
      store.notify(
        'info',
        `${requests.length === 1 ? 'Download request' : `${requests.length} download requests`} queued for background preparation`
      )
      addQueue.current = addQueue.current.then(async () => {
        let added = 0
        for (const request of requests) {
          try {
            await window.moth.invoke.stageDownload(request)
            added += 1
            void store.refresh()
          } catch (err) {
            store.notify('error', `Add download: ${describe(err)}`)
          }
        }
        if (added > 0) {
          store.notify('success', added === 1 ? 'Download added' : `${added} downloads added`)
          void store.refresh()
        }
      })
    },
    [store]
  )

  const onClearCompleted = useCallback(() => {
    const completed = downloads.filter((d) => d.status === 'completed')
    if (completed.length === 0) return
    if (settings?.confirmOnRemove) {
      const confirmation = `Remove ${completed.length} completed item(s) from the list?`
      if (!window.confirm(`${confirmation} Downloaded files will be kept.`)) return
    }
    run('Clear completed', async () => {
      await window.moth.invoke.clearCompleted({})
      await store.refresh()
    })
  }, [downloads, run, settings?.confirmOnRemove, store])

  const onRescan = useCallback(() => {
    store.notify('info', 'Re-checking partial files on disk')
    run('Rescan', async () => {
      const result = await window.moth.invoke.rescanDisk({})
      await store.refresh()
      const total = result.repaired.length + result.invalidated.length
      store.notify(
        'success',
        total === 0 ? 'Everything on disk matches the database' : `Reconciled ${total} download(s)`
      )
    })
  }, [run, store])

  // --- derived -------------------------------------------------------------

  /** Search only narrows the library when the user explicitly enters a query. */
  const searched = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const matches = needle
      ? downloads.filter(
          (download) =>
            download.filename.toLowerCase().includes(needle) ||
            download.url.toLowerCase().includes(needle)
        )
      : downloads
    return [...matches].sort(
      (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)
    )
  }, [downloads, search])

  const searchedFiles = useMemo(() => {
    return selectDownloadedFiles(downloads, search, fileCategoryFilter)
  }, [downloads, search, fileCategoryFilter])

  const categoryCounts = useMemo(() => {
    const counts: Record<DownloadCategory, number> = {
      video: 0,
      audio: 0,
      document: 0,
      archive: 0,
      executable: 0,
      image: 0,
      installer: 0,
      other: 0
    }
    for (const download of downloads) {
      if (download.status === 'completed') counts[download.category] += 1
    }
    return counts
  }, [downloads])

  const filterCounts = useMemo(() => ({
    all: downloads.length,
    active: downloads.filter((download) => isActive(download.status)).length,
    waiting: downloads.filter((download) => ['review', 'queued', 'paused', 'scheduled'].includes(download.status)).length,
    completed: downloads.filter((download) => download.status === 'completed').length,
    failed: downloads.filter((download) => download.status === 'failed').length
  }), [downloads])
  const visibleDownloads = useMemo(() => searched.filter((download) => {
    if (downloadFilter === 'active') return isActive(download.status)
    if (downloadFilter === 'waiting') return ['review', 'queued', 'paused', 'scheduled'].includes(download.status)
    if (downloadFilter === 'completed' || downloadFilter === 'failed') return download.status === downloadFilter
    return true
  }), [searched, downloadFilter])

  // Derived from the sample window so the strip and the plot can never disagree.
  const currentSpeed = stats?.totalSpeed ?? 0
  const hasActiveTransfer = (stats?.activeDownloads ?? 0) > 0 || currentSpeed > 0
  const peakSpeed = useMemo(
    () => samples.reduce((max, s) => Math.max(max, s.bytesPerSecond), 0),
    [samples]
  )
  const renderDownloadRow = (download: DownloadSnapshot): React.ReactElement => (
    <DownloadRow
      key={download.id}
      download={download}
      developerMode={developerMode}
      activeConnections={store.connectionsById.get(download.id) ?? 0}
      onPause={onPause}
      onResume={onResume}
      onCancel={onCancel}
      onRetry={onRetry}
      onStartReview={onStartReview}
      onConfigureReview={onConfigureReview}
      onRefreshUrl={onRefreshUrl}
      onVerifyDownload={onVerifyDownload}
      onRemove={onRemove}
      onReveal={onReveal}
      onOpenFolder={onOpenFolder}
      onOpenFile={onOpenFile}
      onOpenSource={onOpenSource}
      onViewSource={setSourceLinkId}
      onCopySource={onCopySource}
      onCopyPath={onCopyPath}
      onSetSpeedLimit={onSetSpeedLimit}
      onSetUploadSpeedLimit={onSetUploadSpeedLimit}
      onSetTorrentFiles={onSetTorrentFiles}
      onSetPriority={onSetPriority}
      onSetQuota={onSetQuota}
      onSaveMetadata={onSaveMetadata}
      onWriteTags={onWriteTags}
    />
  )

  return (
    <div className="flex h-full bg-[color:var(--surface)] text-ink">
      <Sidebar
        view={libraryView}
        categoryFilter={fileCategoryFilter}
        categoryCounts={categoryCounts}
        queueCount={downloads.length}
        completedCount={downloads.filter((download) => download.status === 'completed').length}
        onSelectView={setLibraryView}
        onSelectCategory={(category) => {
          setFileCategoryFilter(category)
          setLibraryView('files')
        }}
        onPauseAll={onPauseAll}
        onResumeAll={onResumeAll}
        onClearCompleted={onClearCompleted}
        onRescan={onRescan}
        onOpenSettings={() => setShowSettings(true)}
        disk={disk}
      />

      <div className="workspace-backdrop flex min-w-0 flex-1 flex-col">
        <Header
          onAdd={() => setShowAdd(true)}
          onVisualize={() => setShowVisualization(true)}
          search={search}
          onSearch={setSearch}
          matchCount={libraryView === 'plans' ? 0 : libraryView === 'files' ? searchedFiles.length : searched.length}
          totalCount={
            libraryView === 'plans'
              ? 0
              : libraryView === 'files'
              ? fileCategoryFilter === 'all'
                ? filterCounts.completed
                : categoryCounts[fileCategoryFilter]
              : downloads.length
          }
          showSearch={libraryView !== 'browser' && libraryView !== 'plans'}
        />

        <div className="shrink-0 border-b border-line bg-[color:var(--surface-2)] px-4 py-2">
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Network activity
            </h2>
            <span className="font-mono text-[11.5px] tabular-nums text-muted">
              <span className="font-semibold text-ink-2">{formatRate(currentSpeed)}</span>{' '}
              · peak {formatRate(peakSpeed)} · last 60s
            </span>
          </div>
          <SpeedGraph
            samples={samples}
            limit={stats?.globalSpeedLimit ?? null}
            height={hasActiveTransfer ? 68 : 28}
          />
        </div>
        <main
          className="min-h-0 flex-1 overflow-y-auto bg-transparent"
          onContextMenu={libraryView === 'queue' || libraryView === 'files' ? backgroundMenu.onContextMenu : undefined}
        >
          {libraryView === 'browser' ? (
            settings ? (
              <section className="mx-auto max-w-[900px] px-5 py-6 sm:px-8">
                <header className="mb-5 border-b border-line pb-4">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">
                    Connect Moth
                  </p>
                  <h1 className="mt-1 text-lg font-semibold text-ink">Browser Integration</h1>
                  <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-muted">
                    Send links from your browser to Moth, configure the companion extension, and
                    manage browser download-folder monitoring.
                  </p>
                </header>
                <BrowserIntegrationPanel
                  watchDownloadFolder={settings.watchDownloadFolder}
                  downloadDirectory={settings.downloadDirectory}
                />
              </section>
            ) : (
              <EmptyState title="Loading browser integration" body="Reading your Moth settings." />
            )
          ) : libraryView === 'queue' && !loading && downloads.length > 0 ? (
            <nav aria-label="Filter downloads" className="sticky top-0 z-10 flex flex-nowrap gap-1.5 overflow-x-auto border-b border-line bg-[color:var(--surface)] px-4 py-2.5 sm:px-6">
              {(['all', 'active', 'waiting', 'completed', 'failed'] as const).map((filter) => {
                const labels = { all: 'All', active: 'Active', waiting: 'Waiting', completed: 'Completed', failed: 'Failed' }
                return (
                  <button
                    key={filter}
                    type="button"
                    aria-pressed={downloadFilter === filter}
                    onClick={() => setDownloadFilter(filter)}
                    className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${downloadFilter === filter ? 'bg-[color:var(--surface-3)] text-ink' : 'text-muted hover:bg-[color:var(--surface-2)] hover:text-ink-2'}`}
                  >
                    {labels[filter]} <span className="ml-1 font-mono tabular-nums text-muted">{filterCounts[filter]}</span>
                  </button>
                )
              })}
            </nav>
          ) : null}
          {libraryView === 'browser' ? null : libraryView === 'plans' ? (
            <QueuePlansView downloads={downloads} notify={store.notify} />
          ) : loading ? (
            <EmptyState
              title="Loading your downloads"
              body="Reading the local database and reconciling partial files."
            />
          ) : libraryView === 'files' ? (
            searchedFiles.length > 0 ? (
              <DownloadedFilesView
                downloads={searchedFiles}
                category={fileCategoryFilter}
                developerMode={developerMode}
                onOpenFile={onOpenFile}
                onOpenFolder={onOpenFolder}
                onOpenSource={onOpenSource}
                onViewSource={setSourceLinkId}
                onCopySource={onCopySource}
                onCopyPath={onCopyPath}
                onReveal={onReveal}
                onRemove={onRemove}
              />
            ) : (
              <EmptyState
                title={
                  search.trim()
                    ? `No downloaded files match "${search.trim()}"`
                    : fileCategoryFilter === 'all'
                      ? 'No completed files yet'
                      : `No ${CATEGORY_LABEL[fileCategoryFilter]} files yet`
                }
                body={
                  search.trim()
                    ? 'Clear the search to see your downloaded files.'
                    : 'Completed downloads in this category will appear here.'
                }
                action={search.trim() ? (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="rounded-md border border-line px-3 py-1.5 text-[11px] font-medium text-ink-2 hover:bg-[color:var(--surface-2)]"
                  >
                    Clear search
                  </button>
                ) : downloads.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowAdd(true)}
                    className="btn-primary rounded-md px-3 py-1.5 text-[11px] font-semibold"
                  >
                    Add download
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setLibraryView('queue')}
                    className="rounded-md border border-line px-3 py-1.5 text-[11px] font-medium text-ink-2 hover:bg-[color:var(--surface-2)]"
                  >
                    View queue
                  </button>
                )}
              />
            )
          ) : visibleDownloads.length === 0 ? (
            <EmptyState
              title={
                search.trim().length > 0
                  ? `Nothing matches "${search.trim()}"`
                  : downloadFilter === 'all'
                    ? 'Your downloads will appear here'
                    : `No ${downloadFilter === 'waiting' ? 'waiting' : downloadFilter} downloads`
              }
              body={
                search.trim().length > 0
                  ? 'Clear the search to see every download.'
                  : downloadFilter === 'all'
                    ? 'Add a link to start your first download.'
                    : 'Choose another filter or add a download.'
              }
              action={downloadFilter !== 'all' || search.trim() ? (
                <button
                  type="button"
                  onClick={() => {
                    setDownloadFilter('all')
                    setSearch('')
                  }}
                  className="rounded-md border border-line px-3 py-1.5 text-[11px] font-medium text-ink-2 hover:bg-[color:var(--surface-2)]"
                >
                  Show all downloads
                </button>
              ) : downloads.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAdd(true)}
                  className="btn-primary rounded-md px-3 py-1.5 text-[11px] font-semibold"
                >
                  Add download
                </button>
              ) : undefined}
            />
          ) : (
            <div className="mx-auto max-w-[1120px]">
              <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-6">
                <h1 className="text-[13px] font-semibold text-ink">
                  {downloadFilter === 'all' ? 'All downloads' : `${downloadFilter[0]?.toUpperCase()}${downloadFilter.slice(1)} downloads`}
                </h1>
                <span className="font-mono text-[11.5px] tabular-nums text-muted">
                  {search.trim() || downloadFilter !== 'all' ? `${visibleDownloads.length} shown` : downloads.length}
                </span>
              </div>
              <div>{visibleDownloads.map(renderDownloadRow)}</div>
            </div>
          )}
        </main>
        <BackgroundContextMenu
          position={backgroundMenu.position}
          onClose={backgroundMenu.close}
          actions={libraryView === 'queue'
            ? [
                { label: 'Add download…', onClick: () => setShowAdd(true) },
                { label: 'Pause all downloads', onClick: onPauseAll },
                { label: 'Resume all downloads', onClick: onResumeAll },
                {
                  label: 'Clear completed downloads',
                  onClick: onClearCompleted,
                  disabled: downloads.every((download) => download.status !== 'completed'),
                  separatorBefore: true
                }
              ]
            : [
                { label: 'Add download…', onClick: () => setShowAdd(true) },
                { label: 'Refresh files list', onClick: () => void store.refresh() }
              ]}
        />

        <StatusBar
          stats={stats}
          version={version}
          activeConnections={store.activeConnections}
          freeBytes={disk?.freeBytes ?? null}
          onOpenLogs={() => void window.moth.invoke.openLogsFolder()}
        />
      </div>

      <Toasts toasts={toasts} onDismiss={store.dismissToast} />

      {showVisualization ? (
        <DownloadVisualization
          downloads={downloads}
          stats={stats}
          activeConnectionsById={store.connectionsById}
          developerMode={developerMode}
          globalSpeedLimit={settings?.globalSpeedLimit ?? null}
          onClose={() => setShowVisualization(false)}
          onAdd={() => {
            setShowVisualization(false)
            setShowAdd(true)
          }}
          onPause={onPause}
          onResume={onResume}
          onRetry={onRetry}
          onCancel={onCancel}
          onRemove={(id) => {
            setShowVisualization(false)
            onRemove(id)
          }}
          onStartReview={onStartReview}
          onConfigureReview={(id) => {
            setShowVisualization(false)
            onConfigureReview(id)
          }}
          onRefreshUrl={onRefreshUrl}
          onVerifyDownload={onVerifyDownload}
          onReveal={onReveal}
          onOpenFolder={onOpenFolder}
          onOpenFile={onOpenFile}
          onOpenSource={onOpenSource}
          onCopySource={onCopySource}
          onCopyPath={onCopyPath}
          onSetSpeedLimit={onSetSpeedLimit}
          onSetUploadSpeedLimit={onSetUploadSpeedLimit}
          onSetTorrentFiles={onSetTorrentFiles}
          onSetPriority={onSetPriority}
          onSetQuota={onSetQuota}
          onSaveMetadata={onSaveMetadata}
          onWriteTags={onWriteTags}
          onSetGlobalSpeedLimit={onSetGlobalSpeedLimit}
        />
      ) : null}

      {showAdd ? (
        <AddDownloadDialog
          onClose={() => {
            setShowAdd(false)
          }}
          onAdd={onAddDownloads}
          onError={(message) => store.notify('error', message)}
          defaultDirectory={settings?.downloadDirectory ?? ''}
          initialUrl=""
        />
      ) : null}

      {reviewConfiguration ? (
        <AddDownloadDialog
          key={reviewConfiguration.id}
          onClose={() => setReviewConfiguration(null)}
          onAdd={onAddDownloads}
          onError={(message) => store.notify('error', message)}
          defaultDirectory={settings?.downloadDirectory ?? ''}
          initialUrl={reviewConfiguration.request.url}
          reviewId={reviewConfiguration.id}
          initialRequest={reviewConfiguration.request}
          onConfigureReview={onSaveReviewConfiguration}
        />
      ) : null}

      {showSettings && settings ? (
        <SettingsDialog
          settings={settings}
          developerMode={developerMode}
          onDeveloperModeChange={setDeveloperMode}
          onClose={() => setShowSettings(false)}
          onSaved={() => store.notify('success', 'Settings saved')}
          onError={(message) => store.notify('error', message)}
        />
      ) : null}
      {removePrompt ? (
        <RemoveDownloadDialog
          download={removePrompt}
          onClose={() => setRemovePrompt(null)}
          onRemove={confirmRemove}
        />
      ) : null}
      {sourceLink ? (
        <SourceLinkDialog
          download={sourceLink}
          onClose={() => setSourceLinkId(null)}
        />
      ) : null}
    </div>
  )
}

function EmptyState({
  title,
  body,
  action
}: {
  title: string
  body: string
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <p className="max-w-sm text-[11.5px] leading-relaxed text-muted">{body}</p>
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  )
}
