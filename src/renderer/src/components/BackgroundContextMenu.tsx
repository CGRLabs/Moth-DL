import { useCallback, useEffect, useRef, useState } from 'react'

interface Position {
  x: number
  y: number
}

interface Action {
  label: string
  onClick: () => void
  disabled?: boolean
  separatorBefore?: boolean
}

interface Props {
  position: Position | null
  actions: Action[]
  onClose: () => void
}

export function useBackgroundContextMenu(): {
  position: Position | null
  onContextMenu: React.MouseEventHandler<HTMLElement>
  close: () => void
} {
  const [position, setPosition] = useState<Position | null>(null)
  const onContextMenu = useCallback<React.MouseEventHandler<HTMLElement>>((event) => {
    if (event.defaultPrevented) return
    const target = event.target
    if (target instanceof Element && target.closest('button, input, textarea, select, a, [role="button"]')) return
    event.preventDefault()
    setPosition({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 232)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 240))
    })
  }, [])
  const close = useCallback(() => setPosition(null), [])
  return { position, onContextMenu, close }
}

export function BackgroundContextMenu({ position, actions, onClose }: Props): React.ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!position) return
    const closeOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) onClose()
    }
    const closeEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [position, onClose])

  if (!position) return null
  return (
    <div
      ref={menuRef}
      role="group"
      aria-label="Background actions"
      className="fixed z-50 w-56 rounded-lg border border-line-strong bg-[color:var(--surface-2)] p-1 shadow-xl"
      style={{ left: position.x, top: position.y }}
    >
      {actions.map((action) => (
        <div key={action.label}>
          {action.separatorBefore ? <div className="my-1 border-t border-line" /> : null}
          <button
            type="button"
            disabled={action.disabled}
            onClick={() => {
              onClose()
              action.onClick()
            }}
            className="block w-full rounded-md px-2.5 py-1.5 text-left text-[11.5px] text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
          >
            {action.label}
          </button>
        </div>
      ))}
    </div>
  )
}
