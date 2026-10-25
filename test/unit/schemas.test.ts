import { describe, expect, it } from 'vitest';
import {
  addDownloadSchema,
  chunkSizeSchema,
  connectionsSchema,
  createQueuePlanSchema,
  filenameSchema,
  parseOrThrow,
  playlistThumbnailSchema,
  settingsPatchSchema,
} from '../../src/shared/schemas.js';
import { DEFAULT_CATEGORY_FOLDERS } from '../../src/shared/constants.js';

describe('addDownloadSchema', () => {
  it('accepts a good https URL', () => {
    const out = addDownloadSchema.parse({ url: 'https://example.com/file.zip' });
    expect(out.url).toBe('https://example.com/file.zip');
  });

  it('REJECTS file: URLs (deliberate safety guard)', () => {
    expect(
      addDownloadSchema.safeParse({ url: 'file:///etc/passwd' }).success,
    ).toBe(false);
  });

  it('REJECTS javascript: URLs (deliberate safety guard)', () => {
    expect(
      addDownloadSchema.safeParse({ url: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });

  it('REJECTS non-URLs without throwing', () => {
    // Zod runs `.refine()` even when `.url()` on the same string has already
    // failed, so the refine must tolerate unparseable input. If it does not,
    // `safeParse` throws a TypeError and takes down the IPC handler.
    const result = addDownloadSchema.safeParse({ url: 'not a url' });
    expect(result.success).toBe(false);
    expect(() => addDownloadSchema.parse({ url: 'not a url' })).toThrow();

    // A well-formed but non-http(s) URL fails cleanly too.
    expect(addDownloadSchema.safeParse({ url: 'ftp://example.com/file' }).success).toBe(
      false,
    );
  });

  it('REJECTS URLs longer than 4096 chars', () => {
    const long = `https://example.com/${'a'.repeat(5000)}`;
    expect(addDownloadSchema.safeParse({ url: long }).success).toBe(false);
  });

  it('strips range/host/content-length from headers but keeps custom ones', () => {
    const out = addDownloadSchema.parse({
      url: 'https://example.com/file.zip',
      headers: {
        range: 'bytes=0-1',
        host: 'evil.example',
        'content-length': '5',
        'x-custom': 'keep',
      },
    });
    expect(out.headers).toEqual({ 'x-custom': 'keep' });
  });
});

describe('filenameSchema', () => {
  it('accepts a plain filename', () => {
    expect(filenameSchema.safeParse('report.pdf').success).toBe(true);
  });

  it.each(['a/b', '..', 'CON.txt', 'a:b', 'a*b', ''])(
    'rejects %j (deliberate safety guard)',
    (name: string) => {
      expect(filenameSchema.safeParse(name).success).toBe(false);
    },
  );
});

describe('playlistThumbnailSchema', () => {
  it('accepts bounded HTTPS URLs from known image hosts', () => {
    expect(playlistThumbnailSchema.safeParse({ url: 'https://i.ytimg.com/vi/id/default.jpg' }).success).toBe(true);
    expect(playlistThumbnailSchema.safeParse({ url: `https://${'a'.repeat(2050)}.ytimg.com/image` }).success).toBe(false);
  });

  it.each([
    'http://i.ytimg.com/vi/id/default.jpg',
    'https://attacker.example/image.jpg',
    'https://i.ytimg.com:8443/image.jpg',
    'https://user@i.ytimg.com/image.jpg'
  ])('rejects untrusted thumbnail URL %s', (url) => {
    expect(playlistThumbnailSchema.safeParse({ url }).success).toBe(false);
  });
});

describe('connectionsSchema and chunkSizeSchema', () => {
  it('accepts 1..32 connections and rejects outside', () => {
    expect(connectionsSchema.safeParse(1).success).toBe(true);
    expect(connectionsSchema.safeParse(32).success).toBe(true);
    expect(connectionsSchema.safeParse(0).success).toBe(false);
    expect(connectionsSchema.safeParse(33).success).toBe(false);
  });

  it('accepts 64 KiB..64 MiB chunks and rejects outside', () => {
    expect(chunkSizeSchema.safeParse(64 * 1024).success).toBe(true);
    expect(chunkSizeSchema.safeParse(64 * 1024 * 1024).success).toBe(true);
    expect(chunkSizeSchema.safeParse(1024).success).toBe(false);
    expect(chunkSizeSchema.safeParse(64 * 1024 * 1024 + 1).success).toBe(false);
  });
});

describe('settingsPatchSchema', () => {
  it('accepts a partial patch', () => {
    expect(settingsPatchSchema.safeParse({}).success).toBe(true);
    expect(
      settingsPatchSchema.safeParse({ autoCategorize: false }).success,
    ).toBe(true);
  });

  it('rejects a negative globalSpeedLimit', () => {
    expect(
      settingsPatchSchema.safeParse({ globalSpeedLimit: -1 }).success,
    ).toBe(false);
  });

  it('rejects an unknown theme value', () => {
    expect(settingsPatchSchema.safeParse({ theme: 'neon' }).success).toBe(false);
  });

  it('accepts the completion-notification preference', () => {
    expect(settingsPatchSchema.safeParse({ notifyOnDownloadComplete: false }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ notifyOnDownloadComplete: 'false' }).success).toBe(false);
  });

  it('accepts long absolute destinations for category folders', () => {
    expect(
      settingsPatchSchema.safeParse({
        categoryFolders: {
          ...DEFAULT_CATEGORY_FOLDERS,
          video: `C:\\Media\\${'folder\\'.repeat(40)}`,
        },
      }).success,
    ).toBe(true);
    expect(
      settingsPatchSchema.safeParse({
        categoryFolders: {
          ...DEFAULT_CATEGORY_FOLDERS,
          video: 'x'.repeat(4097),
        },
      }).success,
    ).toBe(false);
  });
});

describe('createQueuePlanSchema', () => {
  it('accepts a bounded plan and normalizes its name', () => {
    const result = createQueuePlanSchema.safeParse({
      name: '  Overnight  ',
      downloadIds: ['download_1'],
      startsAt: Date.now(),
      durationMinutes: 480,
      strategy: 'smallest-first',
      endAction: 'pause',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('Overnight');
  });

  it('rejects duplicate download IDs, empty plans, and invalid choices', () => {
    const base = {
      name: 'Plan',
      downloadIds: ['download_1'],
      startsAt: Date.now(),
      durationMinutes: 60,
      strategy: 'queue-order',
      endAction: 'continue',
    };
    expect(createQueuePlanSchema.safeParse({ ...base, downloadIds: ['download_1', 'download_1'] }).success).toBe(false);
    expect(createQueuePlanSchema.safeParse({ ...base, downloadIds: [] }).success).toBe(false);
    expect(createQueuePlanSchema.safeParse({ ...base, strategy: 'fastest' }).success).toBe(false);
    expect(createQueuePlanSchema.safeParse({ ...base, durationMinutes: 0 }).success).toBe(false);
  });
});

describe('parseOrThrow', () => {
  it('returns the parsed value on success', () => {
    expect(parseOrThrow(filenameSchema, 'ok.txt', 'filename')).toBe('ok.txt');
  });

  it('throws a message containing the label on failure', () => {
    expect(() => parseOrThrow(filenameSchema, 'a/b', 'filename')).toThrow(/filename/);
  });
});
