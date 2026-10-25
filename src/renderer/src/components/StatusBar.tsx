/**
 * Bottom live bar.
 *
 * The mockup-direction readout: total speed, active connections, free disk.
 * Aggregate counts stay here too (sole owner), with session totals kept
 * compact on the right.
 */

import type { EngineStats } from '@shared/types.js'
import { formatBytes, formatDuration, formatRate } from '../lib/format.js'
import type { Toast } from '../hooks/useMothStore.js'
import { IconAlert, IconCheck, IconClock } from './Icons.js'

interface StatusProps {
  stats: EngineStats | null
  version: string
  activeConnections: number
  /** Free bytes on the download volume, or `null` when unknown. */
  freeBytes: number | null
  onOpenLogs: () => void
}

export function StatusBar({ stats, version, activeConnections, freeBytes, onOpenLogs }: StatusProps): React.ReactElement {
  const active = stats?.activeDownloads ?? 0
  const queued = stats?.queuedDownloads ?? 0
  const completed = stats?.completedDownloads ?? 0
  const failed = stats?.failedDownloads ?? 0

  return (
    <footer className="flex h-9 shrink-0 items-center gap-2.5 border-t border-line bg-[color:var(--surface-2)] px-3 text-[11px] text-muted sm:gap-3">
      {stats?.globalSpeedLimit ? (
        <span className="font-mono tabular-nums text-[color:var(--color-info)]">
          cap {formatRate(stats.globalSpeedLimit)}
        </span>
      ) : null}
      {stats?.globalSpeedLimit ? <Divider /> : null}
      <Stat label="connections" value={activeConnections} />
      <Stat label="active" value={active} />
      <Stat label="queued" value={queued} />
      <Stat label="completed" value={completed} tone="ok" />
      {failed > 0 ? <Stat label="failed" value={failed} tone="bad" /> : null}

      <Divider />
      <span className="font-mono tabular-nums" title="Free space on the download volume">
        {freeBytes === null ? 'disk —' : `${formatBytes(freeBytes, 0)} free`}
      </span>
      <span className="hidden font-mono tabular-nums md:inline">
        {formatBytes(stats?.sessionBytes ?? 0)} this session
      </span>

      <div className="ml-auto flex items-center gap-3">
        {stats ? (
          <span className="hidden font-mono tabular-nums sm:inline" title="Engine uptime">
            up {formatDuration(Math.floor(stats.uptimeMs / 1000))}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onOpenLogs}
          className="rounded px-1.5 py-0.5 font-mono transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink"
          title="Open the log folder"
        >
          v{version}
        </button>
      </div>
    </footer>
  )
}

function Divider(): React.ReactElement {
  return <span className="h-3 w-px bg-[color:var(--line)]" aria-hidden />
}

function Stat({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone?: 'ok' | 'bad'
}): React.ReactElement {
  const colour =
    tone === 'ok'
      ? 'text-[color:var(--color-ok)]'
      : tone === 'bad'
        ? 'text-[color:var(--color-bad)]'
        : 'text-ink-2'
  return (
    <span>
      <span className={`font-mono tabular-nums ${colour}`}>{value}</span>{' '}
      <span>{label}</span>
    </span>
  )
}

export function Toasts({
  toasts,
  onDismiss
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}): React.ReactElement {
  return (
    <div className="pointer-events-none fixed bottom-11 right-3 z-40 flex w-80 flex-col gap-1.5">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="animate-slide-down pointer-events-auto flex items-start gap-2 rounded-lg border border-line bg-[color:var(--surface-2)] p-2.5 text-left shadow-lg"
          style={{ borderLeftWidth: 3, borderLeftColor: 'var(--tone-fg)' }}
          data-status={toast.kind === 'error' ? 'failed' : toast.kind === 'success' ? 'completed' : 'queued'}
        >
          <span className="mt-0.5 shrink-0 text-[color:var(--tone-fg)]">
            {toast.kind === 'error' ? (
              <IconAlert size={13} />
            ) : toast.kind === 'success' ? (
              <IconCheck size={13} />
            ) : (
              <IconClock size={13} />
            )}
          </span>
          <span className="selectable min-w-0 flex-1 text-[11.5px] text-ink-2">{toast.message}</span>
        </button>
      ))}
    </div>
  )
}
