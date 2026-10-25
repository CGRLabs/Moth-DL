/**
 * File-type badge.
 *
 * A tinted square with a Lucide file-type glyph: pixel-identical everywhere
 * (emoji rendered at inconsistent sizes and several showed as a missing-glyph
 * box) and carrying the category colour so the row is scannable without
 * reading the filename.
 */

import type { DownloadCategory } from '@shared/types.js'
import { CATEGORY_LABEL } from '../lib/format.js'
import { CATEGORY_ICON, IconAlert, IconCheck } from './Icons.js'

interface Props {
  category: DownloadCategory
  /** Completed rows get a tick instead of the file glyph. */
  completed?: boolean
  failed?: boolean
  size?: 'sm' | 'md'
}

export function CategoryBadge({
  category,
  completed = false,
  failed = false,
  size = 'md'
}: Props): React.ReactElement {
  const dimension = size === 'sm' ? 'size-6' : 'size-8'
  const glyphSize = size === 'sm' ? 13 : 15
  const label = CATEGORY_LABEL[category] ?? 'File'
  const Glyph = CATEGORY_ICON[category] ?? CATEGORY_ICON.other

  return (
    <span
      data-category={category}
      // `data-status` and `data-category` can both be present on nested
      // elements; this badge only participates in the category palette.
      title={label}
      aria-label={label}
      className={[
        'grid shrink-0 place-items-center rounded-lg',
        dimension,
        'text-[color:var(--cat-fg)]',
        completed ? 'bg-transparent' : 'bg-[color:var(--cat-bg)]'
      ].join(' ')}
    >
      {completed ? (
        <IconCheck size={glyphSize} strokeWidth={3} />
      ) : failed ? (
        <IconAlert size={glyphSize} />
      ) : (
        <Glyph size={glyphSize} />
      )}
    </span>
  )
}
