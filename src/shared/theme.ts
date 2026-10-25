/**
 * Theme presets.
 *
 * Pure helpers (no DOM) so they are unit-testable in node. DOM application
 * lives in `App.tsx`'s theme effect: `dark` class for graphite/amber, plus
 * `theme-amber` for the amber preset; a custom accent sets `--brand-base`
 * inline with a `data-accent` attribute and every brand rung derives from it
 * in CSS via `color-mix` — zero JS color math.
 */

import type { ThemePreset } from './types.js'

export interface PresetMeta {
  id: ThemePreset
  label: string
  blurb: string
  /** The preset's own accent, shown as its swatch. */
  swatch: string
}

export const THEME_PRESETS: readonly PresetMeta[] = [
  { id: 'graphite', label: 'Graphite', blurb: 'Neutral dark', swatch: '#5b6ee1' },
  { id: 'amber', label: 'Moth Amber', blurb: 'Warm near-black', swatch: '#f5a623' },
  { id: 'light', label: 'Fieldnotes', blurb: 'Warm paper, forest green', swatch: '#28745b' },
  { id: 'system', label: 'System', blurb: 'Follows the OS', swatch: '#888888' }
]

/** Suggested accents for the swatch row; the native input covers the rest. */
export const ACCENT_SWATCHES: readonly string[] = [
  '#28745b',
  '#f5a623',
  '#5b6ee1',
  '#22c55e',
  '#a855f7',
  '#ec4899',
  '#06b6d4'
]

/**
 * Normalizes a stored theme, tolerating values written by older builds
 * (`dark`/`light`) and anything unexpected (falls back to `system`).
 */
export function normalizeTheme(value: unknown): ThemePreset {
  if (value === 'dark' || value === 'graphite') return 'graphite'
  if (value === 'amber' || value === 'light' || value === 'system') return value
  return 'system'
}

/** Whether the preset renders dark surfaces (for the `dark` class). */
export function isDarkPreset(theme: ThemePreset, systemDark: boolean): boolean {
  if (theme === 'graphite' || theme === 'amber') return true
  if (theme === 'light') return false
  return systemDark
}

/** Whether the amber surface overrides apply (explicit preset only). */
export function isAmberPreset(theme: ThemePreset): boolean {
  return theme === 'amber'
}
