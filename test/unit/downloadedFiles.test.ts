import { describe, expect, it } from 'vitest'
import { selectDownloadedFiles, type DownloadedFileRecord } from '../../src/shared/downloadedFiles.js'

function file(overrides: Partial<DownloadedFileRecord> = {}): DownloadedFileRecord {
  return {
    status: 'completed',
    filename: 'sample.mp4',
    finalPath: 'D:/Downloads/Video/sample.mp4',
    category: 'video',
    completedAt: 100,
    updatedAt: 100,
    metadata: { title: 'Sample video' },
    ...overrides
  }
}

describe('downloaded files selection', () => {
  it('includes only completed download records', () => {
    const complete = file()
    expect(selectDownloadedFiles([complete, file({ status: 'paused' }), file({ status: 'failed' })], ''))
      .toEqual([complete])
  })

  it('searches names, local destinations, categories and media titles case-insensitively', () => {
    const downloads = [file(), file({
      filename: 'report.pdf',
      finalPath: 'D:/Downloads/Documents/report.pdf',
      category: 'document',
      metadata: { title: null }
    })]
    expect(selectDownloadedFiles(downloads, 'VIDEO')).toEqual([downloads[0]])
    expect(selectDownloadedFiles(downloads, 'downloads')).toEqual(downloads)
    expect(selectDownloadedFiles(downloads, 'sample video')).toEqual([downloads[0]])
  })

  it('sorts by completion time, falling back to the last update', () => {
    const older = file({ filename: 'older.bin', completedAt: 10, updatedAt: 80 })
    const newest = file({ filename: 'newest.bin', completedAt: null, updatedAt: 90 })
    expect(selectDownloadedFiles([older, newest], '').map((entry) => entry.filename))
      .toEqual(['newest.bin', 'older.bin'])
  })

  it('filters completed files by category without changing the default all-files view', () => {
    const files = [
      file(),
      file({ filename: 'song.mp3', category: 'audio' }),
      file({ filename: 'pending.mp4', status: 'paused' })
    ]
    expect(selectDownloadedFiles(files, '')).toEqual(files.slice(0, 2))
    expect(selectDownloadedFiles(files, '', 'audio')).toEqual([files[1]])
    expect(selectDownloadedFiles(files, 'no-match', 'audio')).toEqual([])
  })
})