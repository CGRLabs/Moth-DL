import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  categorize,
  categorizeContentType,
  extensionOf,
  resolveCategory,
  resolveDestinationDirectory,
} from '../../src/main/util/categorizer.js';
import type { DownloadCategory } from '../../src/shared/types.js';

const FOLDERS: Record<DownloadCategory, string> = {
  video: 'Video',
  audio: 'Music',
  document: 'Documents',
  archive: 'Archives',
  executable: 'Executables',
  image: 'Images',
  installer: 'Installers',
  other: 'Other',
};

describe('extensionOf', () => {
  it('lowercases uppercase extensions', () => {
    expect(extensionOf('VIDEO.MP4')).toBe('mp4');
  });

  it('strips query strings and fragments', () => {
    expect(extensionOf('movie.mkv?token=abc')).toBe('mkv');
    expect(extensionOf('song.mp3#t=10')).toBe('mp3');
  });

  it('ignores dots in directory components', () => {
    // Deliberate guard: only the last path segment is inspected.
    expect(extensionOf('my.dir/file')).toBe('');
    expect(extensionOf('my.dir/file.zip')).toBe('zip');
  });

  it('returns an empty string when there is no extension', () => {
    expect(extensionOf('README')).toBe('');
  });
});

describe('categorize', () => {
  it('maps mp4/mkv to video', () => {
    expect(categorize('movie.mp4')).toBe('video');
    expect(categorize('film.mkv')).toBe('video');
  });

  it('maps mp3/flac to audio', () => {
    expect(categorize('song.mp3')).toBe('audio');
    expect(categorize('track.flac')).toBe('audio');
  });

  it('maps pdf/docx to document', () => {
    expect(categorize('doc.pdf')).toBe('document');
    expect(categorize('report.docx')).toBe('document');
  });

  it('maps zip/7z/tar.gz to archive', () => {
    expect(categorize('a.zip')).toBe('archive');
    expect(categorize('b.7z')).toBe('archive');
    expect(categorize('c.tar.gz')).toBe('archive');
  });

  it('maps exe/msi/deb to executable', () => {
    expect(categorize('setup.exe')).toBe('executable');
    expect(categorize('app.msi')).toBe('executable');
    expect(categorize('pkg.deb')).toBe('executable');
  });

  it('maps png/svg to image', () => {
    expect(categorize('pic.png')).toBe('image');
    expect(categorize('icon.svg')).toBe('image');
  });

  it('falls back to other for unknown extensions', () => {
    expect(categorize('data.xyzunknown')).toBe('other');
    expect(categorize('README')).toBe('other');
  });

  it('matches the compound .tar.gz suffix before the bare .gz extension', () => {
    // extensionOf sees only "gz"; the compound table must win.
    expect(extensionOf('backup.tar.gz')).toBe('gz');
    expect(categorize('backup.tar.gz')).toBe('archive');
  });
});

describe('categorizeContentType', () => {
  it('maps video/* and audio/* prefixes', () => {
    expect(categorizeContentType('video/mp4')).toBe('video');
    expect(categorizeContentType('audio/mpeg')).toBe('audio');
  });

  it('maps application/zip to archive and application/pdf to document', () => {
    expect(categorizeContentType('application/zip')).toBe('archive');
    expect(categorizeContentType('application/pdf')).toBe('document');
  });

  it('ignores content-type parameters', () => {
    expect(categorizeContentType('text/html; charset=utf-8')).toBe('document');
  });

  it('returns null for unknown, null or undefined content types', () => {
    expect(categorizeContentType('application/octet-stream')).toBeNull();
    expect(categorizeContentType(null)).toBeNull();
    expect(categorizeContentType(undefined)).toBeNull();
  });
});

describe('resolveCategory', () => {
  it('lets an explicit choice win over the extension', () => {
    expect(
      resolveCategory({ filename: 'movie.mp4', explicit: 'audio', autoCategorize: true }),
    ).toBe('audio');
  });

  it('always yields other when autoCategorize is false, even with an explicit choice', () => {
    expect(
      resolveCategory({ filename: 'movie.mp4', explicit: 'video', autoCategorize: false }),
    ).toBe('other');
    expect(resolveCategory({ filename: 'movie.mp4', autoCategorize: false })).toBe(
      'other',
    );
  });

  it('falls back to the extension, then the content type', () => {
    expect(resolveCategory({ filename: 'song.mp3', autoCategorize: true })).toBe(
      'audio',
    );
    expect(
      resolveCategory({
        filename: 'download',
        contentType: 'video/mp4',
        autoCategorize: true,
      }),
    ).toBe('video');
    expect(resolveCategory({ filename: 'download', autoCategorize: true })).toBe(
      'other',
    );
  });
});

describe('resolveDestinationDirectory', () => {
  it('returns the root unchanged when autoCategorize is false', () => {
    expect(
      resolveDestinationDirectory({
        root: '/dl',
        category: 'video',
        categoryFolders: FOLDERS,
        autoCategorize: false,
        separator: '/',
      }),
    ).toBe('/dl');
  });

  it('joins root, separator and the category folder otherwise', () => {
    expect(
      resolveDestinationDirectory({
        root: '/dl',
        category: 'video',
        categoryFolders: FOLDERS,
        autoCategorize: true,
        separator: '/',
      }),
    ).toBe('/dl/Video');
  });

  it('trims trailing separators from the root before joining', () => {
    expect(
      resolveDestinationDirectory({
        root: '/dl/',
        category: 'audio',
        categoryFolders: FOLDERS,
        autoCategorize: true,
        separator: '/',
      }),
    ).toBe('/dl/Music');
  });

  it('uses an absolute category folder as a custom destination', () => {
    expect(
      resolveDestinationDirectory({
        root: '/dl',
        category: 'video',
        categoryFolders: { ...FOLDERS, video: '/media/videos' },
        autoCategorize: true,
        separator: '/',
      }),
    ).toBe(resolve('/media/videos'));
  });

  it('keeps relative folder values as single child names under the download root', () => {
    expect(
      resolveDestinationDirectory({
        root: '/dl',
        category: 'video',
        categoryFolders: { ...FOLDERS, video: '../outside' },
        autoCategorize: true,
        separator: '/',
      }),
    ).toBe('/dl/outside');
  });
});
