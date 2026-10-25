/**
 * IPC contract.
 *
 * Channel names live in one place so the preload bridge, the main-process
 * handlers and the renderer hooks can never drift apart. Two families exist:
 *
 *  - `IpcInvoke`  renderer -> main, request/response, may reject.
 *  - `IpcEvent`   main -> renderer, fire-and-forget push.
 */

import type {
  AddDownloadRequest,
  AddDownloadResult,
  AppSettings,
  Download,
  DownloadId,
  DownloadSnapshot,
  DownloadStatus,
  TorrentFileView,
  CreateQueuePlanRequest,
  QueuePlan,
  DuplicateMediaResult,
  EngineStats,
  LogLine,
  PreviewDownloadRequest,
  PreviewDownloadResult,
  MediaPlaylistPreview,
  SpeedSample,
  DownloadVerificationResult
} from './types.js'
import type { MediaMetadataPatch, MediaMetadataView, MediaWriteResult } from './media.js'

export const IpcChannel = {
  // --- downloads: lifecycle -------------------------------------------------
  AddDownload: 'moth:download:add',
  StageDownload: 'moth:download:stage',
  StartReviewDownload: 'moth:download:startReview',
  GetReviewRequest: 'moth:download:reviewRequest',
  ConfigureReviewDownload: 'moth:download:configureReview',
  PreviewDownload: 'moth:download:preview',
  PreviewMediaPlaylist: 'moth:media:playlistPreview',
  GetPlaylistThumbnail: 'moth:media:playlistThumbnail',
  CheckMediaDuplicate: 'moth:media:checkDuplicate',
  ListDownloads: 'moth:download:list',
  GetDownload: 'moth:download:get',
  GetDownloadFileIcon: 'moth:download:fileIcon',
  PauseDownload: 'moth:download:pause',
  ResumeDownload: 'moth:download:resume',
  CancelDownload: 'moth:download:cancel',
  RetryDownload: 'moth:download:retry',
  RefreshDownloadUrl: 'moth:download:refreshUrl',
  RemoveDownload: 'moth:download:remove',
  SetPriority: 'moth:download:setPriority',
  SetSpeedLimit: 'moth:download:setSpeedLimit',
  SetUploadSpeedLimit: 'moth:download:setUploadSpeedLimit',
  SetTorrentFiles: 'moth:torrent:setFiles',
  SetDownloadQuota: 'moth:download:setQuota',
  GetTorrentFiles: 'moth:torrent:getFiles',
  SelectTorrentFile: 'moth:torrent:selectFile',
  MoveUp: 'moth:download:moveUp',
  MoveDown: 'moth:download:moveDown',
  Reorder: 'moth:download:reorder',
  PauseAll: 'moth:download:pauseAll',
  ResumeAll: 'moth:download:resumeAll',
  ClearCompleted: 'moth:download:clearCompleted',
  SetStatus: 'moth:download:setStatus',
  ListQueuePlans: 'moth:queuePlan:list',
  CreateQueuePlan: 'moth:queuePlan:create',
  CancelQueuePlan: 'moth:queuePlan:cancel',
  RemoveQueuePlan: 'moth:queuePlan:remove',
  VerifyDownload: 'moth:download:verify',
  RevealFile: 'moth:download:revealFile',
  OpenContainingFolder: 'moth:download:openFolder',
  OpenFile: 'moth:download:openFile',

  // --- settings & engine ----------------------------------------------------
  GetSettings: 'moth:settings:get',
  SetSettings: 'moth:settings:set',
  GetStats: 'moth:engine:stats',
  RunRecovery: 'moth:engine:recover',
  RescanDisk: 'moth:engine:rescan',

  // --- dialogs / app -------------------------------------------------------
  SelectDirectory: 'moth:dialog:selectDirectory',
  PrepareDiagnosticReport: 'moth:app:prepareDiagnosticReport',
  DiscardDiagnosticReport: 'moth:app:discardDiagnosticReport',
  SaveDiagnosticReport: 'moth:app:saveDiagnosticReport',
  OpenLogsFolder: 'moth:app:openLogs',
  GetAppInfo: 'moth:app:info',
  GetDiskUsage: 'moth:app:diskUsage',
  GetPaths: 'moth:app:paths',
  GetIngestInfo: 'moth:app:ingestInfo',
  OpenExtensionFolder: 'moth:app:openExtension',
  PrepareExtensionSetup: 'moth:app:prepareExtensionSetup',
  RegenerateToken: 'moth:app:regenerateToken',
  InstallExtension: 'moth:app:installExtension',
  GetExtensionStatus: 'moth:app:extensionStatus',
  GetDeepLinkStatus: 'moth:deeplink:status',
  RegisterDeepLink: 'moth:deeplink:register',
  GetMediaMetadata: 'moth:app:getMediaMetadata',
  SetMediaMetadata: 'moth:app:setMediaMetadata',
  WriteMediaTags: 'moth:app:writeMediaTags',
  WindowAction: 'moth:window:action',
  QuitApp: 'moth:app:quit'
} as const

export const IpcEvent = {
  DownloadUpserted: 'moth:event:download:upserted',
  DownloadRemoved: 'moth:event:download:removed',
  DownloadProgress: 'moth:event:download:progress',
  DownloadFinished: 'moth:event:download:finished',
  DownloadFailed: 'moth:event:download:failed',
  DownloadLog: 'moth:event:download:log',
  EngineStats: 'moth:event:engine:stats',
  SpeedHistory: 'moth:event:speed:history',
  SettingsChanged: 'moth:event:settings:changed',
  LogLine: 'moth:event:log:line',
  RecoveryReport: 'moth:event:recovery:report',
  MediaUpdated: 'moth:event:media:updated',
  SchedulerFired: 'moth:event:scheduler:fired',
  ThemeChanged: 'moth:event:theme:changed',
  QueuePlansChanged: 'moth:event:queuePlans:changed'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]
export type IpcEventName = (typeof IpcEvent)[keyof typeof IpcEvent]

export interface RemoveDownloadRequest {
  id: DownloadId
  deleteFile: boolean
}

export interface RefreshDownloadUrlResult {
  download: Download
  keptProgress: boolean
}

export interface ReorderRequest {
  orderedIds: DownloadId[]
}

export interface SetPriorityRequest {
  id: DownloadId
  priority: number
}

export interface SetSpeedLimitRequest {
  id: DownloadId
  /** Bytes per second, or `null` to remove the limit. */
  speedLimit: number | null
}

export interface SetDownloadQuotaRequest {
  id: DownloadId
  /** Maximum bytes saved for this download, or `null` for no quota. */
  quotaBytes: number | null
}

export interface SetStatusRequest {
  id: DownloadId
  status: DownloadStatus
}

export interface QueuePlanIdRequest {
  id: string
}

export interface WindowActionRequest {
  action: 'minimize' | 'maximize' | 'restore' | 'close' | 'hide'
}

export interface IngestInfo {
  enabled: boolean
  running: boolean
  port: number
  token: string
  /** Filesystem path of the unpacked extension, ready for chrome://extensions. */
  extensionPath: string
  /** Directories the folder watcher is currently monitoring. */
  watchedFolders: string[]
}

/** Chromium browsers Moth can register its companion extension with. */
export type ExtensionBrowserId = 'chrome' | 'edge' | 'brave'

/** Per-browser registry state for the companion extension. */
export interface ExtensionBrowserState {
  browser: ExtensionBrowserId
  label: string
  /** The browser's exe was found in a known install location. */
  detected: boolean
  /** A registry entry points at the staged .crx with the current version; this does not prove the browser loaded it. */
  registered: boolean
  /** Version recorded in the registry, when any entry exists. */
  registeredVersion: string | null
  /** Version of the packed extension shipped with the app, when packed. */
  currentVersion: string | null
}

export interface ExtensionStatusResult {
  /** False off Windows: automatic install is a Windows-only code path. */
  supported: boolean
  /** Whether tiri.crx + extension-id.txt shipped with the app. */
  packaged: boolean
  extensionId: string | null
  browsers: ExtensionBrowserState[]
}

export interface ExtensionInstallRequest {
  /** Defaults to every detected browser when omitted or empty. */
  browsers?: ExtensionBrowserId[]
}

export interface InstallPerBrowserResult {
  browser: ExtensionBrowserId
  label: string
  ok: boolean
  error: string | null
}

export interface InstallExtensionResult {
  supported: boolean
  /** Stable staged location the registry entries point at. */
  crxPath: string | null
  results: InstallPerBrowserResult[]
  /** True when at least one browser was registered: restart it to finish. */
  restartRequired: boolean
}

/** Result of the `moth://` protocol status/register calls. */
export interface DeepLinkRegistration {
  registered: boolean
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  startedAt: number
}

export interface DiskUsage {
  /** Total bytes on the volume holding the download directory. */
  totalBytes: number
  /** Bytes available to the user on that volume. */
  freeBytes: number
}

export interface DiskRescanResult {
  /** Downloads whose on-disk state disagreed with the database and was repaired. */
  repaired: DownloadId[]
  /** Downloads whose remote file changed, so their chunks were discarded. */
  invalidated: DownloadId[]
  /** Downloads whose disk rescan could not complete. */
  failed: DownloadId[]
  /** Per-download explanation of what the rescan kept, reset, or skipped. */
  details: DiskRescanDetail[]
  durationMs: number
}

export interface DiskRescanDetail {
  id: DownloadId
  action: 'resumable' | 'repaired' | 'replanned' | 'reset' | 'orphaned' | 'skipped'
  bytesKept: number
  chunksKept: number
  chunksReset: number
  note: string
}

/** Payload shapes for main -> renderer pushes. */
export interface DownloadProgressEvent {
  id: DownloadId
  downloadedBytes: number
  fileSize: number
  speed: number
  eta: number | null
  chunksComplete: number
  chunksTotal: number
  chunkBitmap: number[]
  activeConnections: number
}

export interface DownloadFinishedEvent {
  id: DownloadId
  filename: string
  finalPath: string
  size: number
  durationMs: number
  averageSpeed: number
  checksum: { algorithm: string; value: string } | null
}

export interface DownloadFailedEvent {
  id: DownloadId
  code: string
  message: string
  retryable: boolean
}

export interface RecoveryReportEvent {
  scanned: number
  repaired: number
  bytesRecovered: number
  durationMs: number
  details: { id: DownloadId; action: string; bytes: number; note: string }[]
}

/**
 * Map of channel -> request/response, used to type `ipcRenderer.invoke` calls
 * in the preload bridge and to keep renderer hooks honest.
 */
export interface IpcInvokeMap {
  [IpcChannel.AddDownload]: { req: AddDownloadRequest; res: AddDownloadResult }
  [IpcChannel.StageDownload]: { req: AddDownloadRequest; res: AddDownloadResult }
  [IpcChannel.StartReviewDownload]: { req: { id: DownloadId }; res: Download }
  [IpcChannel.GetReviewRequest]: { req: { id: DownloadId }; res: AddDownloadRequest }
  [IpcChannel.ConfigureReviewDownload]: { req: { id: DownloadId; request: AddDownloadRequest }; res: Download }
  [IpcChannel.PreviewDownload]: { req: PreviewDownloadRequest; res: PreviewDownloadResult }
  [IpcChannel.PreviewMediaPlaylist]: { req: PreviewDownloadRequest; res: MediaPlaylistPreview }
  [IpcChannel.GetPlaylistThumbnail]: { req: { url: string }; res: string | null }
  [IpcChannel.CheckMediaDuplicate]: { req: PreviewDownloadRequest; res: DuplicateMediaResult }
  [IpcChannel.ListDownloads]: { req: void; res: DownloadSnapshot[] }
  [IpcChannel.GetDownload]: { req: { id: DownloadId }; res: DownloadSnapshot | null }
  [IpcChannel.GetDownloadFileIcon]: { req: { id: DownloadId }; res: string | null }
  [IpcChannel.PauseDownload]: { req: { id: DownloadId }; res: Download }
  [IpcChannel.ResumeDownload]: { req: { id: DownloadId }; res: Download }
  [IpcChannel.CancelDownload]: { req: { id: DownloadId }; res: Download }
  [IpcChannel.RetryDownload]: { req: { id: DownloadId }; res: Download }
  [IpcChannel.RefreshDownloadUrl]: {
    req: { id: DownloadId; url: string }
    res: RefreshDownloadUrlResult
  }
  [IpcChannel.RemoveDownload]: { req: RemoveDownloadRequest; res: { removed: DownloadId[] } }
  [IpcChannel.SetPriority]: { req: SetPriorityRequest; res: Download }
  [IpcChannel.SetSpeedLimit]: { req: SetSpeedLimitRequest; res: Download }
  [IpcChannel.SetUploadSpeedLimit]: { req: SetSpeedLimitRequest; res: Download }
  [IpcChannel.SetDownloadQuota]: { req: SetDownloadQuotaRequest; res: Download }
  [IpcChannel.GetTorrentFiles]: { req: { id: DownloadId }; res: TorrentFileView[] | null }
  [IpcChannel.SetTorrentFiles]: { req: { id: DownloadId; indexes: number[] }; res: Download }
  [IpcChannel.SelectTorrentFile]: {
    req: Record<string, never>
    res: { fileName: string; metainfo: string; sha256: string } | null
  }
  [IpcChannel.MoveUp]: { req: { id: DownloadId }; res: Download[] }
  [IpcChannel.MoveDown]: { req: { id: DownloadId }; res: Download[] }
  [IpcChannel.Reorder]: { req: ReorderRequest; res: Download[] }
  [IpcChannel.PauseAll]: { req: void; res: Download[] }
  [IpcChannel.ResumeAll]: { req: void; res: Download[] }
  [IpcChannel.ClearCompleted]: { req: Record<string, never>; res: { removed: DownloadId[] } }
  [IpcChannel.SetStatus]: { req: SetStatusRequest; res: Download }
  [IpcChannel.ListQueuePlans]: { req: void; res: QueuePlan[] }
  [IpcChannel.CreateQueuePlan]: { req: CreateQueuePlanRequest; res: QueuePlan[] }
  [IpcChannel.CancelQueuePlan]: { req: QueuePlanIdRequest; res: QueuePlan[] }
  [IpcChannel.RemoveQueuePlan]: { req: QueuePlanIdRequest; res: QueuePlan[] }
  [IpcChannel.VerifyDownload]: { req: { id: DownloadId }; res: DownloadVerificationResult }
  [IpcChannel.RevealFile]: { req: { id: DownloadId }; res: boolean }
  [IpcChannel.OpenContainingFolder]: { req: { id: DownloadId }; res: boolean }
  [IpcChannel.OpenFile]: { req: { id: DownloadId }; res: boolean }
  [IpcChannel.GetSettings]: { req: void; res: AppSettings }
  [IpcChannel.SetSettings]: { req: Partial<AppSettings>; res: AppSettings }
  [IpcChannel.GetStats]: { req: void; res: EngineStats }
  [IpcChannel.RunRecovery]: { req: void; res: RecoveryReportEvent }
  [IpcChannel.RescanDisk]: { req: { id?: DownloadId }; res: DiskRescanResult }
  [IpcChannel.SelectDirectory]: { req: { title?: string }; res: string | null }
  [IpcChannel.PrepareDiagnosticReport]: {
    req: void
    res: { id: string; preview: string }
  }
  [IpcChannel.DiscardDiagnosticReport]: { req: { id: string }; res: void }
  [IpcChannel.SaveDiagnosticReport]: { req: { id: string; reviewed: boolean }; res: string | null }
  [IpcChannel.OpenLogsFolder]: { req: void; res: boolean }
  [IpcChannel.GetAppInfo]: { req: void; res: AppInfo }
  [IpcChannel.GetDiskUsage]: { req: void; res: DiskUsage | null }
  [IpcChannel.GetPaths]: { req: void; res: { userData: string; downloads: string; logs: string } }
  [IpcChannel.GetIngestInfo]: { req: void; res: IngestInfo }
  [IpcChannel.OpenExtensionFolder]: { req: void; res: boolean }
  [IpcChannel.PrepareExtensionSetup]: { req: void; res: string }
  [IpcChannel.RegenerateToken]: { req: void; res: IngestInfo }
  [IpcChannel.InstallExtension]: { req: ExtensionInstallRequest; res: InstallExtensionResult }
  [IpcChannel.GetExtensionStatus]: { req: void; res: ExtensionStatusResult }
  [IpcChannel.GetDeepLinkStatus]: { req: void; res: DeepLinkRegistration }
  [IpcChannel.RegisterDeepLink]: { req: void; res: DeepLinkRegistration }
  [IpcChannel.GetMediaMetadata]: { req: { id: DownloadId }; res: MediaMetadataView | null }
  [IpcChannel.SetMediaMetadata]: {
    req: { id: DownloadId; patch: MediaMetadataPatch }
    res: MediaMetadataView | null
  }
  [IpcChannel.WriteMediaTags]: { req: { id: DownloadId }; res: MediaWriteResult }
  [IpcChannel.WindowAction]: { req: WindowActionRequest; res: boolean }
  [IpcChannel.QuitApp]: { req: void; res: void }
}

export interface IpcEventMap {
  [IpcEvent.DownloadUpserted]: Download
  [IpcEvent.DownloadRemoved]: { ids: DownloadId[] }
  [IpcEvent.DownloadProgress]: DownloadProgressEvent
  [IpcEvent.DownloadFinished]: DownloadFinishedEvent
  [IpcEvent.DownloadFailed]: DownloadFailedEvent
  [IpcEvent.DownloadLog]: { id: DownloadId; line: string }
  [IpcEvent.EngineStats]: EngineStats
  [IpcEvent.SpeedHistory]: { samples: SpeedSample[] }
  [IpcEvent.SettingsChanged]: AppSettings
  [IpcEvent.LogLine]: LogLine
  [IpcEvent.RecoveryReport]: RecoveryReportEvent
  [IpcEvent.MediaUpdated]: { id: DownloadId }
  [IpcEvent.SchedulerFired]: { id: DownloadId; at: number }
  [IpcEvent.ThemeChanged]: { theme: AppSettings['theme'] }
  [IpcEvent.QueuePlansChanged]: QueuePlan[]
}

export const isIpcChannel = (name: string): name is IpcChannelName =>
  (Object.values(IpcChannel) as string[]).includes(name)

export const isIpcEvent = (name: string): name is IpcEventName =>
  (Object.values(IpcEvent) as string[]).includes(name)
