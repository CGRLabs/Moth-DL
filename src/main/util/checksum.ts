/**
 * Cryptographic and integrity verification.
 *
 * Two capabilities:
 *  1. Whole-file streaming digest, computed without ever holding the file in
 *     memory (handles multi-GB ISOs comfortably).
 *  2. Byte-range digest, used to prove that a specific chunk on disk is intact
 *     after a crash without re-reading the entire file.
 *
 * `fast` maps to CRC-32: not cryptographic, but it reliably detects the bit rot
 * and torn writes that a crash mid-download actually produces.
 */

import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { createReadStream as createFsReadStream } from 'node:fs'
import type { ChecksumAlgorithm, ChecksumSpec } from '@shared/types.js'
import { EngineError, fromFileSystemError } from './errors.js'

const READ_BUFFER = 1 << 20 // 1 MiB

export const ALGORITHM_LABELS: Record<ChecksumAlgorithm, string> = {
  fast: 'CRC-32',
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha512: 'SHA-512'
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buf: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < buf.length; i += 1) {
    // The index must be masked to a byte: `crc` exceeds 255 after the first
    // byte, and an unmasked lookup would fall off the 256-entry table and
    // silently produce a non-standard digest.
    const index = (crc ^ (buf[i] as number)) & 0xff
    crc = (CRC_TABLE[index] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** `true` for the hash algorithms implemented with `node:crypto`. */
export function isCryptoAlgorithm(algorithm: ChecksumAlgorithm): boolean {
  return algorithm !== 'fast'
}

/** Hex digest of a buffer. */
export function hashBuffer(data: Uint8Array, algorithm: ChecksumAlgorithm): string {
  if (algorithm === 'fast') {
    return crc32(data).toString(16).padStart(8, '0')
  }
  return createHash(algorithm).update(data).digest('hex')
}

/**
 * Incrementally digests a byte range of an already-open file.
 * `end` is inclusive, matching the chunk model.
 */
export async function hashRange(
  filePath: string,
  start: number,
  end: number,
  algorithm: ChecksumAlgorithm = 'sha256'
): Promise<string> {
  if (end < start) return hashBuffer(Buffer.alloc(0), algorithm)

  const cryptoAlgo = algorithm === 'fast' ? null : algorithm
  const hash = cryptoAlgo ? createHash(cryptoAlgo) : null
  let crc = 0

  const stream = createFsReadStream(filePath, {
    start,
    end,
    highWaterMark: READ_BUFFER
  })

  await new Promise<void>((resolve, reject) => {
    // `createReadStream` can emit strings if an encoding were set; it is not,
    // but the type allows it, so normalise defensively.
    stream.on('data', (raw: string | Buffer) => {
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw
      if (hash) hash.update(chunk)
      else crc = crc32(chunk, crc)
    })
    stream.on('error', reject)
    stream.on('end', resolve)
  })

  return hash ? hash.digest('hex') : crc.toString(16).padStart(8, '0')
}

export interface HashProgress {
  bytesHashed: number
  totalBytes: number
}

export interface HashResult {
  algorithm: ChecksumAlgorithm
  value: string
  bytesHashed: number
  durationMs: number
}

/**
 * Streams an entire file and returns its digest.
 * `onProgress` is throttled by the caller; this fires per buffer.
 */
export async function hashFile(
  filePath: string,
  algorithm: ChecksumAlgorithm = 'sha256',
  onProgress?: (progress: HashProgress) => void,
  signal?: AbortSignal
): Promise<HashResult> {
  const startedAt = Date.now()
  const cryptoAlgo = algorithm === 'fast' ? null : algorithm
  const hash = cryptoAlgo ? createHash(cryptoAlgo) : null
  let crc = 0
  let bytesHashed = 0

  const stream = createFsReadStream(filePath, { highWaterMark: READ_BUFFER })

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      stream.destroy()
      reject(new EngineError({ code: 'CANCELED', message: 'Hashing canceled' }))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })

  const readPromise = new Promise<void>((resolve, reject) => {
    stream.on('data', (raw: string | Buffer) => {
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw
      bytesHashed += chunk.length
      if (hash) hash.update(chunk)
      else crc = crc32(chunk, crc)
      onProgress?.({ bytesHashed, totalBytes: bytesHashed })
    })
    stream.on('error', (err) => reject(fromFileSystemError(err, filePath)))
    stream.on('end', resolve)
  })

  try {
    await Promise.race([readPromise, abortPromise])
  } finally {
    signal?.removeEventListener('abort', () => {})
    stream.destroy()
  }

  return {
    algorithm,
    value: hash ? hash.digest('hex') : crc.toString(16).padStart(8, '0'),
    bytesHashed,
    durationMs: Date.now() - startedAt
  }
}

export interface VerificationResult {
  ok: boolean
  algorithm: ChecksumAlgorithm
  actual: string
  expected: string | null
  /** Set when the user supplied no digest, so nothing could be compared. */
  unverified: boolean
}

/**
 * Verifies a file against an expected digest.
 * A missing expectation is *not* a failure: the digest is still computed and
 * returned so it can be recorded as a baseline for later corruption checks.
 */
export async function verifyFile(
  filePath: string,
  spec: ChecksumSpec | null,
  onProgress?: (progress: HashProgress) => void,
  signal?: AbortSignal
): Promise<VerificationResult> {
  const algorithm = spec?.algorithm ?? 'sha256'
  const result = await hashFile(filePath, algorithm, onProgress, signal)
  const expected = spec?.value?.toLowerCase() ?? null

  if (expected === null) {
    return { ok: true, algorithm, actual: result.value, expected: null, unverified: true }
  }
  return {
    ok: timingSafeEqualHex(result.value, expected),
    algorithm,
    actual: result.value,
    expected,
    unverified: false
  }
}

/** Length-independent comparison; avoids leaking digest contents via timing. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** Extracts a digest from `sha256(...)`, a bare hex string, or `filename:hash`. */
export function parseChecksumInput(
  input: string
): { algorithm: ChecksumAlgorithm; value: string } | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // "sha256=abc..." / "md5 abc..." / "sha512:abc..."
  const prefixed = /^(md5|sha1|sha256|sha512|crc32|fast)\s*[=:]\s*([a-fA-F0-9]+)$/i.exec(trimmed)
  if (prefixed) {
    const raw = prefixed[1] as string
    const algorithm: ChecksumAlgorithm = raw.toLowerCase() === 'crc32' ? 'fast' : (raw.toLowerCase() as ChecksumAlgorithm)
    return { algorithm, value: (prefixed[2] as string).toLowerCase() }
  }

  // "sha256(abc...)" as used by .sha256sum files
  const paren = /^(md5|sha1|sha256|sha512)\(([a-fA-F0-9]+)\)$/i.exec(trimmed)
  if (paren) {
    return {
      algorithm: (paren[1] as string).toLowerCase() as ChecksumAlgorithm,
      value: (paren[2] as string).toLowerCase()
    }
  }

  // Bare hex: infer the algorithm from the digest length.
  const bare = /^[a-fA-F0-9]+$/.test(trimmed) ? trimmed.toLowerCase() : null
  if (bare) {
    switch (bare.length) {
      case 8:
        return { algorithm: 'fast', value: bare }
      case 32:
        return { algorithm: 'md5', value: bare }
      case 40:
        return { algorithm: 'sha1', value: bare }
      case 64:
        return { algorithm: 'sha256', value: bare }
      case 128:
        return { algorithm: 'sha512', value: bare }
      default:
        return null
    }
  }
  return null
}

/** True when a chunk digest matches what we expect (used by crash recovery). */
export function digestMatches(actual: string, expected: string): boolean {
  return timingSafeEqualHex(actual.toLowerCase(), expected.toLowerCase())
}

/** Reads the size of a file, or `null` when it does not exist. */
export async function safeFileSize(filePath: string): Promise<number | null> {
  try {
    const handle = await open(filePath, 'r')
    try {
      const info = await handle.stat()
      return info.size
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}
