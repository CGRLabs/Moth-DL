import { useEffect, useRef, useState } from 'react'
import type { DownloadSnapshot } from '@shared/types.js'
import { Modal } from './Modal.js'

interface Props {
  download: DownloadSnapshot
  onClose: () => void
}

/**
 * Shows the full source URL. The queue row deliberately shows transfer progress
 * instead, so this and the context menu's copy/replace actions are where the raw
 * URL lives.
 */
export function SourceLinkDialog({ download, onClose }: Props): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  const copy = (): void => {
    void navigator.clipboard.writeText(download.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <Modal
      title="Source link"
      subtitle={download.filename}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)]"
          >
            Close
          </button>
          <button
            type="button"
            onClick={copy}
            className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-on-brand transition-colors hover:bg-brand-700"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </>
      }
    >
      <input
        ref={inputRef}
        readOnly
        value={download.url}
        spellCheck={false}
        aria-label="Source URL"
        onFocus={(event) => event.currentTarget.select()}
        className="w-full rounded-lg border border-line bg-[color:var(--surface-2)] px-2.5 py-1.5 font-mono text-xs text-ink select-all"
      />
      <p className="mt-2 text-xs text-muted">
        The queue shows transfer progress in place of this link. Right-click the row to copy or replace it.
      </p>
    </Modal>
  )
}