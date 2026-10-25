import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filenameFromContentDisposition,
  filenameFromUrl,
  finalPathFromPartial,
  isWithin,
  partialPathFor,
  resolveWithin,
  sanitizeFilename,
  uniquePath,
} from '../../src/main/util/paths.js';
import { PARTIAL_SUFFIX } from '../../src/shared/constants.js';

describe('sanitizeFilename', () => {
  it('strips directory components and traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a/b/c.zip')).toBe('c.zip');
    expect(sanitizeFilename('..\\windows\\evil.exe')).toBe('evil.exe');
  });

  it('neutralises Windows reserved names', () => {
    // Deliberate guard: CON/AUX/etc would otherwise hit real devices.
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFilename('lpt1')).toBe('_lpt1');
    expect(sanitizeFilename('aux.doc')).toBe('_aux.doc');
  });

  it('replaces illegal characters with underscores', () => {
    expect(sanitizeFilename('a:b*c?d')).toBe('a_b_c_d');
    expect(sanitizeFilename('x<y>|z')).toBe('x_y__z');
  });

  it('strips trailing dots and spaces', () => {
    expect(sanitizeFilename('name.')).toBe('name');
    expect(sanitizeFilename('name...')).toBe('name');
  });

  it('falls back for empty or dots-only input', () => {
    expect(sanitizeFilename('')).toBe('download');
    expect(sanitizeFilename('...')).toBe('download');
    expect(sanitizeFilename('', 'file')).toBe('file');
  });

  it('truncates over-long names while keeping a short extension', () => {
    const long = `${'a'.repeat(300)}.txt`;
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith('.txt')).toBe(true);
  });
});

describe('filenameFromUrl', () => {
  it('takes the last path segment', () => {
    expect(filenameFromUrl('https://example.com/files/report.pdf')).toBe('report.pdf');
  });

  it('percent-decodes the segment', () => {
    expect(filenameFromUrl('https://example.com/my%20file.zip')).toBe('my file.zip');
  });

  it('drops query strings', () => {
    expect(filenameFromUrl('https://example.com/dl/setup.exe?token=abc')).toBe(
      'setup.exe',
    );
  });

  it('falls back for a bare host or trailing slash', () => {
    expect(filenameFromUrl('https://example.com')).toBe('download');
    expect(filenameFromUrl('https://example.com/')).toBe('download');
  });
});

describe('filenameFromContentDisposition', () => {
  it('parses the quoted form', () => {
    expect(filenameFromContentDisposition('attachment; filename="report.pdf"')).toBe(
      'report.pdf',
    );
  });

  it('parses the RFC 5987 filename* form with percent-decoding', () => {
    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8''%E2%82%ACrates.pdf"),
    ).toBe('€rates.pdf');
  });

  it('parses the unquoted form', () => {
    expect(filenameFromContentDisposition('attachment; filename=setup.exe')).toBe(
      'setup.exe',
    );
  });

  it('returns null for null input or headers without a filename', () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition(undefined)).toBeNull();
    expect(filenameFromContentDisposition('attachment')).toBeNull();
  });
});

describe('partialPathFor / finalPathFromPartial', () => {
  it('round-trips through the partial suffix', () => {
    const final = join('C:', 'dl', 'a.zip');
    const partial = partialPathFor(final);
    expect(partial).toBe(`${final}${PARTIAL_SUFFIX}`);
    expect(finalPathFromPartial(partial)).toBe(final);
  });

  it('tolerates paths that are already final', () => {
    const final = join('C:', 'dl', 'a.zip');
    expect(finalPathFromPartial(final)).toBe(final);
  });
});

describe('resolveWithin', () => {
  const root = join('C:', 'dl', 'root');

  it('resolves a nested path inside the root', () => {
    const out = resolveWithin(root, 'sub', 'file.txt');
    expect(out).toBe(join(root, 'sub', 'file.txt'));
  });

  it('THROWS for ../escape traversal', () => {
    // Deliberate guard: a hostile filename must never escape the download root.
    expect(() => resolveWithin(root, '../escape')).toThrow();
    expect(() => resolveWithin(root, '..', '..', 'evil.txt')).toThrow();
  });
});

describe('isWithin', () => {
  const parent = join('C:', 'dl', 'root');

  it('returns true for children and the directory itself', () => {
    expect(isWithin(parent, join(parent, 'a.zip'))).toBe(true);
    expect(isWithin(parent, parent)).toBe(true);
  });

  it('returns false for siblings and parents', () => {
    expect(isWithin(parent, join('C:', 'dl', 'other', 'a.zip'))).toBe(false);
    expect(isWithin(parent, join('C:', 'dl'))).toBe(false);
  });
});

describe('uniquePath', () => {
  const desired = join('C:', 'dl', 'a.zip');

  it('returns the same path when it is free', async () => {
    const out = await uniquePath(desired, async () => false);
    expect(out).toBe(desired);
  });

  it('appends " (1)" then " (2)" when taken', async () => {
    const taken = new Set<string>([desired, join('C:', 'dl', 'a (1).zip')]);
    const out = await uniquePath(desired, async (p: string) => taken.has(p));
    expect(out).toBe(join('C:', 'dl', 'a (2).zip'));
  });

  it('appends " (1)" on the first collision', async () => {
    const taken = new Set<string>([desired]);
    const out = await uniquePath(desired, async (p: string) => taken.has(p));
    expect(out).toBe(join('C:', 'dl', 'a (1).zip'));
  });
});
