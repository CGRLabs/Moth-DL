import type { MothApi } from './index.js'

declare global {
  interface Window {
    /** Injected by the preload bridge; the renderer's only capability. */
    moth: MothApi
  }
}

export {}
