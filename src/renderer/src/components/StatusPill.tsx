/**
 * Status pill.
 *
 * The previous implementation coloured the status text but gave it the same
 * weight as the filename, so a list of thirty rows could not be scanned for what
 * needed attention. A tinted pill with a leading dot makes status a shape
 * difference as well as a colour difference, which survives greyscale and is
 * far more legible at a glance.
 */

import { STATUS_SHORT } from '../lib/format.js'

interface Props {
  status: string
  /** Overrides the short label, e.g. showing the throttling reason. */
  label?: string
  showDot?: boolean
  /** Animated pulse while a transfer is actually moving bytes. */
  live?: boolean
}

export function StatusPill({ status, label, showDot = true, live = false }: Props): React.ReactElement {
  const text = label ?? STATUS_SHORT[status] ?? status
  return (
    <span data-status={status} className="tone-pill">
      {showDot ? (
        <span
          className={`tone-dot${live ? ' animate-pulse-soft' : ''}`}
          aria-hidden
        />
      ) : null}
      {text}
    </span>
  )
}
