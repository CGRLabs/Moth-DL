import type { AppSettings, Download } from '@shared/types.js'

export interface DiagnosticReportInput {
  generatedAt: string
  app: {
    version: string
    electron: string
    chrome: string
    node: string
    platform: string
    architecture: string
  }
  settings: Pick<
    AppSettings,
    'maxConcurrentDownloads' | 'defaultConnections' | 'chunkSize' | 'maxRetries' | 'logLevel'
  >
  downloads: Pick<Download, 'status' | 'errorCode'>[]
}

export interface DiagnosticReport {
  generatedAt: string
  app: DiagnosticReportInput['app']
  settings: DiagnosticReportInput['settings']
  downloads: {
    total: number
    byStatus: Record<string, number>
    failuresByCode: Record<string, number>
  }
  privacy: {
    includesDownloadUrls: false
    includesFilenames: false
    includesLocalPaths: false
    includesLogs: false
    includesCredentials: false
    automaticUpload: false
  }
}

export function createDiagnosticReport(input: DiagnosticReportInput): DiagnosticReport {
  const byStatus: Record<string, number> = {}
  const failuresByCode: Record<string, number> = {}

  for (const download of input.downloads) {
    byStatus[download.status] = (byStatus[download.status] ?? 0) + 1
    if (download.status === 'failed') {
      const code = download.errorCode ?? 'UNKNOWN'
      failuresByCode[code] = (failuresByCode[code] ?? 0) + 1
    }
  }

  return {
    generatedAt: input.generatedAt,
    app: input.app,
    settings: input.settings,
    downloads: {
      total: input.downloads.length,
      byStatus,
      failuresByCode
    },
    privacy: {
      includesDownloadUrls: false,
      includesFilenames: false,
      includesLocalPaths: false,
      includesLogs: false,
      includesCredentials: false,
      automaticUpload: false
    }
  }
}
