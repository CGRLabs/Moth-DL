import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  crc32,
  hashBuffer,
  hashFile,
  hashRange,
  parseChecksumInput,
  timingSafeEqualHex,
  verifyFile,
} from '../../src/main/util/checksum.js';

let dir = '';
const files: string[] = [];

async function makeTempFile(name: string, data: Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  files.push(path);
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'moth-checksum-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('crc32', () => {
  it('matches the CRC-32/ISO-HDLC check value for "123456789"', () => {
    // The canonical check value. This pins the table index to `& 0xff`;
    // without the mask `crc` exceeds 255 after the first byte and the lookup
    // falls off the 256-entry table, yielding a non-standard digest.
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
  });

  it('hashes the empty input to zero', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('hashBuffer', () => {
  it("maps 'fast' to the zero-padded CRC-32 hex", () => {
    expect(hashBuffer(Buffer.from('123456789', 'ascii'), 'fast')).toBe('cbf43926');
  });

  it('delegates sha256 to node:crypto', () => {
    const data = Buffer.from('hello moth', 'utf8');
    expect(hashBuffer(data, 'sha256')).toBe(
      createHash('sha256').update(data).digest('hex'),
    );
  });
});

describe('hashRange', () => {
  it('matches the digest of the equivalent subarray (end inclusive)', async () => {
    const data = Buffer.from('0123456789abcdef', 'ascii');
    const path = await makeTempFile('range.bin', data);
    const expected = createHash('sha256').update(data.subarray(2, 6)).digest('hex');
    await expect(hashRange(path, 2, 5, 'sha256')).resolves.toBe(expected);
  });

  it('supports the fast algorithm over a range', async () => {
    const data = Buffer.from('0123456789abcdef', 'ascii');
    const path = await makeTempFile('range-fast.bin', data);
    await expect(hashRange(path, 0, 3, 'fast')).resolves.toBe(
      hashBuffer(data.subarray(0, 4), 'fast'),
    );
  });

  it('does not throw for an empty/inverted range', async () => {
    const data = Buffer.from('abcdef', 'ascii');
    const path = await makeTempFile('empty-range.bin', data);
    await expect(hashRange(path, 5, 2, 'sha256')).resolves.toBe(
      hashBuffer(Buffer.alloc(0), 'sha256'),
    );
  });
});

describe('hashFile', () => {
  it('returns the full-file sha256 digest', async () => {
    const data = Buffer.from('the quick brown fox', 'utf8');
    const path = await makeTempFile('full.bin', data);
    const result = await hashFile(path, 'sha256');
    expect(result.value).toBe(createHash('sha256').update(data).digest('hex'));
    expect(result.bytesHashed).toBe(data.length);
    expect(result.algorithm).toBe('sha256');
  });
});

describe('verifyFile', () => {
  it('returns ok:true for a matching digest', async () => {
    const data = Buffer.from('verify me', 'utf8');
    const path = await makeTempFile('ok.bin', data);
    const digest = createHash('sha256').update(data).digest('hex');
    const result = await verifyFile(path, { algorithm: 'sha256', value: digest });
    expect(result.ok).toBe(true);
    expect(result.unverified).toBe(false);
    expect(result.actual).toBe(digest);
  });

  it('returns ok:false for a mismatched digest', async () => {
    const data = Buffer.from('verify me', 'utf8');
    const path = await makeTempFile('bad.bin', data);
    const result = await verifyFile(path, {
      algorithm: 'sha256',
      value: '0'.repeat(64),
    });
    expect(result.ok).toBe(false);
    expect(result.unverified).toBe(false);
  });

  it('returns ok:true with unverified:true when no digest is supplied', async () => {
    const data = Buffer.from('no expectation', 'utf8');
    const path = await makeTempFile('none.bin', data);
    const result = await verifyFile(path, null);
    expect(result.ok).toBe(true);
    expect(result.unverified).toBe(true);
    expect(result.expected).toBeNull();
  });
});

describe('timingSafeEqualHex', () => {
  it('compares equal and unequal digests', () => {
    expect(timingSafeEqualHex('abc123', 'abc123')).toBe(true);
    expect(timingSafeEqualHex('abc123', 'abc124')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
  });
});

describe('parseChecksumInput', () => {
  it('infers the algorithm from bare hex length', () => {
    expect(parseChecksumInput('cbf43926')).toEqual({ algorithm: 'fast', value: 'cbf43926' });
    expect(parseChecksumInput('d'.repeat(32))).toEqual({
      algorithm: 'md5',
      value: 'd'.repeat(32),
    });
    expect(parseChecksumInput('e'.repeat(40))).toEqual({
      algorithm: 'sha1',
      value: 'e'.repeat(40),
    });
    expect(parseChecksumInput('f'.repeat(64))).toEqual({
      algorithm: 'sha256',
      value: 'f'.repeat(64),
    });
    expect(parseChecksumInput('a'.repeat(128))).toEqual({
      algorithm: 'sha512',
      value: 'a'.repeat(128),
    });
  });

  it('parses the prefixed sha256= form', () => {
    expect(parseChecksumInput(`sha256=${'b'.repeat(64)}`)).toEqual({
      algorithm: 'sha256',
      value: 'b'.repeat(64),
    });
  });

  it('parses the sha256(...) parenthesised form', () => {
    expect(parseChecksumInput(`sha256(${'c'.repeat(64)})`)).toEqual({
      algorithm: 'sha256',
      value: 'c'.repeat(64),
    });
  });

  it('returns null for garbage, empty or wrong-length hex', () => {
    expect(parseChecksumInput('not a checksum!!')).toBeNull();
    expect(parseChecksumInput('')).toBeNull();
    expect(parseChecksumInput('abc')).toBeNull();
  });
});
