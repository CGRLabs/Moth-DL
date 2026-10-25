import { useEffect, useMemo, useState } from 'react'
import type { Download, QueuePlan } from '@shared/types.js'
import { formatBytes } from '../lib/format.js'
import { IconClock, IconClose, IconPlay, IconPlus, IconTrash } from './Icons.js'

interface Props {
  downloads: Download[]
  notify: (kind: 'success' | 'error' | 'info', message: string) => void
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function statusLabel(plan: QueuePlan): string {
  if (plan.status === 'running') return 'Running'
  if (plan.status === 'scheduled') return 'Scheduled'
  if (plan.status === 'canceled') return 'Canceled'
  return 'Completed'
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (remainingMinutes === 0) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  if (hours === 0) return `${remainingMinutes} min`
  return `${hours}h ${remainingMinutes}m`
}

export function QueuePlansView({ downloads, notify }: Props): React.ReactElement {
  const eligible = useMemo(
    () => downloads.filter((download) => download.status === 'queued' || download.status === 'paused'),
    [downloads]
  )
  const [plans, setPlans] = useState<QueuePlan[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [name, setName] = useState('')
  const [startsAt, setStartsAt] = useState(() => localDateTimeValue(new Date(Date.now() + 5 * 60_000)))
  const [durationChoice, setDurationChoice] = useState<'120' | '240' | '480' | '720' | 'custom'>('480')
  const [customHours, setCustomHours] = useState(8)
  const [strategy, setStrategy] = useState<'queue-order' | 'smallest-first'>('queue-order')
  const [endAction, setEndAction] = useState<'pause' | 'continue'>('pause')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const durationMinutes = durationChoice === 'custom' ? Math.round(customHours * 60) : Number(durationChoice)
  const reservedBy = useMemo(() => {
    const reservations = new Map<string, QueuePlan>()
    for (const plan of plans) {
      if (plan.status !== 'scheduled' && plan.status !== 'running') continue
      for (const id of plan.downloadIds) reservations.set(id, plan)
    }
    return reservations
  }, [plans])

  useEffect(() => {
    let live = true
    const refresh = (): void => {
      void window.moth.invoke.listQueuePlans()
        .then((next) => {
          if (live) setPlans(next)
        })
        .catch((error: unknown) => {
          if (live) notify('error', `Could not load queue plans: ${messageOf(error)}`)
        })
        .finally(() => {
          if (live) setLoading(false)
        })
    }
    refresh()
    const unsubscribe = window.moth.on.queuePlansChanged((next) => setPlans(next))
    return () => {
      live = false
      unsubscribe()
    }
  }, [notify])

  const toggleDownload = (id: string): void => {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((selected) => selected !== id)
      : [...current, id])
  }

  const createPlan = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const startMillis = new Date(startsAt).getTime()
    if (!Number.isFinite(startMillis)) {
      notify('error', 'Choose a valid plan start time.')
      return
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 43_200) {
      notify('error', 'Choose a duration between 15 minutes and 30 days.')
      return
    }
    setSaving(true)
    try {
      const next = await window.moth.invoke.createQueuePlan({
        name: name.trim() || 'Overnight downloads',
        downloadIds: selectedIds,
        startsAt: startMillis,
        durationMinutes,
        strategy,
        endAction
      })
      setPlans(next)
      setName('')
      setSelectedIds([])
      notify('success', 'Queue plan created.')
    } catch (error) {
      notify('error', `Could not create queue plan: ${messageOf(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const cancelPlan = async (id: string): Promise<void> => {
    try {
      setPlans(await window.moth.invoke.cancelQueuePlan({ id }))
      notify('info', 'Plan canceled. Its downloads are back in the normal queue.')
    } catch (error) {
      notify('error', `Could not cancel plan: ${messageOf(error)}`)
    }
  }

  const removePlan = async (id: string): Promise<void> => {
    try {
      setPlans(await window.moth.invoke.removeQueuePlan({ id }))
    } catch (error) {
      notify('error', `Could not remove plan: ${messageOf(error)}`)
    }
  }

  return (
    <section className="mx-auto max-w-[1000px] px-5 py-6 sm:px-8">
      <header className="mb-5 border-b border-line pb-4">
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">Queue scheduling</p>
        <h1 className="mt-1 text-lg font-semibold text-ink">Download plans</h1>
        <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-muted">
          Schedule a group of downloads to run later. Choose the order and whether unfinished files
          should pause when time is up.
        </p>
      </header>

      <form onSubmit={(event) => void createPlan(event)} className="space-y-3">
        <section className="rounded-xl border border-line bg-[color:var(--surface-2)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-[color:var(--surface-3)] text-[10px] font-bold text-ink-2">1</span>
            <div>
              <h2 className="text-[13px] font-semibold text-ink">When should it run?</h2>
              <p className="text-[10px] text-muted">Moth must be running at the scheduled time.</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] font-medium text-ink-2">
              Start time
              <input
                type="datetime-local"
                required
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
                className="mt-1.5 w-full rounded-md border border-line bg-[color:var(--surface)] px-2.5 py-2 text-[12px] text-ink"
              />
            </label>
            <fieldset>
              <legend className="mb-1.5 text-[11px] font-medium text-ink-2">How long should it run?</legend>
              <div className="flex flex-wrap gap-1.5">
                {([
                  ['120', '2 hours'],
                  ['240', '4 hours'],
                  ['480', '8 hours'],
                  ['720', '12 hours'],
                  ['custom', 'Custom']
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={durationChoice === value}
                    onClick={() => setDurationChoice(value)}
                    className={`rounded-md border px-2.5 py-1.5 text-[10px] font-medium transition-colors ${
                      durationChoice === value
                        ? 'border-[color:var(--color-brand-500)] bg-[color:var(--surface-3)] text-ink'
                        : 'border-line text-muted hover:bg-[color:var(--surface-3)] hover:text-ink'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {durationChoice === 'custom' ? (
                <label className="mt-2 flex items-center gap-2 text-[10px] text-muted">
                  Custom length
                  <input
                    type="number"
                    min={0.25}
                    max={720}
                    step={0.25}
                    required
                    value={customHours}
                    onChange={(event) => setCustomHours(Number(event.target.value))}
                    className="w-24 rounded-md border border-line bg-[color:var(--surface)] px-2 py-1.5 text-[11px] text-ink"
                  />
                  hours
                </label>
              ) : null}
            </fieldset>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-[color:var(--surface-2)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-[color:var(--surface-3)] text-[10px] font-bold text-ink-2">2</span>
            <div>
              <h2 className="text-[13px] font-semibold text-ink">Choose what happens</h2>
              <p className="text-[10px] text-muted">These rules only apply to downloads selected below.</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] font-medium text-ink-2">
              Download order
              <select
                value={strategy}
                onChange={(event) => setStrategy(event.target.value as typeof strategy)}
                className="mt-1.5 w-full rounded-md border border-line bg-[color:var(--surface)] px-2.5 py-2 text-[11px] text-ink"
              >
                <option value="queue-order">Use my queue priority</option>
                <option value="smallest-first">Smallest files first</option>
              </select>
            </label>
            <label className="text-[11px] font-medium text-ink-2">
              At the end of the time window
              <select
                value={endAction}
                onChange={(event) => setEndAction(event.target.value as typeof endAction)}
                className="mt-1.5 w-full rounded-md border border-line bg-[color:var(--surface)] px-2.5 py-2 text-[11px] text-ink"
              >
                <option value="pause">Pause unfinished downloads</option>
                <option value="continue">Let unfinished downloads continue</option>
              </select>
            </label>
          </div>
          <label className="mt-3 block max-w-md text-[11px] font-medium text-ink-2">
            Plan name <span className="font-normal text-muted">(optional)</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="Overnight downloads"
              className="mt-1.5 w-full rounded-md border border-line bg-[color:var(--surface)] px-2.5 py-2 text-[11px] text-ink"
            />
          </label>
        </section>

        <section className="rounded-xl border border-line bg-[color:var(--surface-2)] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-full bg-[color:var(--surface-3)] text-[10px] font-bold text-ink-2">3</span>
              <div>
                <h2 className="text-[13px] font-semibold text-ink">Select downloads</h2>
                <p className="text-[10px] text-muted">Choose queued or paused items to include.</p>
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-[color:var(--surface-3)] px-2.5 py-1 text-[10px] font-semibold text-ink-2">
              {selectedIds.length} selected
            </span>
          </div>
          {eligible.length > 0 ? (
            <div className="max-h-52 overflow-y-auto rounded-lg border border-line">
              {eligible.map((download) => {
                const reservation = reservedBy.get(download.id)
                const isReserved = reservation !== undefined
                return (
                  <label
                    key={download.id}
                    className={`flex items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0 ${
                      isReserved ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-[color:var(--surface-3)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(download.id)}
                      disabled={isReserved}
                      onChange={() => toggleDownload(download.id)}
                      className="accent-[color:var(--brand-base)]"
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{download.filename}</span>
                    <span className="shrink-0 text-[10px] text-muted">
                      {download.fileSize > 0 ? formatBytes(download.fileSize) : 'Size unknown'}
                    </span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${isReserved ? 'bg-[color:var(--color-info-soft)] text-[color:var(--color-info)]' : 'bg-[color:var(--surface-3)] text-muted'}`}>
                      {isReserved ? `In “${reservation.name}”` : download.status}
                    </span>
                  </label>
                )
              })}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-muted">
              There are no queued or paused downloads to schedule.
            </p>
          )}
          {eligible.some((download) => reservedBy.has(download.id)) ? (
            <p className="mt-2 text-[10px] text-muted">
              Items already in a scheduled or running plan are unavailable until that plan is canceled or finished.
            </p>
          ) : null}
        </section>

        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--color-brand-500)]/30 bg-[color:var(--surface-2)] p-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Plan summary</p>
            <p className="mt-1 text-[11px] font-medium text-ink">
              {selectedIds.length === 0
                ? 'Select at least one download to continue.'
                : `${selectedIds.length} download${selectedIds.length === 1 ? '' : 's'} · ${formatDuration(durationMinutes)} · ${strategy === 'smallest-first' ? 'smallest first' : 'your queue order'}`}
            </p>
            <p className="mt-0.5 text-[10px] text-muted">
              {Number.isFinite(new Date(startsAt).getTime()) ? new Date(startsAt).toLocaleString() : 'Choose a start time'}
              {selectedIds.length > 0 ? ` · ${endAction === 'pause' ? 'pause unfinished at end' : 'continue unfinished normally'}` : ''}
            </p>
            <p className="mt-1 text-[10px] text-muted">Plans set queue order, not bandwidth. Existing speed limits still apply.</p>
          </div>
          <button
            type="submit"
            disabled={saving || selectedIds.length === 0 || (durationChoice === 'custom' && (!Number.isFinite(customHours) || customHours < 0.25 || customHours > 720))}
            className="btn-primary inline-flex shrink-0 items-center gap-1.5 rounded-md px-3.5 py-2 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconPlus size={13} />
            {saving ? 'Creating…' : 'Create plan'}
          </button>
        </section>
      </form>

      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">Your plans</h2>
        {loading ? (
          <p className="py-5 text-center text-[11px] text-muted">Loading plans…</p>
        ) : plans.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[11px] text-muted">
            No plans yet. Create one to schedule a group of downloads.
          </p>
        ) : (
          <div className="space-y-2">
            {plans.map((plan) => (
              <article key={plan.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-[color:var(--surface-2)] p-3">
                <IconClock size={16} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-[12px] font-semibold text-ink">{plan.name}</h3>
                    <span className="rounded-full bg-[color:var(--surface-3)] px-2 py-0.5 text-[9px] font-semibold text-muted">
                      {statusLabel(plan)}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-muted">
                    {new Date(plan.startsAt).toLocaleString()} · {formatDuration(plan.durationMinutes)} · {plan.downloadIds.length} downloads
                  </p>
                  <p className="text-[10px] text-muted">
                    {plan.strategy === 'smallest-first' ? 'Smallest files first' : 'Existing queue priority'} ·{' '}
                    {plan.endAction === 'pause' ? 'pause unfinished at end' : 'continue unfinished normally'}
                  </p>
                </div>
                {plan.status === 'scheduled' || plan.status === 'running' ? (
                  <button type="button" onClick={() => void cancelPlan(plan.id)} aria-label="Cancel plan" title="Cancel plan" className="rounded-md p-2 text-muted hover:bg-[color:var(--surface-3)] hover:text-ink">
                    <IconClose size={14} />
                  </button>
                ) : (
                  <button type="button" onClick={() => void removePlan(plan.id)} aria-label="Remove plan" title="Remove plan" className="rounded-md p-2 text-muted hover:bg-[color:var(--surface-3)] hover:text-ink">
                    <IconTrash size={14} />
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-[10px] text-muted">
        <IconPlay size={11} /> Plans run inside Moth and survive app restarts.
      </p>
    </section>
  )
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}
