/**
 * Preload bridge.
 *
 * The renderer gets a narrow, explicitly enumerated API. It is built on
 * `contextBridge`, so the renderer cannot reach `ipcRenderer`, `require`, or
 * any Node primitive — a compromised page is limited to exactly the calls below.
 *
 * Event subscriptions return an unsubscribe function rather than an emitter
 * handle, so a React effect can clean up without the renderer ever seeing an
 * internal object.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannel, IpcEvent, type IpcEventMap, type IpcInvokeMap } from '@shared/ipc.js'

type Invoke<C extends keyof IpcInvokeMap> = (
  payload?: IpcInvokeMap[C]['req'] extends void ? undefined : IpcInvokeMap[C]['req']
) => Promise<IpcInvokeMap[C]['res']>

type Subscribe<C extends keyof IpcEventMap> = (
  listener: (payload: IpcEventMap[C]) => void
) => () => void

export interface RendererDiagnostic {
  kind: 'uncaught-error' | 'unhandled-rejection'
  message: string
  stack?: string
  source?: string
  line?: number
  column?: number
}

function buildInvoke<C extends keyof IpcInvokeMap>(channel: C): Invoke<C> {
  return ((payload?: unknown) => ipcRenderer.invoke(channel, payload)) as Invoke<C>
}

function buildSubscribe<C extends keyof IpcEventMap>(channel: C): Subscribe<C> {
  return (listener: (payload: IpcEventMap[C]) => void) => {
    // The raw IpcRendererEvent is deliberately not forwarded: leaking it would
    // hand the renderer `event.sender`, which is a path back into the main
    // process.
    const wrapped = (_event: IpcRendererEvent, payload: IpcEventMap[C]): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

const invoke = {
  addDownload: buildInvoke(IpcChannel.AddDownload),
  stageDownload: buildInvoke(IpcChannel.StageDownload),
  startReviewDownload: buildInvoke(IpcChannel.StartReviewDownload),
  getReviewRequest: buildInvoke(IpcChannel.GetReviewRequest),
  configureReviewDownload: buildInvoke(IpcChannel.ConfigureReviewDownload),
  previewDownload: buildInvoke(IpcChannel.PreviewDownload),
  previewMediaPlaylist: buildInvoke(IpcChannel.PreviewMediaPlaylist),
  getPlaylistThumbnail: buildInvoke(IpcChannel.GetPlaylistThumbnail),
  checkMediaDuplicate: buildInvoke(IpcChannel.CheckMediaDuplicate),
  listDownloads: buildInvoke(IpcChannel.ListDownloads),
  getDownload: buildInvoke(IpcChannel.GetDownload),
  getDownloadFileIcon: buildInvoke(IpcChannel.GetDownloadFileIcon),
  pauseDownload: buildInvoke(IpcChannel.PauseDownload),
  resumeDownload: buildInvoke(IpcChannel.ResumeDownload),
  cancelDownload: buildInvoke(IpcChannel.CancelDownload),
  retryDownload: buildInvoke(IpcChannel.RetryDownload),
  refreshDownloadUrl: buildInvoke(IpcChannel.RefreshDownloadUrl),
  removeDownload: buildInvoke(IpcChannel.RemoveDownload),
  setPriority: buildInvoke(IpcChannel.SetPriority),
  setSpeedLimit: buildInvoke(IpcChannel.SetSpeedLimit),
  setUploadSpeedLimit: buildInvoke(IpcChannel.SetUploadSpeedLimit),
  setDownloadQuota: buildInvoke(IpcChannel.SetDownloadQuota),
  getTorrentFiles: buildInvoke(IpcChannel.GetTorrentFiles),
  setTorrentFiles: buildInvoke(IpcChannel.SetTorrentFiles),
  selectTorrentFile: buildInvoke(IpcChannel.SelectTorrentFile),
  moveUp: buildInvoke(IpcChannel.MoveUp),
  moveDown: buildInvoke(IpcChannel.MoveDown),
  reorder: buildInvoke(IpcChannel.Reorder),
  pauseAll: buildInvoke(IpcChannel.PauseAll),
  resumeAll: buildInvoke(IpcChannel.ResumeAll),
  clearCompleted: buildInvoke(IpcChannel.ClearCompleted),
  setStatus: buildInvoke(IpcChannel.SetStatus),
  listQueuePlans: buildInvoke(IpcChannel.ListQueuePlans),
  createQueuePlan: buildInvoke(IpcChannel.CreateQueuePlan),
  cancelQueuePlan: buildInvoke(IpcChannel.CancelQueuePlan),
  removeQueuePlan: buildInvoke(IpcChannel.RemoveQueuePlan),
  verifyDownload: buildInvoke(IpcChannel.VerifyDownload),
  revealFile: buildInvoke(IpcChannel.RevealFile),
  openContainingFolder: buildInvoke(IpcChannel.OpenContainingFolder),
  openFile: buildInvoke(IpcChannel.OpenFile),
  getSettings: buildInvoke(IpcChannel.GetSettings),
  setSettings: buildInvoke(IpcChannel.SetSettings),
  getStats: buildInvoke(IpcChannel.GetStats),
  runRecovery: buildInvoke(IpcChannel.RunRecovery),
  rescanDisk: buildInvoke(IpcChannel.RescanDisk),
  selectDirectory: buildInvoke(IpcChannel.SelectDirectory),
  prepareDiagnosticReport: buildInvoke(IpcChannel.PrepareDiagnosticReport),
  discardDiagnosticReport: buildInvoke(IpcChannel.DiscardDiagnosticReport),
  saveDiagnosticReport: buildInvoke(IpcChannel.SaveDiagnosticReport),
  openLogsFolder: buildInvoke(IpcChannel.OpenLogsFolder),
  getAppInfo: buildInvoke(IpcChannel.GetAppInfo),
  getDiskUsage: buildInvoke(IpcChannel.GetDiskUsage),
  getPaths: buildInvoke(IpcChannel.GetPaths),
  getIngestInfo: buildInvoke(IpcChannel.GetIngestInfo),
  openExtensionFolder: buildInvoke(IpcChannel.OpenExtensionFolder),
  prepareExtensionSetup: buildInvoke(IpcChannel.PrepareExtensionSetup),
  regenerateToken: buildInvoke(IpcChannel.RegenerateToken),
  installExtension: buildInvoke(IpcChannel.InstallExtension),
  getExtensionStatus: buildInvoke(IpcChannel.GetExtensionStatus),
  getDeepLinkStatus: buildInvoke(IpcChannel.GetDeepLinkStatus),
  registerDeepLink: buildInvoke(IpcChannel.RegisterDeepLink),
  getMediaMetadata: buildInvoke(IpcChannel.GetMediaMetadata),
  setMediaMetadata: buildInvoke(IpcChannel.SetMediaMetadata),
  writeMediaTags: buildInvoke(IpcChannel.WriteMediaTags),
  windowAction: buildInvoke(IpcChannel.WindowAction),
  quitApp: buildInvoke(IpcChannel.QuitApp)
} as const

const on = {
  downloadUpserted: buildSubscribe(IpcEvent.DownloadUpserted),
  downloadRemoved: buildSubscribe(IpcEvent.DownloadRemoved),
  downloadProgress: buildSubscribe(IpcEvent.DownloadProgress),
  downloadFinished: buildSubscribe(IpcEvent.DownloadFinished),
  downloadFailed: buildSubscribe(IpcEvent.DownloadFailed),
  engineStats: buildSubscribe(IpcEvent.EngineStats),
  speedHistory: buildSubscribe(IpcEvent.SpeedHistory),
  settingsChanged: buildSubscribe(IpcEvent.SettingsChanged),
  logLine: buildSubscribe(IpcEvent.LogLine),
  recoveryReport: buildSubscribe(IpcEvent.RecoveryReport),
  mediaUpdated: buildSubscribe(IpcEvent.MediaUpdated),
  schedulerFired: buildSubscribe(IpcEvent.SchedulerFired),
  queuePlansChanged: buildSubscribe(IpcEvent.QueuePlansChanged),
  themeChanged: buildSubscribe(IpcEvent.ThemeChanged)
} as const

export type MothApi = {
  invoke: typeof invoke
  on: typeof on
  reportDiagnostic: (diagnostic: RendererDiagnostic) => void
  platform: NodeJS.Platform
}

const api: MothApi = {
  invoke,
  on,
  reportDiagnostic: (diagnostic) => ipcRenderer.send('moth:diagnostic:renderer-error', diagnostic),
  platform: process.platform
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('moth', api)
} else {
  // Only reachable if context isolation is somehow disabled; still better than
  // leaking the raw ipcRenderer.
  ;(globalThis as unknown as { moth: MothApi }).moth = api
}
