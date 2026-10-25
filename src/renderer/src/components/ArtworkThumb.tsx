/**
 * Artwork thumbnail for a download row.
 *
 * The image is loaded from an `moth-artwork://` URL served by a custom
 * protocol, never a `file://` path, so the renderer needs no filesystem access
 * and cannot be handed an arbitrary path to read.
 *
 * Renders nothing when there is no artwork, so the common case costs no layout
 * and no network request.
 */

import { useEffect, useState } from 'react'
import { CategoryBadge } from './CategoryBadge.js'
import type { DownloadCategory } from '@shared/types.js'

interface Props {
  artworkUrl: string | null
  category: DownloadCategory
  completed: boolean
  failed: boolean
}

export function ArtworkThumb({
  artworkUrl,
  category,
  completed,
  failed
}: Props): React.ReactElement {
  const [failedToLoad, setFailedToLoad] = useState(false)

  useEffect(() => {
    setFailedToLoad(false)
  }, [artworkUrl])

  if (!artworkUrl || failedToLoad) {
    return (
      <CategoryBadge category={category} completed={completed} failed={failed} />
    )
  }

  return (
    <img
      src={artworkUrl}
      alt=""
      width={48}
      height={27}
      loading="lazy"
      decoding="async"
      onError={() => {
        console.error('ARTWORK FAILED', artworkUrl)
        setFailedToLoad(true)
      }}
      className="h-[27px] w-12 shrink-0 rounded-lg object-cover"
      // A broken image must not leave a visible frame.
      style={{ background: 'var(--surface-3)' }}
    />
  )
}
