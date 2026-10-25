import { useState } from 'react'
import type { DownloadSnapshot } from '@shared/types.js'
import { Field, inputClass, Modal } from './Modal.js'

interface Props {
  download: DownloadSnapshot
  onClose: () => void
  onSubmit: (id: string, url: string) => Promise<void>
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = error.message
    if (typeof message === 'string') return message
  }
  return String(error)
}

export function RefreshLinkDialog({ download, onClose, onSubmit }: Props): React.ReactElement {
  const [url, setUrl] = useState(download.url)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(download.id, url.trim())
      onClose()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Replace download link"
      subtitle={download.filename}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !url.trim()}
            className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-on-brand transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Checking link…' : 'Refresh and retry'}
          </button>
        </>
      }
    >
      <Field label="New file link" hint="Paste a fresh direct-download URL from the site or browser.">
        <input
          autoFocus
          type="url"
          spellCheck={false}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className={`${inputClass} font-mono text-xs`}
          placeholder="https://example.com/file.zip?token=…"
        />
      </Field>

      <p className="rounded-lg border border-line bg-[color:var(--surface-2)] px-3 py-2.5 text-xs leading-relaxed text-ink-2">
        Moth keeps downloaded bytes only if the server reports the same file size
        and identical strong ETag and supports ranges. An ETag is the server’s
        validator, not a cryptographic checksum. Otherwise, Moth deletes the
        partial file and starts over.
      </p>

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-[color:var(--color-bad)]/10 px-3 py-2 text-xs text-ink">
          {error}
        </p>
      ) : null}
    </Modal>
  )
}
