/**
 * Left sidebar with always-visible queue actions, Settings, and disk usage.
 */

import type { DiskUsage } from '@shared/ipc.js'
import type { DownloadCategory } from '@shared/types.js'
import { formatBytes } from '../lib/format.js'
import {
  CATEGORY_ICON,
  IconBrowser,
  IconClock,
  IconFolder,
  IconPause,
  IconPlay,
  IconQueue,
  IconRefresh,
  IconSettings,
  IconTrash
} from './Icons.js'
import { LogoThumb } from './LogoThumb.js'

export type SidebarView = 'queue' | 'files' | 'browser' | 'plans'
export type FileCategoryFilter = DownloadCategory | 'all'

interface Props {
  view: SidebarView
  categoryFilter: FileCategoryFilter
  categoryCounts: Partial<Record<DownloadCategory, number>>
  queueCount: number
  completedCount: number
  onSelectView: (view: SidebarView) => void
  onSelectCategory: (category: FileCategoryFilter) => void
  onPauseAll: () => void
  onResumeAll: () => void
  onClearCompleted: () => void
  onRescan: () => void
  onOpenSettings: () => void
  disk: DiskUsage | null | undefined
}

export function Sidebar(props: Props): React.ReactElement {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-[color:var(--surface-2)]">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
        <LogoThumb size={30} />
        <p className="whitespace-nowrap text-[12.5px] font-bold leading-tight text-ink">
          Moth Download Manager
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <Section label="Workspace">
          <NavAction
            active={props.view === 'queue'}
            label="Queue"
            count={props.queueCount}
            onClick={() => props.onSelectView('queue')}
          >
            <IconQueue size={15} />
          </NavAction>
          <NavAction
            active={props.view === 'plans'}
            label="Download plans"
            onClick={() => props.onSelectView('plans')}
          >
            <IconClock size={15} />
          </NavAction>
          <NavAction
            active={props.view === 'files' && props.categoryFilter === 'all'}
            label="Files"
            count={props.completedCount}
            onClick={() => props.onSelectCategory('all')}
          >
            <IconFolder size={15} />
          </NavAction>
          <div className="ml-3 border-l border-line pl-2">
            {([
              ['audio', 'Music'],
              ['video', 'Video'],
              ['image', 'Images'],
              ['document', 'Documents'],
              ['archive', 'Archives'],
              ['executable', 'Executables'],
              ['installer', 'Installers'],
              ['other', 'Other']
            ] as const).map(([category, label]) => {
              const CategoryIcon = CATEGORY_ICON[category]
              return (
                <NavAction
                  key={category}
                  active={props.view === 'files' && props.categoryFilter === category}
                  label={label}
                  count={props.categoryCounts[category] ?? 0}
                  onClick={() => props.onSelectCategory(category)}
                  compact
                >
                  <CategoryIcon size={13} />
                </NavAction>
              )
            })}
          </div>
        </Section>

        <Section label="Connect">
          <NavAction
            active={props.view === 'browser'}
            label="Browser Integration"
            onClick={() => props.onSelectView('browser')}
          >
            <IconBrowser size={15} />
          </NavAction>
        </Section>

        <Section label="Queue actions">
          <div className="mt-1 grid grid-cols-2 gap-1">
            <ToolAction label="Pause all downloads" onClick={props.onPauseAll}>
              <IconPause size={12} />
              Pause all
            </ToolAction>
            <ToolAction label="Resume all downloads" onClick={props.onResumeAll}>
              <IconPlay size={12} />
              Resume all
            </ToolAction>
            <ToolAction label="Re-check partial files on disk" onClick={props.onRescan}>
              <IconRefresh size={12} />
              Check files
            </ToolAction>
            <ToolAction
              label="Clear completed downloads"
              onClick={props.onClearCompleted}
              disabled={props.completedCount === 0}
            >
              <IconTrash size={12} />
              Clear done
            </ToolAction>
          </div>
        </Section>

        <Section label="Preferences">
          <button
            type="button"
            onClick={props.onOpenSettings}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink"
          >
            <IconSettings size={14} />
            Settings
          </button>
        </Section>
      </div>

      <DiskFooter disk={props.disk} />
    </aside>
  )
}

function NavAction({
  children,
  active,
  label,
  count,
  onClick,
  compact = false
}: {
  children: React.ReactNode
  active: boolean
  label: string
  count?: number
  onClick: () => void
  compact?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex w-full items-center gap-2 rounded-lg text-left transition-colors',
        compact ? 'px-2 py-1.5 text-[11.5px]' : 'px-2 py-2 text-[12.5px]',
        active
          ? 'bg-[color:var(--surface-3)] font-semibold text-ink'
          : 'font-medium text-muted hover:bg-[color:var(--surface-3)] hover:text-ink'
      ].join(' ')}
    >
      <span className="shrink-0">{children}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="font-mono text-[10.5px] tabular-nums text-muted">{count}</span>
      ) : null}
    </button>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 px-2">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">{label}</h2>
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

function ToolAction({
  children,
  label,
  onClick,
  disabled = false
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[11px] text-muted transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  )
}

/** Disk-usage footer: used/total plus a thin fill bar. */
function DiskFooter({ disk }: { disk: DiskUsage | null | undefined }): React.ReactElement {
  if (disk === undefined) {
    return (
      <div className="shrink-0 border-t border-line px-3 py-2.5">
        <p className="font-mono text-[11.5px] tabular-nums text-muted">Reading disk…</p>
      </div>
    )
  }
  if (disk === null) {
    return (
      <div className="shrink-0 border-t border-line px-3 py-2.5">
        <p className="font-mono text-[11.5px] tabular-nums text-muted">Disk unavailable</p>
      </div>
    )
  }
  const used = Math.max(0, disk.totalBytes - disk.freeBytes)
  const fraction = disk.totalBytes > 0 ? used / disk.totalBytes : 0
  const percent = Math.round(fraction * 100)
  return (
    <div className="shrink-0 border-t border-line px-3 py-2.5">
      <p className="font-mono text-[11.5px] tabular-nums text-muted">
        <span className="font-semibold text-ink-2">{percent}% used</span>
        <span>
          {' '}
          · {formatBytes(used, 0)} / {formatBytes(disk.totalBytes, 0)}
        </span>
      </p>
      <div
        className="bar mt-1.5"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Disk usage"
      >
        <div className="bar-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
