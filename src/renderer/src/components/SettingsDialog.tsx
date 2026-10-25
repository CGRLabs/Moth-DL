/** Settings dialog. Applies through the IPC layer so changes are validated. */

import { useEffect, useState } from 'react'
import type { AppSettings, DownloadCategory } from '@shared/types.js'
import type { DiskRescanDetail, ExtensionStatusResult, IngestInfo } from '@shared/ipc.js'
import { Field, Modal, inputClass } from './Modal.js'
import { describe } from '../hooks/useMothStore.js'
import { formatBytes } from '../lib/format.js'
import { THEME_PRESETS } from '@shared/theme.js'

interface Props {
  settings: AppSettings
  developerMode: boolean
  onDeveloperModeChange: (enabled: boolean) => void
  onClose: () => void
  onSaved: (settings: AppSettings) => void
  onError: (message: string) => void
}

const CATEGORIES: DownloadCategory[] = [
  'video',
  'audio',
  'document',
  'archive',
  'executable',
  'image',
  'installer',
  'other'
]

type DiagnosticFinding = {
  level: 'ok' | 'warn' | 'info'
  title: string
  detail: string
  action?: 'choose-folder' | 'enable-integration' | 'install-extension'
}

export function SettingsDialog({ settings, developerMode, onDeveloperModeChange, onClose, onSaved, onError }: Props): React.ReactElement {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [saving, setSaving] = useState(false)
  const [diagnosing, setDiagnosing] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [savingReport, setSavingReport] = useState(false)
  const [diagnostics, setDiagnostics] = useState<DiagnosticFinding[] | null>(null)
  const [diagnosedAt, setDiagnosedAt] = useState<string | null>(null)
  const [repairMessage, setRepairMessage] = useState<string | null>(null)
  const [rescanDetails, setRescanDetails] = useState<DiskRescanDetail[] | null>(null)
  const [reportMessage, setReportMessage] = useState<string | null>(null)
  const [reportPreview, setReportPreview] = useState<{ id: string; preview: string } | null>(null)
  const [reportReviewed, setReportReviewed] = useState(false)
  const [limitText, setLimitText] = useState(
    settings.globalSpeedLimit === null ? '' : String(Math.round(settings.globalSpeedLimit / 1024 / 1024))
  )

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }))

  const chooseDirectory = async (): Promise<void> => {
    const chosen = await window.moth.invoke.selectDirectory({ title: 'Choose a download folder' })
    if (chosen) set('downloadDirectory', chosen)
  }

  const chooseCategoryDirectory = async (category: DownloadCategory): Promise<void> => {
    const chosen = await window.moth.invoke.selectDirectory({
      title: `Choose the ${category} download folder`
    })
    if (chosen) {
      setDraft((current) => ({
        ...current,
        categoryFolders: { ...current.categoryFolders, [category]: chosen }
      }))
    }
  }

  const runDiagnostics = async (): Promise<void> => {
    setDiagnosing(true)
    try {
      const [disk, stats, downloads, ingest, paths, appInfo, extension] = await Promise.all([
        window.moth.invoke.getDiskUsage(),
        window.moth.invoke.getStats(),
        window.moth.invoke.listDownloads(),
        window.moth.invoke.getIngestInfo(),
        window.moth.invoke.getPaths(),
        window.moth.invoke.getAppInfo(),
        window.moth.invoke.getExtensionStatus()
      ])
      const failed = downloads.filter((download) => download.status === 'failed')
      const detectedBrowsers = extension.browsers.filter((browser) => browser.detected)
      const unregisteredBrowsers = detectedBrowsers.filter(
        (browser) => browser.registeredVersion === null
      )
      const outdatedBrowsers = detectedBrowsers.filter(
        (browser) =>
          browser.registeredVersion !== null &&
          browser.currentVersion !== browser.registeredVersion
      )
      const findings: DiagnosticFinding[] = [
        {
          level: paths.downloads && disk ? 'ok' : 'warn',
          title: 'Download location',
          detail: disk
            ? `${paths.downloads} · ${formatBytes(disk.freeBytes)} free`
            : 'Moth could not read disk space for this location. Choose a folder that exists and is writable.',
          ...(!disk ? { action: 'choose-folder' as const } : {})
        },
        {
          level: disk && disk.freeBytes < 2 * 1024 ** 3 ? 'warn' : 'ok',
          title: 'Available disk space',
          detail: disk
            ? `${formatBytes(disk.freeBytes)} free on the download volume.`
            : 'Disk space could not be checked.'
        },
        {
          level: failed.length > 0 ? 'warn' : 'ok',
          title: 'Download queue',
          detail: failed.length > 0
            ? `${failed.length} failed download(s); inspect their row details before retrying.`
            : `${stats.activeDownloads} active, ${stats.queuedDownloads} queued, ${stats.completedDownloads} completed.`
        },
        {
          level: ingest.enabled && !ingest.running ? 'warn' : 'info',
          title: 'Browser / agent integration',
          detail: ingest.running
            ? `Listening on loopback port ${ingest.port}.`
            : ingest.enabled
              ? 'Integration is enabled but the local endpoint is not listening. Moth will try to start it again when enabled.'
              : 'Disabled. Turn it on if you use the browser extension or terminal API.',
          ...(!ingest.running ? { action: 'enable-integration' as const } : {})
        },
        {
          level: !extension.supported || !extension.packaged || detectedBrowsers.length === 0
            ? 'info'
            : unregisteredBrowsers.length > 0 || outdatedBrowsers.length > 0
              ? 'warn'
              : 'info',
          title: 'Browser extension',
          detail: !extension.supported
            ? 'Automatic registration is only supported on Windows. Manual installation remains available.'
            : !extension.packaged
              ? 'The signed extension package is not present. Use the unpacked extension folder or reinstall the app package.'
              : detectedBrowsers.length === 0
                ? 'No supported Chromium browser was detected. Firefox and other browsers need manual installation.'
                : unregisteredBrowsers.length > 0
                  ? `Not registered in ${unregisteredBrowsers.map((browser) => browser.label).join(', ')}.`
                  : outdatedBrowsers.length > 0
                    ? `Registered version is out of date in ${outdatedBrowsers.map((browser) => browser.label).join(', ')}.`
                    : `A registry entry for the current extension is present in ${detectedBrowsers.filter((browser) => browser.registered).map((browser) => browser.label).join(', ')}. This does not confirm the browser loaded or enabled it; check the browser's extensions page.`,
          ...(extension.supported &&
          extension.packaged &&
          (unregisteredBrowsers.length > 0 || outdatedBrowsers.length > 0)
            ? { action: 'install-extension' as const }
            : {})
        },
        {
          level: 'info',
          title: 'App diagnostics',
          detail: `Moth ${appInfo.version} · data and logs are stored in ${paths.userData}.`
        }
      ]
      setDiagnostics(findings)
      setDiagnosedAt(new Date().toLocaleTimeString())
    } catch (err) {
      onError(`Could not complete diagnostics: ${describe(err)}`)
    } finally {
      setDiagnosing(false)
    }
  }

  const repairDownloadState = async (): Promise<void> => {
    setRepairing(true)
    try {
      const result = await window.moth.invoke.rescanDisk({})
      const changed = result.repaired.length + result.invalidated.length + result.failed.length
      setRescanDetails(result.details)
      setRepairMessage(
        changed === 0
          ? `Rescan complete: no files needed repair (${Math.round(result.durationMs)} ms).`
          : `Rescan complete: ${result.repaired.length} repaired, ${result.invalidated.length} invalidated, ${result.failed.length} failed.`
      )
      await runDiagnostics()
    } catch (err) {
      setRepairMessage(null)
      setRescanDetails(null)
      onError(`Could not repair download state: ${describe(err)}`)
    } finally {
      setRepairing(false)
    }
  }

  const runSuggestedRepair = async (
    action: NonNullable<DiagnosticFinding['action']>
  ): Promise<void> => {
    setRepairing(true)
    setRepairMessage(null)
    try {
      if (action === 'choose-folder') {
        await chooseDirectory()
        setRepairMessage('Choose a valid location, then save Settings to apply it.')
      } else if (action === 'enable-integration') {
        const updated = await window.moth.invoke.setSettings({ browserIntegration: true })
        setDraft((current) => ({ ...current, browserIntegration: updated.browserIntegration }))
        onSaved(updated)
        let info = await window.moth.invoke.getIngestInfo()
        for (let attempt = 0; attempt < 10 && !info.running; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          info = await window.moth.invoke.getIngestInfo()
        }
        setRepairMessage(
          info.running
            ? `Browser integration is listening on port ${info.port}.`
            : 'Moth could not start the local endpoint. Check the log folder for the startup error.'
        )
      } else {
        const updated = await window.moth.invoke.setSettings({ browserIntegration: true })
        setDraft((current) => ({ ...current, browserIntegration: updated.browserIntegration }))
        onSaved(updated)
        const result = await window.moth.invoke.installExtension({})
        const failed = result.results.filter((entry) => !entry.ok)
        setRepairMessage(
          !result.supported
            ? 'Automatic extension registration is only supported on Windows.'
            : result.results.length === 0
              ? 'No supported Chromium browser was detected.'
              : failed.length === 0
                ? 'Extension registered. Restart the browser and accept its enable prompt.'
                : `Some browsers could not be updated: ${failed.map((entry) => `${entry.label}: ${entry.error ?? 'unknown error'}`).join('; ')}`
        )
      }
      if (action !== 'choose-folder') await runDiagnostics()
    } catch (err) {
      onError(`Could not complete the suggested repair: ${describe(err)}`)
    } finally {
      setRepairing(false)
    }
  }

  const prepareDiagnosticReport = async (): Promise<void> => {
    setSavingReport(true)
    try {
      const prepared = await window.moth.invoke.prepareDiagnosticReport()
      setReportPreview(prepared)
      setReportReviewed(false)
      setReportMessage(null)
    } catch (err) {
      setReportMessage(null)
      onError(`Could not prepare diagnostic report: ${describe(err)}`)
    } finally {
      setSavingReport(false)
    }
  }

  const saveDiagnosticReport = async (): Promise<void> => {
    if (!reportPreview || !reportReviewed) return
    setSavingReport(true)
    try {
      const path = await window.moth.invoke.saveDiagnosticReport({
        id: reportPreview.id,
        reviewed: true
      })
      setReportMessage(path ? `Diagnostic report saved to ${path}` : 'Report save canceled.')
      if (path) {
        setReportPreview(null)
        setReportReviewed(false)
      }
    } catch (err) {
      setReportMessage(null)
      onError(`Could not save diagnostic report: ${describe(err)}`)
    } finally {
      setSavingReport(false)
    }
  }

  const discardDiagnosticReport = async (): Promise<void> => {
    if (!reportPreview) return
    setSavingReport(true)
    try {
      await window.moth.invoke.discardDiagnosticReport({ id: reportPreview.id })
      setReportPreview(null)
      setReportReviewed(false)
      setReportMessage('Report preview discarded.')
    } catch (err) {
      onError(`Could not discard diagnostic report: ${describe(err)}`)
    } finally {
      setSavingReport(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      let globalSpeedLimit: number | null = null
      if (limitText.trim()) {
        const parsed = Number.parseInt(limitText, 10)
        if (!Number.isFinite(parsed) || parsed < 0) {
          onError('Global speed limit must be a non-negative number of MB/s')
          setSaving(false)
          return
        }
        globalSpeedLimit = Math.round(parsed * 1024 * 1024)
      }

      const next = await window.moth.invoke.setSettings({
        downloadDirectory: draft.downloadDirectory,
        categoryFolders: draft.categoryFolders,
        autoCategorize: draft.autoCategorize,
        globalSpeedLimit,
        maxConcurrentDownloads: draft.maxConcurrentDownloads,
        defaultConnections: draft.defaultConnections,
        chunkSize: draft.chunkSize,
        maxRetries: draft.maxRetries,
        verifyChecksums: draft.verifyChecksums,
        autoStartDownloads: draft.autoStartDownloads,
        minimizeToTray: draft.minimizeToTray,
        closeToTray: draft.closeToTray,
        notificationsEnabled: draft.notificationsEnabled,
        notifyOnDownloadComplete: draft.notifyOnDownloadComplete,
        theme: draft.theme,
        accentColor: draft.accentColor,
        logLevel: draft.logLevel,
        confirmOnRemove: draft.confirmOnRemove
      })
      onSaved(next)
      onClose()
    } catch (err) {
      onError(describe(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Settings"
      subtitle="Choose the basics here; advanced controls are optional."
      onClose={onClose}
      wide
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
            onClick={() => void save()}
            disabled={saving}
            className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-on-brand transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <Section title="Appearance">
        <Field label="Color theme" hint="Choose a calm palette with a subtle background glow.">
          <select
            value={draft.theme}
            onChange={(event) => {
              const preset = THEME_PRESETS.find((entry) => entry.id === event.target.value)
              if (preset) set('theme', preset.id)
            }}
            className={inputClass}
          >
            {THEME_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.id === 'system' ? 'System (follow device)' : preset.label}
              </option>
            ))}
          </select>
        </Field>
        <Toggle
          label="Developer mode"
          hint="Show technical transfer details in each download's expanded panel. This preference stays on this device."
          checked={developerMode}
          onChange={onDeveloperModeChange}
        />
      </Section>

      <Section title="Location">
        <Field label="Download folder">
          <div className="flex gap-2">
            <input
              value={draft.downloadDirectory}
              onChange={(event) => set('downloadDirectory', event.target.value)}
              className={`${inputClass} font-mono text-xs`}
            />
            <button
              type="button"
              onClick={() => void chooseDirectory()}
              className="shrink-0 rounded-lg border border-line px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)]"
            >
              Browse
            </button>
          </div>
        </Field>
        <Toggle
          label="Organize files into type folders"
          hint="For example, videos go into Videos and music goes into Music."
          checked={draft.autoCategorize}
          onChange={(value) => set('autoCategorize', value)}
        />
        {draft.autoCategorize ? (
          <details className="mb-3 rounded-lg border border-line bg-[color:var(--surface)] px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-medium text-ink-2">
              Choose folders for each file type
            </summary>
            <p className="mt-2 text-[10.5px] text-muted">
              Type a folder name to create it inside your download folder, or browse to choose an existing folder anywhere.
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CATEGORIES.map((category) => (
                <label key={category} className="block">
                  <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-muted">
                    {category}
                  </span>
                  <span className="flex gap-1.5">
                    <input
                      value={draft.categoryFolders[category]}
                      aria-label={`${category} folder name or path`}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          categoryFolders: { ...current.categoryFolders, [category]: event.target.value }
                        }))
                      }
                      className={`${inputClass} min-w-0 flex-1 px-2 py-1 font-mono text-xs`}
                    />
                    <button
                      type="button"
                      onClick={() => void chooseCategoryDirectory(category)}
                      className="shrink-0 rounded-lg border border-line px-2 text-[11px] font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)]"
                    >
                      Browse
                    </button>
                  </span>
                </label>
              ))}
            </div>
          </details>
        ) : null}
      </Section>

      <Section title="Torrent engine (experimental)">
        <p className="text-[10.5px] text-muted">
          {window.moth.platform === 'win32'
            ? 'The Windows x64 app bundles Transmission and starts it with an authenticated loopback-only RPC endpoint. No separate install or path setting is needed.'
            : 'The bundled Transmission runtime is currently available in the Windows x64 app only.'}{' '}
          Moth supports v1/v2 magnets, .torrent sources, file selection, and per-torrent download/upload caps. Seeding stops on completion; advanced tracker management and global torrent caps are not included.
        </p>
      </Section>

      <Section title="Behaviour">
        <Toggle
          label="Check downloaded files for errors"
          hint="Verifies the file data when a download finishes."
          checked={draft.verifyChecksums}
          onChange={(value) => set('verifyChecksums', value)}
        />
        <Toggle
          label="Start downloads immediately"
          hint="Otherwise, new downloads wait in the queue until you resume them."
          checked={draft.autoStartDownloads}
          onChange={(value) => set('autoStartDownloads', value)}
        />
        <Toggle
          label="Show desktop notifications"
          checked={draft.notificationsEnabled}
          onChange={(value) => set('notificationsEnabled', value)}
        />
        <Toggle
          label="Notify when a download completes"
          hint="Turn this off to keep other desktop notifications while hiding completion alerts."
          checked={draft.notifyOnDownloadComplete}
          onChange={(value) => set('notifyOnDownloadComplete', value)}
        />
        <Toggle
          label="Keep running in the system tray"
          hint="When on, closing the window hides Moth and downloads continue in the tray. When off, closing quits the app."
          checked={draft.closeToTray}
          onChange={(value) => set('closeToTray', value)}
        />
        <Toggle
          label="Confirm before clearing completed downloads"
          hint="Shows a confirmation before Clear done removes completed entries from the list. Downloaded files are kept."
          checked={draft.confirmOnRemove}
          onChange={(value) => set('confirmOnRemove', value)}
        />
      </Section>

      <details className="mb-4 rounded-xl border border-line bg-[color:var(--surface)] p-3">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-muted">
          Advanced transfer settings
        </summary>
        <div className="mt-3">
      <Section title="Transfer tuning">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Speed limit" hint="Limit the total download speed. Leave empty for no limit.">
            <input
              value={limitText}
              onChange={(event) => setLimitText(event.target.value)}
              placeholder="unlimited"
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
          <Field label="Downloads at once">
            <input
              type="number"
              min={1}
              max={32}
              value={draft.maxConcurrentDownloads}
              onChange={(event) => set('maxConcurrentDownloads', Number(event.target.value))}
              className={inputClass}
            />
          </Field>
          <Field
            label="Connections per download"
            hint="More connections do not always mean faster downloads; some websites limit them."
          >
            <input
              type="number"
              min={1}
              max={32}
              value={draft.defaultConnections}
              onChange={(event) => set('defaultConnections', Number(event.target.value))}
              className={inputClass}
            />
          </Field>
          <Field label="Download piece size" hint={`${Math.round(draft.chunkSize / 1024 / 1024)} MB per piece`}>
            <select
              value={draft.chunkSize}
              onChange={(event) => set('chunkSize', Number(event.target.value))}
              className={inputClass}
            >
              {[1, 2, 4, 8, 16, 32].map((mb) => (
                <option key={mb} value={mb * 1024 * 1024}>
                  {mb} MB
                </option>
              ))}
            </select>
          </Field>
          <Field label="Retry failed connections">
            <input
              type="number"
              min={0}
              max={50}
              value={draft.maxRetries}
              onChange={(event) => set('maxRetries', Number(event.target.value))}
              className={inputClass}
            />
          </Field>
          <Field label="Log level">
            <select
              value={draft.logLevel}
              onChange={(event) => set('logLevel', event.target.value as AppSettings['logLevel'])}
              className={inputClass}
            >
              {(['error', 'warn', 'info', 'debug', 'trace'] as const).map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-2 rounded-lg border border-line bg-[color:var(--surface-2)] p-2.5 text-[11px] leading-relaxed text-muted">
          <p className="font-semibold text-ink-2">Tuning suggestion</p>
          <p className="mt-0.5">
            Your defaults allow up to {draft.maxConcurrentDownloads * draft.defaultConnections} connections across active downloads.
            {draft.maxConcurrentDownloads * draft.defaultConnections > 64
              ? ' This is a high number of connections; some websites may slow or reject requests.'
              : draft.maxConcurrentDownloads * draft.defaultConnections < 12
                ? ' This uses fewer connections, which can be useful on slower or unstable networks.'
                : ' These settings are balanced for most connections. More connections do not guarantee more speed.'}
            {limitText.trim() ? ' A speed limit is also set.' : ''}
          </p>
        </div>
      </Section>

      <Section title="Troubleshooting">
        <p className="mb-2 text-[11px] leading-relaxed text-muted">
          Check local disk space, queue state, and the loopback integration. Rescan uses Moth's recovery engine to reconcile download records with files; it does not change Windows settings. Pause active downloads first. The report redacts URL query values and credentials, but may include local error paths; review it before sharing.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void window.moth.invoke.openLogsFolder()}
            className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)]"
          >
            Open log folder
          </button>
          <button
            type="button"
            disabled={diagnosing}
            onClick={() => void runDiagnostics()}
            className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] disabled:opacity-50"
          >
            {diagnosing ? 'Checking…' : 'Run health checks'}
          </button>
          <button
            type="button"
            disabled={repairing}
            onClick={() => void repairDownloadState()}
            className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] disabled:opacity-50"
          >
            {repairing ? 'Rescanning…' : 'Rescan & repair files'}
          </button>
          <button
            type="button"
            disabled={savingReport}
            onClick={() => void prepareDiagnosticReport()}
            className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] disabled:opacity-50"
          >
            {savingReport ? 'Preparing report…' : reportPreview ? 'Refresh report preview' : 'Review diagnostic report'}
          </button>
        </div>
        {reportPreview ? (
          <div className="mt-3 rounded-lg border border-line bg-[color:var(--surface-2)] p-3">
            <p className="text-[11px] leading-relaxed text-muted">
              Review this exact report before saving. It contains app/runtime versions, selected performance
              settings, and download totals grouped by status and error category. It excludes download names,
              URLs, local paths, credentials, and logs. Moth does not upload it; saving creates a local file
              that you can choose whether to share.
            </p>
            <textarea
              aria-label="Diagnostic report preview"
              readOnly
              value={reportPreview.preview}
              className="mt-2 h-56 w-full resize-y rounded-lg border border-line bg-[color:var(--surface-1)] p-2 font-mono text-[10px] leading-relaxed text-ink-2"
            />
            <label className="mt-2 flex items-start gap-2 text-[11px] leading-relaxed text-ink-2">
              <input
                type="checkbox"
                checked={reportReviewed}
                onChange={(event) => setReportReviewed(event.currentTarget.checked)}
                className="mt-0.5 accent-[color:var(--color-brand-600)]"
              />
              <span>I reviewed this report and want to save a local copy.</span>
            </label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={savingReport || !reportReviewed}
                onClick={() => void saveDiagnosticReport()}
                className="rounded-lg bg-[color:var(--color-brand-600)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {savingReport ? 'Saving…' : 'Save reviewed report'}
              </button>
              <button
                type="button"
                disabled={savingReport}
                onClick={() => void discardDiagnosticReport()}
                className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-[color:var(--surface-3)] disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          </div>
        ) : null}
        {reportMessage ? (
          <p role="status" className="mt-2 break-all text-[10.5px] leading-relaxed text-[color:var(--color-info)]">
            {reportMessage}
          </p>
        ) : null}
        {repairMessage ? (
          <p role="status" className="mt-2 text-[10.5px] leading-relaxed text-[color:var(--color-info)]">
            {repairMessage}
          </p>
        ) : null}
        {rescanDetails ? (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-line bg-[color:var(--surface-2)] p-2.5">
            <p className="mb-1.5 text-[11px] font-semibold text-ink">Rescan details</p>
            {rescanDetails.length === 0 ? (
              <p className="text-[10.5px] text-muted">No unfinished downloads needed scanning.</p>
            ) : (
              <ul className="space-y-1.5">
                {rescanDetails.slice(0, 50).map((detail) => (
                  <li key={detail.id} className="text-[10.5px] leading-relaxed">
                    <strong className="font-semibold text-ink-2">
                      {detail.action === 'resumable'
                        ? 'Ready to resume'
                        : detail.action === 'repaired'
                          ? 'Repaired'
                          : detail.action === 'replanned'
                            ? 'Rebuilt chunk map'
                            : detail.action === 'reset'
                              ? 'Progress reset'
                              : detail.action === 'orphaned'
                                ? 'Recovered final file'
                                : 'Skipped'}
                    </strong>
                    <span className="ml-1 text-muted">
                      {detail.bytesKept > 0 ? `${formatBytes(detail.bytesKept)} kept. ` : ''}
                      {detail.note}
                    </span>
                  </li>
                ))}
                {rescanDetails.length > 50 ? (
                  <li className="text-[10.5px] text-muted">
                    Showing 50 of {rescanDetails.length} scanned downloads.
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        ) : null}
        {diagnostics ? (
          <div className="mt-2 rounded-lg border border-line bg-[color:var(--surface-2)] p-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-ink">Health report</span>
              <span className="text-[10px] text-muted">{diagnosedAt}</span>
            </div>
            <ul className="space-y-1.5">
              {diagnostics.map((finding) => (
                <li key={finding.title} className="flex gap-2 text-[10.5px] leading-relaxed">
                  <span
                    className={[
                      'mt-1 size-1.5 shrink-0 rounded-full',
                      finding.level === 'ok'
                        ? 'bg-[color:var(--color-ok)]'
                        : finding.level === 'warn'
                          ? 'bg-[color:var(--color-warn)]'
                          : 'bg-[color:var(--color-info)]'
                    ].join(' ')}
                    aria-hidden
                  />
                  <span>
                    <strong className="font-semibold text-ink-2">{finding.title}: </strong>
                    <span className="text-muted">{finding.detail}</span>
                    {finding.action ? (
                      <button
                        type="button"
                        disabled={repairing}
                        onClick={() => void runSuggestedRepair(finding.action!)}
                        className="ml-2 rounded border border-line px-1.5 py-0.5 font-medium text-[color:var(--color-brand-600)] hover:bg-[color:var(--surface-3)] disabled:opacity-50"
                      >
                        {finding.action === 'choose-folder'
                          ? 'Choose folder'
                          : finding.action === 'enable-integration'
                            ? 'Enable integration'
                            : 'Register extension'}
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>
        </div>
      </details>

    </Modal>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  )
}

/**
 * Browser integration panel.
 *
 * Shows the loopback port and the pairing token the extension needs, and
 * explains the honest limitation: browsers expose no native download hook, so
 * automatic interception requires the companion extension.
 */
function TinyButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)]"
    >
      {children}
    </button>
  )
}

export function BrowserIntegrationPanel({
  watchDownloadFolder,
  downloadDirectory
}: {
  watchDownloadFolder: boolean
  downloadDirectory: string
}): React.ReactElement {
  const [info, setInfo] = useState<IngestInfo | null>(null)
  const [watchEnabled, setWatchEnabled] = useState(watchDownloadFolder)
  const [watchBusy, setWatchBusy] = useState(false)
  const [watchMessage, setWatchMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [extStatus, setExtStatus] = useState<ExtensionStatusResult | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installNote, setInstallNote] = useState<string | null>(null)
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupNote, setSetupNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.moth.invoke
      .getIngestInfo()
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch(() => {})
    void window.moth.invoke
      .getExtensionStatus()
      .then((next) => {
        if (!cancelled) setExtStatus(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const installExtension = async (): Promise<void> => {
    setInstalling(true)
    setInstallNote(null)
    try {
      const result = await window.moth.invoke.installExtension({})
      setExtStatus(await window.moth.invoke.getExtensionStatus())
      if (!result.supported) {
        setInstallNote('Automatic install is only available on Windows.')
      } else if (result.results.length === 0) {
        setInstallNote('No Chromium browser was detected on this machine.')
      } else {
        const failed = result.results.filter((entry) => !entry.ok)
        setInstallNote(
          failed.length === 0
            ? 'Local extension package registered. Restart the browser and check its extensions page; registration does not confirm it was loaded or enabled.'
            : `Some browsers failed: ${failed.map((entry) => `${entry.label}: ${entry.error ?? 'unknown error'}`).join('; ')}`
        )
      }
    } catch (err) {
      setInstallNote(describe(err))
    } finally {
      setInstalling(false)
    }
  }

  const prepareExtensionSetup = async (): Promise<void> => {
    setSetupBusy(true)
    setSetupNote(null)
    try {
      const folder = await window.moth.invoke.prepareExtensionSetup()
      setSetupNote(`Guide opened. Keep this folder while the extension is installed: ${folder}`)
    } catch (err) {
      setSetupNote(`Could not prepare the Chrome setup folder: ${describe(err)}`)
    } finally {
      setSetupBusy(false)
    }
  }

  const copy = async (label: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(null), 1600)
    } catch {
      setCopied(null)
    }
  }

  const tokenGroups = info ? (info.token.match(/.{1,8}/g) ?? []).join(' ') : ''

  return (
    <div className="space-y-2.5">
      <Toggle
        label="Enable browser and terminal integration"
        hint="Lets the companion extension pair with Moth automatically and send downloads to the app while it is open."
        checked={info?.enabled ?? false}
        onChange={async (value) => {
          await window.moth.invoke.setSettings({ browserIntegration: value })
          setInfo(await window.moth.invoke.getIngestInfo())
        }}
      />

      {info ? (
        <>
          <div className="rounded-lg border border-line bg-[color:var(--surface-2)] p-2.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-muted">Status</span>
              <span
                className={[
                  'font-semibold',
                  info.running ? 'text-[color:var(--color-ok)]' : 'text-[color:var(--color-bad)]'
                ].join(' ')}
              >
                {info.running ? `listening on 127.0.0.1:${info.port}` : 'not listening'}
              </span>
            </div>

            <div className="mt-1.5 flex items-center justify-between">
              <span className="text-muted">Port</span>
              <button
                type="button"
                onClick={() => void copy('Port', String(info.port))}
                className="font-mono text-ink-2 hover:text-[color:var(--color-brand-600)]"
              >
                {copied === 'Port' ? 'copied' : info.port}
              </button>
            </div>

            <div className="mt-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted">Advanced pairing token</span>
                <button
                  type="button"
                  onClick={() => void copy('Token', info.token)}
                  className="font-mono text-[10px] text-[color:var(--color-brand-600)] hover:underline"
                >
                  {copied === 'Token' ? 'copied' : 'copy'}
                </button>
              </div>
              <p className="selectable mt-0.5 break-all font-mono text-[10px] text-muted">
                {tokenGroups}
              </p>
              <p className="mt-1 text-[10px] text-muted">
                This token can control downloads through the local API. Keep it private; regenerating it revokes existing clients.
              </p>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <TinyButton onClick={() => void window.moth.invoke.openExtensionFolder()}>
                Open extension folder
              </TinyButton>
              <TinyButton
                onClick={async () => {
                  await window.moth.invoke.regenerateToken()
                  setInfo(await window.moth.invoke.getIngestInfo())
                }}
              >
                Regenerate token
              </TinyButton>
            </div>
          </div>

          <ExtensionAutoInstall
            status={extStatus}
            installing={installing}
            note={installNote}
            onInstall={() => void installExtension()}
          />

          <details className="rounded-lg border border-line bg-[color:var(--surface-2)] p-2.5 text-[11px]">
            <summary className="cursor-pointer font-medium text-ink-2">
              Manual setup and troubleshooting
            </summary>
            <div className="mt-2 rounded-md bg-[color:var(--surface-3)] p-2.5">
              <p className="text-muted">
                Create a guided Chrome install folder on your Desktop. Moth opens the illustrated
                walkthrough and highlights the extension folder Chrome needs.
              </p>
              <div className="mt-2">
                <TinyButton onClick={() => void prepareExtensionSetup()}>
                  {setupBusy ? 'Preparing folder…' : 'Prepare guided Chrome setup on Desktop'}
                </TinyButton>
              </div>
              {setupNote ? <p className="mt-2 break-words text-ink-2">{setupNote}</p> : null}
            </div>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted">
              <li>
                Open <code className="font-mono">chrome://extensions</code> (or{' '}
                <code className="font-mono">edge://extensions</code>).
              </li>
              <li>Turn on <strong>Developer mode</strong>.</li>
              <li>
                Click <strong>Load unpacked</strong> and choose the{' '}
                <code className="font-mono">extension</code> folder inside the guided Desktop
                folder (or the <code className="font-mono">chrome</code> folder that just opened).
              </li>
              <li>
                For a manually loaded extension, enter the port and token shown above in its popup and press{' '}
                <strong>Save &amp; test</strong>. Signed extensions installed automatically on Windows pair without this step.
              </li>
            </ol>
            <p className="mt-2 text-muted">
              Firefox: open <code className="font-mono">about:debugging#/runtime/this-firefox</code>,
              choose <strong>Load Temporary Add-on</strong>, and pick the folder's{' '}
              <code className="font-mono">firefox/manifest.json</code>. Automatic install and pairing currently
              support signed Chrome, Edge and Brave extensions on Windows.
            </p>
            <p className="mt-2 text-muted">
              Right-click any link for <strong>Download with Moth</strong>, or switch on automatic
              interception in the extension.
            </p>
          </details>
        </>
      ) : (
        <p className="text-[11px] text-muted">Loading integration status…</p>
      )}

      <ColdStartPanel />

      <Toggle
        label="Watch the download folder for browser downloads"
        hint="Notices in-progress .crdownload/.part files. It cannot recover their URL, so it reports them instead of re-downloading."
        checked={watchEnabled}
        onChange={async (value) => {
          if (watchBusy) return
          setWatchBusy(true)
          setWatchMessage(null)
          try {
            const nextSettings = await window.moth.invoke.setSettings({ watchDownloadFolder: value })
            const nextInfo = await window.moth.invoke.getIngestInfo()
            setInfo(nextInfo)
            setWatchEnabled(nextSettings.watchDownloadFolder)
            if (value && !nextInfo.watchedFolders.includes(downloadDirectory)) {
              setWatchMessage('Moth could not start watching this folder. Check that it is available and try again.')
            } else {
              setWatchMessage(value ? `Watching ${downloadDirectory}` : 'Folder watching is off.')
            }
          } catch (err) {
            setWatchMessage(`Could not update folder watching: ${describe(err)}`)
          } finally {
            setWatchBusy(false)
          }
        }}
      />
      {watchMessage ? (
        <p role="status" className="text-[11px] text-ink-2">{watchMessage}</p>
      ) : watchEnabled && info && !info.watchedFolders.includes(downloadDirectory) ? (
        <p role="status" className="text-[11px] text-[color:var(--color-warn)]">
          Folder watching is enabled in settings, but Moth is not watching {downloadDirectory}.
        </p>
      ) : null}
      {watchBusy ? <p role="status" className="text-[11px] text-muted">Updating folder watch…</p> : null}
    </div>
  )
}

/**
 * Cold-start registration for `moth://download` links.
 *
 * Protocol registration is per-OS, not per-browser: one row covers Chrome,
 * Edge, Firefox and friends. Windows-only, like the extension auto-install —
 * other platforms get the honest note instead of a dead button.
 */
function ColdStartPanel(): React.ReactElement {
  const [status, setStatus] = useState<'loading' | 'registered' | 'missing' | 'unavailable'>('loading')
  const [working, setWorking] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (window.moth.platform !== 'win32') {
      setStatus('unavailable')
      return
    }
    let cancelled = false
    void window.moth.invoke
      .getDeepLinkStatus()
      .then((next) => {
        if (!cancelled) setStatus(next.registered ? 'registered' : 'missing')
      })
      .catch(() => {
        if (!cancelled) setStatus('missing')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const reregister = async (): Promise<void> => {
    setWorking(true)
    setNote(null)
    try {
      const next = await window.moth.invoke.registerDeepLink()
      setStatus(next.registered ? 'registered' : 'missing')
      setNote(
        next.registered
          ? 'Registered. Links from the browser will now open Moth.'
          : 'Registration did not stick. Try running Moth normally (not as administrator) and retry.'
      )
    } catch (err) {
      setNote(describe(err))
    } finally {
      setWorking(false)
    }
  }

  if (status === 'unavailable') {
    return (
      <p className="text-[11px] text-muted">
        Cold-start from the browser (<code className="font-mono">moth://</code> links) is registered
        on Windows. On this system the browser integration needs Moth running.
      </p>
    )
  }

  return (
    <div className="rounded-lg border border-line bg-[color:var(--surface-2)] p-2.5 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-ink-2">Cold-start from browser</span>
        <button
          type="button"
          onClick={() => void reregister()}
          disabled={working || status === 'loading'}
          className="rounded-md bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-on-brand transition-colors hover:bg-brand-700 disabled:opacity-50"
        >
          {working ? 'Registering…' : 'Re-register'}
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-muted">moth://download handler</span>
        <span
          className={[
            'font-semibold',
            status === 'registered' ? 'text-[color:var(--color-ok)]' : 'text-[color:var(--color-bad)]'
          ].join(' ')}
        >
          {status === 'loading' ? 'checking…' : status === 'registered' ? 'registered' : 'not registered'}
        </span>
      </div>
      <p className="mt-1.5 text-muted">
        With this registered, Download with Moth launches the app and queues the download even
        when Moth is closed. Video and audio links are distinguished by the link itself.
      </p>
      {note ? <p className="mt-1 font-medium text-ink-2">{note}</p> : null}
    </div>
  )
}

/**
 * One-click registry install for Chromium browsers (Windows only).
 *
 * Shows the installed version per detected browser and the restart hint after
 * automatic registration — browsers still require users to approve the extension.
 */
function ExtensionAutoInstall({
  status,
  installing,
  note,
  onInstall
}: {
  status: ExtensionStatusResult | null
  installing: boolean
  note: string | null
  onInstall: () => void
}): React.ReactElement {
  if (window.moth.platform !== 'win32') {
    return (
      <p className="text-[11px] text-muted">
        Automatic registration is available on Windows. On this system, load the extension folder
        manually as described below, then open its popup while Moth is running to pair automatically.
      </p>
    )
  }
  if (!status) {
    return <p className="text-[11px] text-muted">Checking extension install status…</p>
  }
  if (!status.packaged) {
    return (
      <p className="text-[11px] text-muted">
        The packed extension did not ship with this build, so automatic install is unavailable.
        Use the manual steps below.
      </p>
    )
  }
  return (
    <div className="rounded-lg border border-line bg-[color:var(--surface-2)] p-2.5 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-ink-2">Extension auto-install</span>
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          className="rounded-md bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-on-brand transition-colors hover:bg-brand-700 disabled:opacity-50"
        >
          {installing ? 'Registering…' : 'Register extension now'}
        </button>
      </div>
      <ul className="mt-1.5 space-y-0.5 text-muted">
        {status.browsers.map((entry) => (
          <li key={entry.browser} className="flex items-center justify-between gap-2">
            <span>{entry.label}</span>
            <span className="font-medium">
              {!entry.detected
                ? 'not detected'
                : entry.registered && entry.currentVersion === entry.registeredVersion
                  ? `registered (${entry.registeredVersion})`
                  : entry.registeredVersion !== null &&
                      entry.currentVersion !== entry.registeredVersion
                    ? `registered ${entry.registeredVersion} — app ships ${entry.currentVersion ?? 'unknown version'}`
                    : entry.registeredVersion !== null
                      ? 'registered path differs — re-register'
                      : 'not registered'}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-muted">
        Moth can register the local extension package on Windows, but this does not guarantee that
        Chromium accepts or enables it. Restart the browser and check its extensions page. Local
        CRX installs may be blocked; Moth does not change browser policies or bypass browser
        approval. A Chrome Web Store listing or an administrator-managed browser policy is needed
        for a no-Developer-Mode installation.
      </p>
      {note ? <p className="mt-1 font-medium text-ink-2">{note}</p> : null}
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.ReactElement {
  return (
    <label className="mb-2.5 flex cursor-pointer items-start gap-2.5 last:mb-0">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          'mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-brand-600' : 'bg-[color:var(--line-strong)]'
        ].join(' ')}
      >
        <span
          className={[
            'block size-4 rounded-full bg-[#e6f4fe] shadow transition-transform',
            checked ? 'translate-x-4.5' : 'translate-x-0.5'
          ].join(' ')}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-ink-2">{label}</span>
        {hint ? <span className="block text-[11px] text-muted">{hint}</span> : null}
      </span>
    </label>
  )
}
