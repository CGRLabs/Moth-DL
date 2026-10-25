import { describe, expect, it } from 'vitest'
import {
  ACCENT_SWATCHES,
  THEME_PRESETS,
  isAmberPreset,
  isDarkPreset,
  normalizeTheme
} from '../../src/shared/theme.js'
import { DEFAULT_SETTINGS } from '../../src/shared/constants.js'
import { accentColorSchema, settingsPatchSchema, themeSchema } from '../../src/shared/schemas.js'

describe('normalizeTheme', () => {
  it('passes current presets through', () => {
    expect(normalizeTheme('graphite')).toBe('graphite')
    expect(normalizeTheme('amber')).toBe('amber')
    expect(normalizeTheme('light')).toBe('light')
    expect(normalizeTheme('system')).toBe('system')
  })

  it('maps legacy values written by older builds', () => {
    expect(normalizeTheme('dark')).toBe('graphite')
  })

  it('falls back to system for anything unexpected', () => {
    expect(normalizeTheme('neon')).toBe('system')
    expect(normalizeTheme(null)).toBe('system')
    expect(normalizeTheme(undefined)).toBe('system')
  })
});

describe('preset darkness', () => {
  it('treats graphite and amber as dark, light as light', () => {
    expect(isDarkPreset('graphite', false)).toBe(true)
    expect(isDarkPreset('amber', false)).toBe(true)
    expect(isDarkPreset('light', true)).toBe(false)
  })

  it('follows the OS for system', () => {
    expect(isDarkPreset('system', true)).toBe(true)
    expect(isDarkPreset('system', false)).toBe(false)
  })

  it('only an explicit amber choice enables the amber overrides', () => {
    expect(isAmberPreset('amber')).toBe(true)
    expect(isAmberPreset('graphite')).toBe(false)
    expect(isAmberPreset('system')).toBe(false)
    expect(isAmberPreset('light')).toBe(false)
  })
});

describe('preset metadata', () => {
  it('uses the fixed dark palette and normal window close for first-run defaults', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('graphite')
    expect(DEFAULT_SETTINGS.closeToTray).toBe(false)
  })

  it('covers every schema value exactly once', () => {
    const ids = THEME_PRESETS.map((preset) => preset.id).sort()
    expect(ids).toEqual(['amber', 'graphite', 'light', 'system'])
    for (const preset of THEME_PRESETS) {
      expect(themeSchema.safeParse(preset.id).success).toBe(true)
    }
  })

  it('ships valid hex swatches', () => {
    for (const hex of ACCENT_SWATCHES) {
      expect(accentColorSchema.safeParse(hex).success).toBe(true)
    }
  })

});

describe('accent settings schema', () => {
  it('accepts a #rrggbb accent or null', () => {
    expect(settingsPatchSchema.safeParse({ accentColor: '#f5a623' }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ accentColor: null }).success).toBe(true)
  })

  it('rejects malformed accents and unknown themes', () => {
    expect(settingsPatchSchema.safeParse({ accentColor: 'amber' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ accentColor: '#fff' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ theme: 'dark' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ theme: 'neon' }).success).toBe(false)
  })
});
