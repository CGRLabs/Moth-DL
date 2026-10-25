import { describe, expect, it } from 'vitest'
import { createDiagnosticReport } from '../../src/main/diagnostics/report.js'
import { diagnosticReportSaveSchema } from '../../src/shared/schemas.js'

describe('diagnostic report', () => {
  it('aggregates useful status and error categories without exposing download details', () => {
    const noisyFailure = {
      status: 'failed' as const,
      errorCode: 'NETWORK' as const,
      url: 'https://private.example/file?token=top-secret',
      filename: 'private-file.zip',
      finalPath: 'C:\\Users\\alice\\Downloads\\private-file.zip',
      errorMessage: 'Request failed for https://private.example/file?token=top-secret'
    }
    const report = createDiagnosticReport({
      generatedAt: '2026-05-06T12:00:00.000Z',
      app: {
        version: '1.0.0',
        electron: '44.0.0',
        chrome: '140.0.0',
        node: '22.5.0',
        platform: 'win32',
        architecture: 'x64'
      },
      settings: {
        maxConcurrentDownloads: 4,
        defaultConnections: 8,
        chunkSize: 4 * 1024 * 1024,
        maxRetries: 5,
        logLevel: 'info'
      },
      downloads: [
        noisyFailure,
        { status: 'failed', errorCode: null },
        { status: 'completed', errorCode: null }
      ]
    })
    const serialized = JSON.stringify(report)

    expect(report.downloads).toEqual({
      total: 3,
      byStatus: { failed: 2, completed: 1 },
      failuresByCode: { NETWORK: 1, UNKNOWN: 1 }
    })
    expect(serialized).not.toContain('private.example')
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('private-file.zip')
    expect(serialized).not.toContain('C:\\Users\\alice')
    expect(report.privacy).toEqual({
      includesDownloadUrls: false,
      includesFilenames: false,
      includesLocalPaths: false,
      includesLogs: false,
      includesCredentials: false,
      automaticUpload: false
    })
  })

  it('requires explicit reviewed confirmation before a report can be saved', () => {
    expect(
      diagnosticReportSaveSchema.safeParse({
        id: 'b32df6e3-d4cb-4ad7-8de8-9af351e5ad9b',
        reviewed: true
      }).success
    ).toBe(true)
    expect(
      diagnosticReportSaveSchema.safeParse({
        id: 'b32df6e3-d4cb-4ad7-8de8-9af351e5ad9b',
        reviewed: false
      }).success
    ).toBe(false)
  })
})
