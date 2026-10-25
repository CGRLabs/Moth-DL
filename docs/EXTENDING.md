# Extending Moth

Where to add things, and what guarantees to preserve while doing it. For the
process layout see [ARCHITECTURE.md](ARCHITECTURE.md).

## Where to add things

- **New protocol** — implement a module with the same shape as
  `src/main/net/httpClient.ts` (`probe` + `openRange`). `DownloadTask` needs no
  changes.
- **New integrity algorithm** — add the algorithm name to `ChecksumAlgorithm`,
  map it in `src/main/util/checksum.ts`, and add it to the settings schema.
- **New category** — add the key to `CATEGORY_EXTENSIONS` in
  `src/shared/constants.ts`. Extension lists and the UI folder mapping both
  derive from it.
- **New tag field** — add it to `MediaTags` in `src/shared/media.ts`, then to
  the readers, the writers and `mediaRepository.ts`. Every field is nullable and
  nullable means "leave what is there", so a new field is backwards compatible
  by construction.
- **New UI panel** — subscribe via `window.moth.on.*`; each returns an
  unsubscribe function, so a React effect cleans up with no manual bookkeeping.

## Invariants that must not regress

These are load-bearing. Changing them can silently corrupt user downloads:

- **fsync before commit.** Never mark a chunk `complete` in the database before
  its bytes are durable on disk.
- **Source identity checks.** When resuming, the remote file must still match
  the stored `ETag` / `Last-Modified` via `If-Range`. If it changed, discard
  progress rather than mixing bytes from two versions.
- **Staged promotion.** In-flight files are `.mothpart` and only renamed to the
  final name after verification succeeds.
- **Path containment.** Every path derived from remote input must pass through
  `resolveWithin` so a hostile `Content-Disposition` cannot escape the download
  root.
- **Secret redaction.** Signed query strings, URL credentials, and
  cookie/authorization values are redacted before any log record reaches disk.
- **Validate at the boundary.** The renderer is untrusted; every IPC payload is
  parsed with a zod schema before it reaches the engine.
- **Never bind `0.0.0.0`.** The ingest server is loopback-only. A download
  manager that accepts commands from the LAN is a remote code execution vector.

## Tests

Run the narrowest affected tests first. For transfer or recovery changes,
prefer real local HTTP servers, temporary files, and the test database over
mocks. Keep automated tests independent of any live provider.

Before finishing:

```bash
npm run typecheck
npm test
npm run test:extension
npm --prefix cli test
```