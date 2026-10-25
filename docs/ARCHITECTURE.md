# Architecture

Design notes and the reasoning behind the non-obvious decisions. For usage see
the [README](../README.md).

---

## 1. The durability contract

This is the part worth understanding before anything else, because every other
decision follows from it.

For sources with a usable identity validator, the product promise is:
*an interrupted download resumes safely and produces a byte-identical file*.
If the source cannot be validated, progress is discarded rather than risk
stitching different content versions. That durability claim is built around a
single invariant:

> A chunk is marked `complete` in SQLite only after its bytes have been
> `fsync`'d to disk.

Ordering matters in both directions:

- **fsync before commit** — the database can never claim bytes that are not on
  the platter. If power is lost after the commit, the bytes are genuinely there.
- **SQLite `synchronous=FULL` with WAL** — a committed row survives a hard
  power cut, not merely an app crash. `NORMAL` would be faster and would lose
  the most recent commits, which is exactly the data we cannot lose.
- **Sync failure is fatal to the barrier** — if the OS cannot confirm a flush,
  the task fails without completing that chunk. Cleanup persists pending
  in-flight progress only if its own final sync succeeds.

`DownloadTask.completeChunk()` implements the barrier:

```
await writer.sync()                          // bytes -> platter
checksum = await hashRange(...)              // digest the real bytes
repos.chunks.markComplete(id, checksum)      // durable commit
```

### Why progress is a bitmap, not a counter

A byte counter cannot distinguish "these bytes are on disk" from "these bytes
are in a buffer somewhere". A range bitmap can, once combined with the fsync
barrier: `status = 'complete'` means exactly those bytes are durable.

It also makes resume trivially correct under out-of-order completion. The
surviving set is a list of ranges, and the missing set is the complement — no
replay logic, no cursor arithmetic.

The live byte total is separate from that durable bitmap: it includes bytes
received across all active ranges as well as safely retained resume cursors.
Completing one range must not recalculate that total from completed ranges,
because doing so drops bytes still in flight on other workers and makes the
displayed speed spike or reset.

### Why in-flight chunks rewind

In-flight progress is checkpointed to the database (every ~1 s, after an fsync),
so a crash does not lose a whole chunk's worth of work. But a checkpoint is
*advisory*: the file may in principle contain more bytes than the last
checkpoint recorded.

Rather than trying to prove those extra bytes are intact, recovery and resume
both **rewind a fixed safety margin** (1 MiB) before restarting a partially
written range, and the re-downloaded bytes simply overwrite. Wasted bandwidth is
bounded at 1 MiB per interrupted chunk; the chance of a silent hole is zero.

This is a deliberate trade: correctness over a marginal bandwidth saving.

---

## 2. Zero native addons

Persistence uses Node's built-in `node:sqlite` rather than `better-sqlite3`.

| | native addon | built-in |
|---|---|---|
| Install | needs prebuilt binary or MSVC toolchain | nothing |
| ABI drift | breaks on Electron upgrades | none |
| User setup | can fail on a clean machine | cannot |
| Packaging | rebuild native modules per target | ships as-is |

`node:sqlite` is synchronous, which is exactly right here: SQLite writes are
microseconds, and a synchronous API removes an entire class of
"committed-but-not-yet-flushed" bugs from the recovery path. The driver is
wrapped behind `Database` so a different backend could be substituted without
touching repositories.

Verified on Electron 44.4.5 → Node 24.21.0 → SQLite 3.53.4. `scripts/postinstall.mjs`
asserts this at install time and explains the fix if it ever regresses.

---

## 3. Rate limiting: GCRA, not a token bucket

A textbook token bucket lets a paused-then-resumed download fire a multi-megabyte
burst that saturates the link and stalls every other connection — the opposite of
what a speed limit is for.

Moth uses GCRA (a leaky bucket / virtual-scheduling limiter). Each caller asks
for *n* bytes; the limiter keeps a "theoretical arrival time" (TAT) — the instant
the bucket would be full again. A request is admissible when
`TAT - burstTime <= now`, and it **reserves** its slot by advancing the TAT.

```
now = clock()
tatBase = max(TAT, now)
allowAt = tatBase - burst/rate * 1000
TAT     = tatBase + bytes/rate * 1000
return allowAt <= now ? 0 : ceil(allowAt - now)
```

Because the reservation is taken *before* the wait, concurrent connections are
paced in FIFO order rather than each independently bursting. The long-run rate
equals the limit exactly.

Two subtleties the tests pin down:

- **Burst is ~100 ms of traffic, not one second.** A one-second burst is a
  full second of unrestricted transfer after any pause — visibly bursty.
- **Burst must never have a large floor.** An early version floored it at
  64 KiB. Since the burst window is `burst/rate` seconds, a 64 KiB floor at
  512 kbps means a *65-second* burst window — every limit below ~512 kbps became
  a silent no-op. The floor is now 1 byte.

`CompositeRateLimiter` evaluates the global and per-download limiters in the same
pass and sleeps for the longer wait. Both reservations are taken up-front, so a
satisfied wait covers them: no re-check loop, and therefore no deadlock.

Per-download quota is a separate saved-byte ceiling, not a rate cap. When an
HTTP download's quota is below its known file size, the task uses one worker and
writes no more than the remaining quota from the final response buffer before
pausing. The existing writer sync and chunk-checkpoint ordering remains in
force, so the partial file can resume after the quota is raised or cleared.
Quota is not exposed for yt-dlp transfers because its progress reports cannot
enforce an exact byte cutoff. Speed limits apply to download traffic only.

---

## 4. Routing and concurrency

`core/router.ts` makes source and transfer selection explicit and deterministic:
direct URLs use the HTTP engine, requested media pages use the resolver, and
YouTube pages use yt-dlp. BitTorrent v1/v2 magnets and `.torrent` sources use
the isolated Transmission engine. Resolved HTTP streams use parallel ranges only when
the server advertises ranges and reports a positive size. A transfer is called
safely resumable only when the existing `If-Range` validator rules find a
usable strong ETag or `Last-Modified`; otherwise recovery discards unverified
progress. The router records the reason for its choice in the application log.

New links are persisted with `review` status before lookup begins. Direct-file
metadata probes and media-page resolution may populate the queue item, but do
not start a transfer until the user chooses **Start**; **Configure** updates
the persisted request before that choice. Review items are excluded from crash
recovery because no transfer has begun, and pending lookups are resumed after
restart without changing the review state.

Direct downloads use one `DownloadTask` per active transfer, each owning its
pool of chunk workers. YouTube downloads use a separate yt-dlp task lifecycle
for fragments, stream merging, normalization, and validation. Torrent jobs use
a separate Transmission RPC task; staging a torrent does not start the daemon.
Local metainfo is integrity-checked, and remote metainfo is fetched through
Moth's redirect-safe HTTP client with an 8 MiB bound. Both are kept in a
managed sidecar until the job is removed, so retries do not depend on the
original source still being available. The daemon verifies pieces, while Moth
stores output in a per-download directory and stops the torrent at completion
or task failure. Completion uses Transmission's wanted-file size and
`leftUntilDone`, so partial file selections finish correctly even when
Transmission reports the overall torrent as seeding. Torrent file selection
and per-torrent download/upload caps are sent through Transmission RPC. Torrent
jobs do not use HTTP range recovery, Moth's global
speed limiters or quotas. Windows x64 release packages include a pinned Transmission runtime
and its corresponding source archive; other platform packages do not yet bundle
it. The engine is otherwise single-threaded and communicates through repositories
and event callbacks.

Before yt-dlp resumes fragments, Moth compares a local SHA-256 fingerprint of
the source page, requested format and quality, forwarded headers, and configured
yt-dlp version. The fingerprint file contains no raw URL or credential values.
If identity cannot be read or stale fragments cannot be removed, the transfer
fails rather than allowing yt-dlp to continue with uncertain partial data.

That gives a clean answer to "who may mutate a download": **only the task that
owns it, or the engine.** A task never touches another task's state, and the
engine never reaches into a running transfer's byte counters.

```
Engine
 ├── router ──► direct HTTP ──► DownloadTask ──► openRange()/openFile()
 │                                      └──────► rateLimiter + SparseFileWriter
 ├── router ──► media resolver ──► resolved HTTP stream
 ├── router ──► YouTube ──► YtDlpDownloadTask ──► yt-dlp fragments + FFmpeg validation
 └── router ──► magnet / .torrent ──► Transmission RPC ──► piece-verified torrent directory
```

The HTTP worker pool pulls from a shared cursor over the pending chunk list, so
workers that finish early immediately take the next chunk instead of idling.
When a worker fails fatally it aborts the task; the engine decides whether the
whole download is retried.

`pumpQueue()` is re-entrancy guarded because it is called from a dozen places
(`resume`, `pauseAll`, `reorder`, task completion).

### Persistent queue plans

Queue plans are optional one-off windows persisted in SQLite. The engine owns
their start/end transitions and evaluates them on the same scheduler that
handles scheduled downloads, so closing and reopening the app does not lose a
future plan. A scheduled plan reserves its selected queued/paused downloads
from the ordinary queue until its window begins. While running, the selected
items are ordered either by existing queue priority or by known file size
(smallest first); the global concurrency and speed limits remain authoritative.

Only one plan may occupy any given time window, and a download cannot be
reserved by two pending plans. At the window end, the plan either pauses
unfinished members or releases them to normal queue ordering. The plan feature
does not allocate bandwidth between transfers and makes no completion-time
guarantee. If the app restarts during an active plan, the engine re-queues
interrupted selected items after recovery; a plan that expired while the app
was closed applies its configured end action on startup.

### Queue priority

Queue priority orders waiting work but cannot interrupt already-running
transfers, and it does not promise that a selected download finishes first. The
effective rate for a transfer is the tightest of the global cap and its own
saved per-download cap. yt-dlp/YouTube transfers use an external process and
cannot be dynamically re-capped after startup.

---

## 5. HTTP correctness

Three things in `net/httpClient.ts` are not optional; each prevents silent file
corruption.

**Range validation.** A `206` is checked against the range we asked for. A server
that answers `200 OK` to a range request (common, and it happens to more CDNs
than anyone admits) is detected and raised as `RANGE_UNSUPPORTED`. Writing that
body at a non-zero offset would produce a file with a duplicated prefix, and
without this check it would be undetectable until the checksum.

**`accept-encoding: identity`** is forced on every request. A transparent gzip
would make byte offsets meaningless.

**`If-Range`.** A usable strong `ETag` or `Last-Modified` validator is sent
back, so a remote file that changed since the probe yields a `200` instead of a
`206` — which the check above turns into a clean failure rather than a
spliced-together file. A later user retry re-probes the source and replans
progress if the identity changed; while a transfer is active, the safe response
is to fail rather than silently switch versions. Weak ETags are not valid
`If-Range` validators and are discarded for resume decisions.

**Redirects** are followed manually so the final URL is observable. A resumed
direct transfer starts again from the original URL, re-evaluating redirects and
re-applying cross-origin credential stripping instead of trusting a persisted
final URL that may contain an expired signed query string.

Probing tries `HEAD` first (no bandwidth), and falls back to a one-byte ranged
`GET` when `HEAD` is refused, answers 405/501, or omits a trustworthy size.

---

## 6. Data layer

`repositories.ts` is the only module that knows SQL. Two rules:

**Placeholders are derived, never hand-counted.** Column lists are arrays, and
the `?` string is generated from them. A hand-written placeholder string is
exactly the kind of thing that silently breaks when a column is added — and it
did, once, during development.

**Row mapping is defensive.** Every column is coerced to its declared type with
an explicit fallback, and enum-like columns are validated against a known set. A
database that was truncated, hand-edited, or written by a future version must
not be able to produce a half-populated `Download` that crashes the engine.

Migrations are forward-only and recorded in `schema_migrations`. Existing
migrations are never edited; a new one is added.

---

## 7. IPC and trust

The renderer is untrusted. A compromised webview must not be able to hand the
main process a traversal path, a negative byte count, or an unbounded header map.

- `contextBridge` exposes a **named, enumerated** API. The renderer cannot reach
  `ipcRenderer`, `require`, or any Node primitive.
- Every payload is parsed with a **zod schema** before it reaches the engine.
  `headerMapSchema` strips `range`, `host`, `content-length` and the hop-by-hop
  headers on the way in, because the HTTP layer sets those itself.
- `filenameSchema` rejects path separators, `..`, Windows reserved device names
  (`CON`, `NUL`, `COM1`) and control characters.
- `resolveWithin` re-checks the final destination against the download root, so
  even a compromised main-side path cannot escape it.
- Errors are re-thrown as plain `{ code, message, retryable }` objects so the
  renderer can branch on the failure without Electron's error mangling.
- Subscriptions return an unsubscribe function, and the raw `IpcRendererEvent`
  is never forwarded — leaking it would hand the renderer `event.sender`.

### Event coalescing

Progress fires twice a second per download. Forwarding each event to the window
makes the renderer drop frames, so `EventBridge` buffers and flushes on a single
timer, and the renderer additionally stages updates in a ref and commits once
per animation frame.

---

## 8. Recovery

Detailed in the README; the design note worth recording is *why it is
conservative*. Trusting the database would be far cheaper. But the entire value
of the product is that resuming never silently produces a corrupt file, so a
chunk is only ever trusted after its digest is confirmed against the disk — and
re-verification is capped at 512 MB per download so a large library cannot stall
startup for minutes.

---

## 9. Rendering performance

- Progress events are staged in a ref and committed on `requestAnimationFrame`,
  never per event.
- `DownloadRow` is memoised, so an idle list does not re-render because a
  *neighbour* is transferring.
- Downloads live in a `Map` keyed by id, so an update touches one row.
- The throughput graph is a `<canvas>`, not SVG: it repaints indefinitely at
  2 Hz, and a few hundred SVG nodes per frame is what makes a desktop app feel
  sluggish.
- The chunk heat map aggregates into at most 160 DOM columns. A 40 GB file at
  64 KiB chunks is 640 000 blocks; rendering one node per block would be a
  performance bug waiting to happen.

---

## 10. Testing strategy

| Layer | What | How |
|---|---|---|
| Unit | pure logic | Vitest tests, no I/O |
| Integration | engine + real HTTP + real disk | real local server, real SQLite, real files |
| End-to-end | the built bundle under real Electron | `scripts/smoke.mjs` + an env-gated self-test |

The direct HTTP integration tests use a real local server, filesystem, and
SQLite database. Some external media tools and page resolvers are injected in
focused tests so their failure and lifecycle behavior is deterministic; actual
media validity and VP9/Opus and AV1/Opus codec/container normalization are
separately exercised with generated FFmpeg fixtures when FFmpeg and the
required encoders are available.
The failure modes that matter — torn writes, out-of-order chunk completion,
stale database rows, dropped responses, sources that change between ranges, and
servers that lie about ranges — need real I/O tests rather than mocks alone.

The test server in `test/helpers/testServer.ts` is deliberately hostile: it can
drop the socket mid-body, ignore `Range`, return truncated responses, answer 503
for the first N requests, change its body between requests, and serve redirect
chains.

### What the tests caught

Recorded because each was a bug that would have shipped:

1. **`req.end()` only called for `HEAD`** — no `GET` was ever written to the
   socket. Every transfer hung until the 30 s timeout. Found by the first
   integration test, which timed out instead of passing.
2. **31 placeholders for 30 columns** — every insert threw. Fixed structurally by
   deriving placeholders from the column array.
3. **CRC-32 table indexed without `& 0xff`** — `crc` exceeds 255 after the first
   byte, so most lookups fell off the 256-entry table and produced a
   non-standard digest.
4. **`httpUrlSchema` refine threw instead of failing** — zod runs refinements
   even after `.url()` fails, so an unguarded `new URL()` made `safeParse` throw
   on any malformed input, which would take down an IPC handler.
5. **Rate-limiter burst floor** — made every speed limit below ~512 kbps a no-op.
6. **`chooseConnections` capped at 4** regardless of the user's setting, making
   the connection-count preference meaningless on large files.

---

## 11. Deliberate non-goals

Listed so they read as decisions rather than oversights:

- **No full BitTorrent feature set.** The supported Transmission route
  supports v1/v2 magnets, `.torrent` sources, file selection, and per-torrent
  download/upload caps. Tracker/peer administration, RSS/search, seeding
  controls, quotas, and global torrent speed caps are not implemented.
- **No cookie import.** Custom headers per download are supported instead.
- **No parallel download of one file across multiple URLs.** Mirroring would
  complicate the range bitmap for little benefit in the common case.
- **No cloud sync of the database.** The chunk map is a local artefact; syncing
  it across machines has no coherent semantics.
