/** Modal shell: backdrop, focus trap, Escape to close. */

import { useEffect, useRef } from 'react'
import { IconClose } from './Icons.js'

interface Props {
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}

export function Modal({ title, subtitle, onClose, children, footer, wide = false }: Props): React.ReactElement {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      // Trap focus so Tab cannot walk into the inert page behind the modal.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables || focusables.length === 0) return
      const first = focusables[0] as HTMLElement
      const last = focusables[focusables.length - 1] as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    // Move focus into the dialog so the trap starts from a sane place.
    panelRef.current?.querySelector<HTMLElement>('input, button')?.focus()
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--surface)]/80 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={[
          'animate-fade-in flex max-h-[86vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-[color:var(--surface-2)] shadow-2xl transition-[max-width] duration-200 ease-out',
          wide ? 'max-w-2xl' : 'max-w-md'
        ].join(' ')}
      >
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink"
          >
            <IconClose size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label className="mb-3 block last:mb-0">
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  )
}

export const inputClass =
  'w-full rounded-lg border border-line bg-[color:var(--surface)] px-2.5 py-1.5 text-sm text-ink placeholder:text-muted focus:border-[color:var(--color-brand-500)] focus:outline-none'
