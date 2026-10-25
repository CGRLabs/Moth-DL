/**
 * `moth://download` deep-link protocol: cold-start the app from the browser.
 *
 * Public surface for the orchestrator's glue in `src/main/index.ts`:
 *
 *   import { initDeepLink, registerProtocol } from './protocol/index.js'
 *
 *   const { pending } = initDeepLink({ onDeepLink: (request) => {
 *     void engine.add({ url: request.url, format: request.format })
 *   }})
 *   // ... after engine.start():
 *   if (pending) await engine.add({ url: pending.url, format: pending.format })
 *
 * (Exact glue snippet, including where it sits in `bootstrap()`, ships in
 * `_agents/w5-deeplink.md`.) Status plumbing (`moth:deeplink:status` /
 * `moth:deeplink:register`) is registered in `src/main/ipc/handlers.ts` and
 * bridged in `src/preload/index.ts`; the Settings row reads those channels.
 */

export {
  DEEP_LINK_PATH,
  DEEP_LINK_SCHEME,
  emptyRequestSchema,
  findDeepLinkInArgv,
  parseDeepLink,
  type DeepLinkFormat,
  type DeepLinkRequest
} from './deepLink.js'
export { attachDeepLinkHandler, initDeepLink, type DeepLinkCallback, type InitDeepLinkOptions, type InitDeepLinkResult } from './handler.js'
export { isProtocolRegistered, registerProtocol } from './register.js'
