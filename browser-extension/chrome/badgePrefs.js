/**
 * Badge preferences: show/hide toggle plus the site blacklist.
 *
 * Read from `storage.local` so the popup and every tab's content script see
 * the same values. `onChanged` keeps long-lived tabs in sync without reload.
 */

(function installMothBadgePrefs(root) {
const extApi = root.chrome ?? root.browser

const prefs = { showBadge: true, blacklist: '', excludedTypes: '', port: 24678, token: '' }

/**
 * One hostname per line; a leading dot is a suffix match so `.youtube.com`
 * covers `music.youtube.com`, otherwise the host must match exactly.
 */
function isBlacklisted(host, raw) {
  const name = String(host || '').toLowerCase().trim()
  if (!name) return false
  for (const line of String(raw || '').split('\n')) {
    const rule = line.trim().toLowerCase()
    if (!rule) continue
    if (rule.startsWith('.')) {
      const bare = rule.slice(1)
      if (name === bare || name.endsWith(rule)) return true
    } else if (name === rule) {
      return true
    }
  }
  return false
}

function badgeDisabled(host, url = '') {
  if (!prefs.showBadge) return true
  if (isBlacklisted(host, prefs.blacklist)) return true
  return Boolean(
    url &&
      root.MothTransferPolicy?.isExtensionExcluded(url, prefs.excludedTypes)
  )
}

async function readStored() {
  try {
    const stored = await extApi.storage.local.get({
      showBadge: true,
      blacklist: '',
      excludedTypes: '',
      port: 24678,
      token: ''
    })
    prefs.showBadge = stored.showBadge !== false
    prefs.blacklist = String(stored.blacklist || '')
    prefs.excludedTypes = String(stored.excludedTypes || '')
    prefs.port = Number(stored.port) || 24678
    prefs.token = String(stored.token || '')
  } catch {
    /* storage unavailable (private mode edge): stay with safe defaults */
  }
}

/** Load once, then follow popup edits live. `onChange` re-checks visibility. */
function watchPrefs(onChange) {
  void readStored()
  try {
    if (extApi.storage?.onChanged) {
      extApi.storage.onChanged.addListener((changes) => {
        if (changes.showBadge) prefs.showBadge = changes.showBadge.newValue !== false
        if (changes.blacklist) prefs.blacklist = String(changes.blacklist.newValue || '')
        if (changes.excludedTypes) prefs.excludedTypes = String(changes.excludedTypes.newValue || '')
        if (changes.port) prefs.port = Number(changes.port.newValue) || 24678
        if (changes.token) prefs.token = String(changes.token.newValue || '')
        if (typeof onChange === 'function') onChange()
      })
    }
  } catch {
    /* live sync is a nicety, not a requirement */
  }
}

root.MothBadgePrefs = { prefs, isBlacklisted, badgeDisabled, watchPrefs }
})(globalThis)
