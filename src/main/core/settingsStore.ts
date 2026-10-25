/**
 * Settings store.
 *
 * Settings live in the `settings` table as JSON blobs (one row per top-level
 * key) rather than as individual columns, so adding a preference is a
 * non-migrating change. Values are merged over the defaults on load, which
 * means a database written by an older build still boots: missing keys simply
 * fall back to their default.
 */

import type { AppSettings, LogLevel } from '@shared/types.js'
import { DEFAULT_SETTINGS, DEFAULT_CATEGORY_FOLDERS } from '@shared/constants.js'
import type { Repositories } from '../db/repositories.js'
import { EventBus } from './events.js'
import { getLogger } from '../util/logger.js'

const log = getLogger('core.settings')

// A type alias (not an interface) so it satisfies EventBus's index-signature
// constraint and therefore gets full key checking.
export type SettingsEvents = {
  changed: AppSettings
}

export class SettingsStore {
  private current: AppSettings
  private readonly events = new EventBus<SettingsEvents>()

  constructor(private readonly repos: Repositories) {
    this.current = this.load()
    // The log level is applied at boot by the caller, which owns the logger.
    log.info('Settings loaded', {
      directory: this.current.downloadDirectory,
      maxConcurrent: this.current.maxConcurrentDownloads
    })
  }

  /** Reads and validates persisted settings, overlaying them on defaults. */
  private load(): AppSettings {
    const stored = this.repos.settings.getAll()
    const merged: AppSettings = { ...DEFAULT_SETTINGS, categoryFolders: { ...DEFAULT_CATEGORY_FOLDERS } }

    for (const [key, value] of Object.entries(stored)) {
      if (key === 'categoryFolders') {
        try {
          const parsed: unknown = JSON.parse(value)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [category, folder] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof folder === 'string' && folder.length > 0) {
                ;(merged.categoryFolders as Record<string, string>)[category] = folder
              }
            }
          }
        } catch (err) {
          log.warn('Corrupt categoryFolders setting; using defaults', { error: err })
        }
        continue
      }

      const typedKey = key as keyof AppSettings
      if (!(typedKey in merged)) continue
      const defaultValue = merged[typedKey]
      const parsed = coerce(value, defaultValue)
      if (parsed !== undefined) {
        // AppSettings has no index signature, so widen through `unknown`.
        ;(merged as unknown as Record<string, unknown>)[typedKey] = parsed
      }
    }
    return merged
  }

  get(): AppSettings {
    return this.current
  }

  onChanged(listener: (settings: AppSettings) => void): () => void {
    return this.events.on('changed', listener)
  }

  /**
   * Applies a validated partial update, persists it, and notifies listeners.
   * Returns the full settings after the update.
   */
  update(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = {
      ...this.current,
      ...patch,
      categoryFolders: {
        ...this.current.categoryFolders,
        ...(patch.categoryFolders ?? {})
      }
    }
    this.current = next
    this.persist(next)
    this.events.emit('changed', next)
    return next
  }

  private persist(settings: AppSettings): void {
    const entries: Record<string, string> = {}
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'categoryFolders') {
        entries[key] = JSON.stringify(value)
      } else if (value !== undefined) {
        entries[key] = typeof value === 'string' ? value : JSON.stringify(value)
      }
    }
    try {
      this.repos.settings.setMany(entries)
    } catch (err) {
      log.error('Failed to persist settings', { error: err })
    }
  }

  /** Convenience used by the logger bootstrap. */
  get logLevel(): LogLevel {
    return this.current.logLevel
  }
}

/** Coerces a persisted string back into the type of its default value. */
function coerce(raw: string, defaultValue: unknown): unknown {
  if (defaultValue === null) {
    // Nullable settings are stored as an explicit sentinel.
    if (raw === 'null') return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  switch (typeof defaultValue) {
    case 'number': {
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'boolean':
      if (raw === 'true') return true
      if (raw === 'false') return false
      return undefined
    case 'string':
      return raw
    default:
      return undefined
  }
}
