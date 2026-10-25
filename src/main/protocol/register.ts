/**
 * OS registration for the `moth://` protocol.
 *
 * Windows-first: on win32 this delegates to Electron's
 * `app.setAsDefaultProtocolClient`, which writes the `HKCU\Software\Classes`
 * entries without admin rights. No hand-rolled `reg.exe` fallback exists on
 * purpose — a parallel writer would duplicate Electron's keys and risk
 * divergence (the same stable-path discipline `extensionInstall` follows for
 * the companion extension). macOS and Linux no-op cleanly and report
 * `false`; registration there is the installer's job, not the running app's.
 *
 * Browser detection is out of scope by design: protocol registration is
 * per-OS, so one row covers Chrome, Edge, Firefox and friends.
 */

import { app } from 'electron'
import { resolve } from 'node:path'
import { DEEP_LINK_SCHEME } from './deepLink.js'
import { getLogger } from '../util/logger.js'

const log = getLogger('protocol')

/** True when this app is currently the OS handler for `moth://` links. */
export function isProtocolRegistered(): boolean {
  if (process.platform !== 'win32') return false
  try {
    return app.isDefaultProtocolClient(DEEP_LINK_SCHEME)
  } catch (err) {
    log.warn('Protocol registration check failed', { error: err })
    return false
  }
}

/**
 * Registers this app as the OS handler for `moth://` links.
 *
 * Returns the post-call state, so the Settings row can show the honest
 * outcome instead of assuming success. In development (`process.defaultApp`,
 * running under `electron.exe`) the entry script is passed explicitly so the
 * dev instance registers itself rather than the bare Electron binary.
 */
export function registerProtocol(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const entry = process.argv[1]
    if (process.defaultApp && typeof entry === 'string' && entry.length > 0) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(entry)])
    } else {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
    }
    return app.isDefaultProtocolClient(DEEP_LINK_SCHEME)
  } catch (err) {
    log.warn('Protocol registration failed', { error: err })
    return false
  }
}
