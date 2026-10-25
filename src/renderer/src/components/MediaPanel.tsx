/**
 * Metadata panel for a download.
 *
 * Shows the resolved title, artist, album and so on, and lets the user correct
 * anything the automatic extraction got wrong. The user is the final authority on
 * metadata, so every field is editable inline and a manual edit outranks every
 * automatic source.
 */

import { useState } from 'react'
import type { MediaMetadataView } from '@shared/media.js'
import { IconCheck, IconPencil } from './Icons.js'

interface Props {
  metadata: MediaMetadataView
  onSave: (patch: Record<string, string | number | null>) => Promise<void>
  onWriteTags: () => Promise<{ written: boolean; reason?: string }>
}

export function MediaPanel({ metadata, onSave, onWriteTags }: Props): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const save = async (field: string, value: string | number | null): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      await onSave({ [field]: value })
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const writeTags = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await onWriteTags()
      setMessage(result.written ? 'Tags written to the file' : result.reason ?? 'Nothing was written')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">
          Metadata
        </span>
        <span className="text-[10.5px] text-muted">
          from {metadata.source}
          {metadata.writtenAt ? ' · written to file' : ''}
        </span>
      </div>

      <div className="flex gap-3">
        {metadata.artworkUrl ? (
          <img
            src={metadata.artworkUrl}
            alt=""
            width={72}
            height={72}
            loading="lazy"
            decoding="async"
            className="size-[72px] shrink-0 rounded-lg object-cover"
            style={{ background: 'var(--surface-3)' }}
          />
        ) : null}

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-1.5">
          <MediaField
            label="Title"
            value={metadata.title}
            busy={busy}
            onSave={(value) => void save('title', value)}
          />
          <MediaField
            label="Artist"
            value={metadata.artist}
            busy={busy}
            onSave={(value) => void save('artist', value)}
          />
          <MediaField
            label="Album"
            value={metadata.album}
            busy={busy}
            onSave={(value) => void save('album', value)}
          />
          <MediaField
            label="Album artist"
            value={metadata.albumArtist}
            busy={busy}
            onSave={(value) => void save('albumArtist', value)}
          />
          <MediaField
            label="Track"
            value={metadata.track === null ? null : String(metadata.track)}
            busy={busy}
            onSave={(value) => void save('track', value === null || value === '' ? null : Number(value))}
          />
          <MediaField
            label="Year"
            value={metadata.year === null ? null : String(metadata.year)}
            busy={busy}
            onSave={(value) => void save('year', value === null || value === '' ? null : Number(value))}
          />
          <MediaField
            label="Genre"
            value={metadata.genre}
            busy={busy}
            onSave={(value) => void save('genre', value)}
          />
          <MediaField
            label="Format"
            value={metadata.format === 'unknown' ? null : metadata.format.toUpperCase()}
            busy={busy}
            readOnly
          />
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void writeTags()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-2)] disabled:opacity-50"
        >
          <IconCheck size={11} />
          Write tags to file
        </button>
        {message ? <span className="text-[10.5px] text-muted">{message}</span> : null}
      </div>
    </div>
  )
}

/**
 * One editable metadata field.
 *
 * Displays the value as text; clicking turns it into an input. Enter commits,
 * Escape cancels, and blur commits — so a keyboard user and a mouse user both
 * have a obvious path.
 */
function MediaField({
  label,
  value,
  busy,
  readOnly = false,
  onSave
}: {
  label: string
  value: string | null
  busy: boolean
  readOnly?: boolean
  onSave?: (value: string | null) => void
}): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const begin = (): void => {
    if (readOnly || busy) return
    setDraft(value ?? '')
    setEditing(true)
  }

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next !== (value ?? '') && onSave) onSave(next === '' ? null : next)
  }

  if (editing) {
    return (
      <label className="flex min-w-0 flex-col">
        <span className="text-muted">{label}</span>
        <input
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(false)
          }}
          className="min-w-0 rounded border border-line bg-[color:var(--surface)] px-1.5 py-0.5 text-[11px] text-ink focus:border-[color:var(--color-brand-500)] focus:outline-none"
        />
      </label>
    )
  }

  return (
    <button
      type="button"
      onClick={begin}
      disabled={readOnly || busy}
      title={readOnly ? undefined : 'Click to edit'}
      className="group flex min-w-0 flex-col rounded text-left disabled:cursor-default"
    >
      <span className="text-muted">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="selectable truncate text-[11px] font-medium text-ink-2">
          {value ?? '—'}
        </span>
        {!readOnly ? (
          <span className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100">
            <IconPencil size={9} />
          </span>
        ) : null}
      </span>
    </button>
  )
}
