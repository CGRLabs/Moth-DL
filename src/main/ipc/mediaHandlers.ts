/**
 * Media metadata IPC.
 *
 * Registered separately from the download handlers in `handlers.ts`, which is
 * already large enough that adding a second responsibility would make it harder
 * to navigate.
 *
 * The renderer is never handed a filesystem path. Artwork travels as an
 * `moth-artwork://` URL served by a custom protocol, so the renderer needs no
 * filesystem access and cannot be tricked into reading an arbitrary file.
 */

import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import { downloadIdSchema, parseOrThrow, setMediaMetadataSchema } from '@shared/schemas.js'
import type { MediaService } from '../media/service.js'
import type { Repositories } from '../db/repositories.js'
import { getDownloadPath } from './mediaIpcPaths.js'
import { getLogger } from '../util/logger.js'

const log = getLogger('ipc.media')

/**
 * Base URL for artwork.
 *
 * A fixed host (`file`) is required: Chromium parses `moth-artwork:///cover.png`
 * as host `cover.png` with an empty path, which puts the filename in the wrong
 * place. With a host present, the filename lands in the pathname where the
 * handler expects it.
 */
export const ARTWORK_PROTOCOL_BASE = 'moth-artwork://file/'

export function registerMediaIpc(options: {
  service: MediaService
  repos: Repositories
  /** Emits a change so every window refreshes. */
  onChanged: (downloadId: string) => void
}): void {
  const { service, repos, onChanged } = options

  ipcMain.handle(IpcChannel.GetMediaMetadata, (_event, raw: unknown) => {
    const id = parseOrThrow(downloadIdSchema, raw, 'download id')
    return service.getView(id)
  })

  ipcMain.handle(IpcChannel.SetMediaMetadata, async (_event, raw: unknown) => {
    const { id, patch } = parseOrThrow(setMediaMetadataSchema, raw, 'metadata patch')
    const view = await service.applyManualEdit(id, patch)
    if (view) onChanged(id)
    return view
  })

  ipcMain.handle(IpcChannel.WriteMediaTags, async (_event, raw: unknown) => {
    const id = parseOrThrow(downloadIdSchema, raw, 'download id')
    const view = service.getView(id)
    if (!view) return { written: false, reason: 'No metadata for this download' }

    // The path is resolved server-side from the download record; the renderer
    // never supplies one.
    const path = await getDownloadPath(repos, id)
    if (!path) return { written: false, reason: 'Download has no file on disk' }

    const result = await service.writeToFile(id, path)
    if (result.written) onChanged(id)
    log.info('Tags written on request', { id, result })
    return result
  })

  log.info('Media IPC registered')
}
