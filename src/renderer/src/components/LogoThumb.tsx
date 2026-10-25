/**
 * Moth logo in the header.
 *
 * The new Moth artwork from `resources/icon.png`, bundled by the build. Falls
 * back to the download-arrow mark when the asset cannot load, so the header
 * never shows a broken image.
 */

import { useState } from 'react'
// A generated copy of `resources/icon.png`; refresh after `npm run icons`.
import logoUrl from '../assets/moth-logo.png'

export function LogoThumb({ size = 26 }: { size?: number }): React.ReactElement {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-md bg-brand-600 text-[13px] font-bold text-[#151c27]"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <svg
          width={Math.round(size * 0.52)}
          height={Math.round(size * 0.52)}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 5v10M8 11l4 4 4-4M5 19h14" />
        </svg>
      </span>
    )
  }

  return (
    <img
      src={logoUrl}
      alt=""
      width={size}
      height={size}
      decoding="async"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-md object-cover"
      style={{ width: size, height: size }}
    />
  )
}
