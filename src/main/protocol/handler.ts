/**
 * Wiring between OS protocol launches and the app.
 *
 * Three launch shapes collapse into one callback:
 *
 *  - cold start (Windows): the `moth://` URL arrives in this process's argv.
 *    It is captured as `pending` and RETURNED, not delivered — the engine
 *    does not exist yet when this module initialises, and delivering into
 *    the void would silently drop the download. The orchestrator drains it
 *    after `engine.start()`.
 *  - warm reuse: a second OS launch forwards argv to the running instance
 *    via `second-instance`. The existing lock in `src/main/index.ts` stays
 *    the only lock; this module merely adds a second listener alongside its
 *    `showWindow()` one (both fire). The engine is up by then, so the
 *    callback fires immediately.
 *  - macOS `open-url`: same immediate delivery; a no-op listener elsewhere.
 *
 * The callback never touches the engine itself — it delivers `{ url, format }`
 * and the orchestrator's glue passes it to `engine.add`.
 */

import { app, type Event as ElectronEvent } from 'electron'
import { parseDeepLink, type DeepLinkRequest } from './deepLink.js'
import { getLogger } from '../util/logger.js'

const log = getLogger('protocol')

export type DeepLinkCallback = (request: DeepLinkRequest) => void

export interface InitDeepLinkOptions {
  onDeepLink: DeepLinkCallback
}

export interface InitDeepLinkResult {
  /** A `moth://` URL found in this process's argv. Drain after the engine is ready. */
  pending: DeepLinkRequest | null
  /** Removes both OS listeners. */
  dispose: () => void
}

/** Forwards warm-launch URLs (second instance, open-url) to one callback. */
export function attachDeepLinkHandler(onDeepLink: DeepLinkCallback): () => void {
  const onSecondInstance = (_event: ElectronEvent, argv: string[]): void => {
    const request = parseDeepLink(argv)
    if (!request) return
    // The URL itself is never logged: it can carry tokens in its query string.
    log.info('Deep link from second instance', { format: request.format })
    onDeepLink(request)
  }
  const onOpenUrl = (event: ElectronEvent, url: string): void => {
    event.preventDefault()
    const request = parseDeepLink(url)
    if (!request) return
    log.info('Deep link via open-url', { format: request.format })
    onDeepLink(request)
  }
  app.on('second-instance', onSecondInstance)
  app.on('open-url', onOpenUrl)
  return () => {
    app.removeListener('second-instance', onSecondInstance)
    app.removeListener('open-url', onOpenUrl)
  }
}

/** Attaches the warm-launch listeners and captures any cold-start URL. */
export function initDeepLink(options: InitDeepLinkOptions): InitDeepLinkResult {
  const dispose = attachDeepLinkHandler(options.onDeepLink)
  const pending = parseDeepLink(process.argv)
  if (pending) log.info('Cold-start deep link in argv', { format: pending.format })
  return { pending, dispose }
}
