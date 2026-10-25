import type { DownloadSnapshot } from '@shared/types.js'
import { Modal } from './Modal.js'

interface Props {
  download: DownloadSnapshot
  onClose: () => void
  onRemove: (deleteCompletedFile: boolean) => void
}

export function RemoveDownloadDialog({ download, onClose, onRemove }: Props): React.ReactElement {
  const hasCompletedFile = download.status === 'completed' && download.finalPath !== null

  return (
    <Modal
      title="Remove download?"
      subtitle={download.filename}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-2 text-[11px] font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)]"
          >
            Keep download
          </button>
          {hasCompletedFile ? (
            <>
              <button
                type="button"
                onClick={() => onRemove(false)}
                className="rounded-lg border border-line px-3 py-2 text-[11px] font-medium text-ink-2 transition-colors hover:bg-[color:var(--surface-3)]"
              >
                Remove, keep file
              </button>
              <button
                type="button"
                onClick={() => onRemove(true)}
                className="rounded-lg bg-[color:var(--color-bad)] px-3 py-2 text-[11px] font-semibold text-[#151c27] transition-opacity hover:opacity-90"
              >
                Remove and delete file
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onRemove(false)}
              className="rounded-lg bg-brand-600 px-3 py-2 text-[11px] font-semibold text-on-brand transition-colors hover:bg-brand-700"
            >
              Remove download
            </button>
          )}
        </>
      }
    >
      <p className="text-[12px] leading-relaxed text-ink-2">
        This removes the item from Moth. Any unfinished partial data will be deleted because it can no
        longer be resumed after removal.
      </p>
      {hasCompletedFile ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          Your completed file will stay on your computer unless you choose <strong className="font-semibold text-ink-2">Remove and delete file</strong>.
        </p>
      ) : null}
    </Modal>
  )
}
