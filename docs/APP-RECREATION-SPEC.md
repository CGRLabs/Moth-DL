# Moth Download Manager: App Recreation Specification

This document is a product and engineering specification for recreating Moth
Download Manager from scratch. It describes the application as it exists in
the source tree: user-visible behavior, architecture, transfer guarantees,
interfaces, data, security boundaries, and validation expectations.

It is not a substitute for source inspection when this repository is available.
Implementation details and supported features change. Before using this as a
build prompt, inspect `package.json`, `src/shared/types.ts`,
`src/shared/ipc.ts`, `src/shared/schemas.ts`, `src/main/db/schema.ts`, and the
relevant engine and UI modules. If this document and current code disagree,
current code wins; update this document when behavior changes.

## 1. Product definition

Moth is a local-first desktop download manager. It owns a persistent download
queue and selects a transfer engine according to the submitted source:

1. Direct HTTP(S) files use Moth's resumable HTTP engine.
2. Explicitly requested media pages use the media resolver and then the
   appropriate HTTP or media pipeline.
3. YouTube pages use yt-dlp to select and transfer media streams, and FFmpeg
   to merge, normalize, and validate output where required.
4. BitTorrent magnets and `.torrent` sources use a separate Transmission
   daemon. The supported packaged torrent runtime is Windows x64 only.

The desktop app is the authority for persistence, routing, scheduling,
integrity, final-file promotion, and user-visible state. Browser extensions,
terminal clients, MCP hosts, and other integrations submit work to Moth; they
must not implement a parallel queue or write to its database.

The product is intended to provide:

- Safe resumable HTTP downloads when the server supplies a usable content
  validator, with no stitching of bytes across source versions.
- Transparent limits: unsupported or uncertain resume is disclosed, not
  silently treated as safe.
- A single queue and normal controls for supported transfers, while keeping
  transport-specific limitations explicit.
- A desktop UI, optional browser handoff, and local interfaces for scripts and
  AI agents.
- No automatic remote telemetry or diagnostic upload.

## 2. Runtime, build, and application boundaries

### Technology

The current desktop app uses:

- Electron for the desktop shell and privileged main process.
- React and Tailwind CSS for the renderer.
- TypeScript with strict checking for the desktop code.
- Node.js 22.5 or newer; Node's built-in `node:sqlite` is used instead of a
  native SQLite addon.
- SQLite for persistent queue, settings, activity, and media state.
- zod schemas for validation of data crossing the renderer/main IPC boundary.
- Vitest for app unit/integration tests and Node's built-in test runner for
  browser-extension tests.

The standalone `cli/` downloader is a separate, dependency-free Node.js
program. It is not the desktop engine and does not access the desktop
application database.

### Process trust model

Use these layers and keep their responsibilities distinct:

```text
React renderer
    │ typed, narrow API only
context-isolated preload
    │ validated IPC requests
Electron main process
    ├── download engine and deterministic router
    ├── task-specific HTTP / yt-dlp / Transmission workers
    ├── SQLite repositories and settings store
    ├── loopback ingest/control API
    └── filesystem, dialogs, shell, notifications
```

- Renderer code has no Node, filesystem, arbitrary IPC, or database access.
- Preload exposes a finite allowlisted API via `contextBridge`.
- Every IPC payload is parsed in the main process before use. Renderer types
  alone are not validation.
- Repositories own SQL. Business logic uses repositories, not raw SQL.
- Main-process tasks emit typed events; the renderer consumes snapshots and
  events through the preload API.
- Error responses crossing IPC are serializable and preserve stable error
  codes.

## 3. User experience and primary workflows

### Main window and navigation

The main app presents the queue and download controls, with dedicated
destinations or dialogs for:

- Queue and download review.
- Completed files, filtered as supported by the current Files view.
- Download plans.
- Browser integration and pairing.
- Settings, troubleshooting, health checks, diagnostics, and repair.
- Full-screen Flow visualization, displayed inside the main window rather than
  a separate native window.

The app may continue running in the system tray according to user settings.
Closing/minimizing behavior, desktop notifications, theme/accent settings,
download directory, per-category folders, transfer tuning, logging, and media
metadata preferences are user-configurable. Preserve existing preferences
across upgrades and use migrations when persisted schema changes.

### Add and review workflow

1. The user pastes, drops, or receives a source URL from an integration.
2. Moth classifies the source and may probe a direct URL or resolve a media
   page.
3. The request is persisted in `review` state before asynchronous lookup begins.
4. Lookup may fill in filename, size, media details, or torrent metadata; it
   must not silently start a reviewed request.
5. The user can configure supported options and explicitly start the item, or
   remove it.
6. If auto-start is enabled for the relevant workflow, preserve that setting's
   documented behavior; do not convert a manual review action into a hidden
   transfer start.

A direct-download preview can report that metadata is unknown. Do not invent a
file size or represent a failed probe as trustworthy metadata.

### Queue and task actions

The queue supports start/resume, pause, retry, cancel, remove, priority
ordering, and supported per-download configuration. It displays status,
progress, rate, ETA when available, and integrity or failure details.

Keep distinctions between:

- Pause: stop active work but retain resumable state where the transport
  supports it.
- Cancel: stop the transfer and mark it canceled; remove/finalize semantics
  are separate.
- Retry: revalidate/re-resolve where appropriate, then restart safely.
- Remove: remove the queue record and associated managed temporary state. For
  completed files, ask whether to keep or delete the final file according to
  settings.
- Clear completed: remove completed rows without deleting files.

Do not claim that the exact partial-progress behavior is identical between
HTTP, yt-dlp, and torrents; they use different engines.

### Scheduling, priority, and queue plans

- A download can be scheduled for an absolute start time.
- Queue priority orders waiting work; it does not preempt running tasks.
- Global concurrency limits the number of simultaneous engine tasks.
- One-off queue plans persist a selected set of downloads, start time, run
  window, ordering strategy (`queue-order` or `smallest-first`), and end action
  (`pause` or `continue`). A plan does not allocate bandwidth or promise a
  deadline. Enforce non-overlapping plan windows and avoid reserving one item
  in multiple pending plans.

### Flow visualization

Flow visualizes actual nonterminal queue items, not fake download data. It
shows an animated WAN-to-file map with a compact speed/count HUD, curved
backbone and branches, individual file nodes, transfer status, rate/progress,
and contextual controls. Completed and canceled items are omitted. It supports
node movement, panning, keyboard interaction, and reduced-motion behavior.
Node actions operate on the associated real queue entry.

Torrents share queue-node presentation but have no peer-to-node connector map.
Peer counts and torrent file/cap controls belong in download details. The WAN
cap is not a torrent cap. It is applied by HTTP and passed to yt-dlp at task
start; it cannot dynamically re-cap a yt-dlp child process already running.
See [the Flow visualization brief](VISUALIZATION-PREVIEW.md) for current
layout and interaction details.

## 4. Source routing and transfer engines

### Deterministic routing

Use a deterministic, explainable router. A source route should include both a
kind and a transport, plus a reason suitable for safe diagnostics/logging.
Order matters: recognize supported torrent sources before treating inputs as
ordinary URLs; absent an explicit media format, a normal HTTP(S) URL is a
direct-file request. YouTube pages use yt-dlp when page resolution is
requested. Other explicitly requested media pages use the resolver unless an
enabled experimental site adapter matches.

Never silently fall back between transports. Do not send an ephemeral signed
media URL through an unrelated route after yt-dlp/resolution fails. Fail
clearly or follow that route's defined safe recovery behavior.

### Direct HTTP engine

The main transfer engine handles direct files and resolved HTTP streams.

Probe behavior:

- Try `HEAD` first.
- If `HEAD` is refused, unsupported, or lacks a trustworthy size, use a
  bounded one-byte ranged `GET` probe where appropriate.
- Follow redirects deliberately and retain enough metadata to explain the
  effective source.
- Treat unknown size as unknown rather than guessing.
- Detect whether byte ranges are genuinely supported.
- Select a usable strong ETag or `Last-Modified` as an `If-Range` validator.
  Weak ETags are not safe `If-Range` validators.

Transfer behavior:

- If the server supports byte ranges and gives a positive size, plan bounded
  chunks and run a configurable number of concurrent range workers.
- Validate every partial-content response against requested byte offsets,
  total size, and the selected source validator.
- Force identity content encoding so transparent compression cannot change
  offsets.
- If ranges are unsupported or the size is unknown, use a single stream and
  disclose that it cannot safely resume as a range transfer.
- Apply the global and per-download rate limiters to received bytes. The
  limiter uses a smooth GCRA/virtual-scheduling approach, not a bursty
  independent token bucket per worker.
- Bound retries, use backoff with jitter, and honor bounded `Retry-After`
  hints when relevant.
- A quota can cap saved HTTP bytes; when reached, pause at a correct persisted
  boundary. Quota is not supported for yt-dlp or torrent transfers.

Redirect and resume behavior:

- On resume, start from the original URL and re-evaluate redirects.
- Strip sensitive headers when a redirect crosses origin; never forward
  cookies/authorization values to a different origin.
- If a usable validator exists, send it through `If-Range`.
- A changed source identity must fail/replan/restart according to the safe
  transfer rules. Never append bytes from a different source version.
- When identity cannot be proven, discard unverified partial progress and
  restart rather than promise a safe resume.

### Durability and recovery invariants

This is the core non-negotiable invariant:

> A range/chunk is committed as complete in SQLite only after the corresponding
> file bytes have been synced, checked, and digested.

The safe order is:

1. Write bytes at the correct positional offset.
2. Sync the file data.
3. Verify/checksum the range.
4. Commit its complete state and digest in SQLite.

Use WAL and full synchronous durability for the SQLite database. Track
completed ranges as a bitmap/map, not one unchecked byte counter. Checkpoint
in-flight data only after syncing it. On recovery:

- Inspect the actual file size.
- Validate chunk-map contiguity and boundaries.
- Drop ranges beyond the actual file end.
- Re-digest completed ranges within configured bounds.
- Reset data with absent/mismatched verification as required.
- Recompute trustworthy progress and leave interrupted work paused/resumable
  when the route supports it.

Keep output staged (`.mothpart` for HTTP/media output) until transfer and
required integrity checks have passed. Promote to a collision-safe final
destination only after verification. Preserve path containment and do not
overwrite a pre-existing file.

### yt-dlp media engine

yt-dlp owns YouTube format selection, media fragments, and stream merging.
FFmpeg performs required remux/transcode operations and validation. Keep
audio-only output behavior separate from video-with-audio output behavior.

- Support video quality requests up to 2160p, with a documented default.
  Requested quality is a maximum/preference, not a promise that the source
  supplies that resolution.
- Audio may retain the source format or be converted to MP3, according to the
  request and current feature behavior.
- Resolve pages through the explicit media pipeline; do not treat a signed
  stream URL as a normal user-selected direct source.
- Pin resumable fragments to stable relevant request identity, including the
  source page, requested format/quality, forwarded headers, and configured
  yt-dlp version. Store a fingerprint, not raw secrets, for that identity.
- Ensure yt-dlp's output path is inside its managed work directory before
  using or promoting it.
- For requested video, require readable video and audio streams and a
  successful full staged-output decode before completion.
- If conversion, merging, integrity verification, or decode validation fails,
  leave the task failed and retain recoverable source material as appropriate.
  Never call a nonempty file or successful process exit sufficient proof of
  valid video.
- External media tools are fetched/pinned on demand and are not bundled in the
  normal installer at present. First use may need a network connection.

Media-page requests may also support playlists, item selection, duplicate
history, subtitles, naming templates, metadata/artwork extraction, and
per-request embed opt-out. Treat every provider response as untrusted, and
preserve per-item failure isolation where the feature defines it.

### BitTorrent engine

Torrent is an explicit separate source/transport route backed by Transmission,
not the HTTP chunk engine.

- Accept BitTorrent v1 and v2 magnets (including supported hybrid magnets),
  remote `.torrent` URLs, and local `.torrent` metainfo.
- Bound and validate metainfo (currently up to 8 MiB); fetch remote metainfo
  through the safe HTTP client and stage it for retries.
- Run the daemon with a private Moth-owned configuration and authenticated
  loopback RPC. Do not expose the daemon RPC to the network.
- Store output in a per-download directory under `.moth-torrents` inside the
  configured download root.
- Support file selection plus per-torrent download and upload speed caps.
- Use Transmission's piece verification and selected/wanted file accounting.
  Completion is based on wanted bytes remaining, not process success or
  overall torrent seeding state.
- Stop seeding on completion; seeding is off by default.
- Stop/clean incomplete torrent work on task failure, cancel, shutdown, or
  other terminal lifecycle path as defined by the owner.
- Torrent tasks do not use HTTP chunk recovery, the HTTP global rate
  limiter, quotas, or HTTP range validators.
- Only Windows x64 packaged builds bundle the supported daemon/runtime today.
  Tracker/peer administration, RSS/search, and configurable seeding are not
  part of the current feature set.

## 5. Rate limits and other queue semantics

Rates are expressed internally as bytes per second. UI text may display
human-friendly units; parse input explicitly and validate finite, nonnegative
values.

- A null/zero effective cap means unlimited, according to the shared domain
  contract.
- Global and per-download rates combine by applying the stricter cap.
- Torrent download and upload caps are separate Transmission settings.
- yt-dlp receives an effective cap when the process starts; changing the
  global value does not dynamically update that process.
- Concurrency and priority control task starts, not byte fairness.
- Never claim that a schedule, queue plan, or priority guarantees that a
  download will finish by a particular time.

## 6. Persistence and domain model

### Core records

Use a persistent `downloads` record keyed by a stable ID and a `chunks` table
for direct HTTP byte ranges. The download record includes:

- Original/final source URL and filename.
- Staged and final paths.
- Discovered size, content type, range support, ETag, and Last-Modified.
- Category, lifecycle status, bytes, priority, retry counters, and error code.
- Expected/computed checksums.
- Download/upload limits, quota, selected torrent file indexes, and connection
  count where applicable.
- Validated request headers, scheduling time, and lifecycle timestamps.

The shared status vocabulary currently includes `review`, `queued`,
`connecting`, `downloading`, `paused`, `verifying`, `completed`, `failed`,
`canceled`, and `scheduled`. Keep status transitions explicit and validate
them in engine operations.

Additional persisted concepts include:

- `settings`: validated application preferences.
- `activity`: per-download user-readable events.
- `media_metadata`: normalized metadata and artwork references.
- `media_history`: completed media identity/history for duplicate handling.
- Pending media-resolution/transcode state needed to recover a staged media
  workflow.
- `youtube_video_output_details`: requested quality, actual dimensions/codecs,
  and validation time.
- `queue_plans`: persisted one-off run windows and selected download IDs.
- `schema_migrations`: applied migration versions.

The exact schema is defined by append-only migrations in
`src/main/db/schema.ts`. Never rewrite a released migration; add the next
forward migration and test upgrades from an older schema.

### Settings and files

Settings include at least download and category directories, auto
categorization, global/per-download transfer tuning, concurrent task/connection
limits, retry and checksum policy, start/tray/close behavior, notifications,
theme/accent/log level, queue confirmation, browser integration/port/token,
download-folder watching, media tag read/write policy, helper tool directory,
and pinned yt-dlp/FFmpeg versions. Use the current settings schema as the exact
source of truth.

Data is local under Electron `userData`. It includes the SQLite DB and
WAL/SHM files, rotating JSON-line logs, content-addressed artwork, and managed
partial/transport sidecars. Final files go to the configured download
directory, optionally organized into category subdirectories. Enforce
path-containment checks on every untrusted or configurable destination.

## 7. Browser integration and local automation

### Browser extension

Ship plain browser scripts for:

- Chrome/Edge/Brave/Opera/Vivaldi using the Chrome Manifest V3 build.
- Firefox 115+ using its Firefox build.

An extension is required because desktop applications cannot silently
intercept browser downloads. Pair the extension with Moth through an
authenticated IPv4 loopback endpoint bound to `127.0.0.1`; never expose it as
a general network proxy.

The endpoint uses a strong generated pairing token in a request header and
compares it safely. Browser handoff cancels the original browser download only
after Moth confirms that it accepted the request. Keep permissions narrow and
avoid collecting browser history or monitoring page traffic by default.

Extension behavior can include context-menu handoff, direct-media detection,
quality choices for discrete sources, explicit current-page scan/resolver
actions, page metadata extraction, and setup/troubleshooting UI. It must not
bypass DRM or browser approval. Manual installs pair through the displayed
port/token; Windows signed Chromium builds may use the documented local
registration flow, whose registry write is not proof that a browser accepted
the package.

The optional download-folder watcher can offer browser temporary files for
adoption. It cannot infer the original source URL from the temporary file.

### App CLI and ingest API

The bundled app CLI and browser extension use the same authenticated,
versioned, loopback-only app service. The CLI is a control client, not a
downloader. It supports commands such as status/list/get/add/pause/resume/
retry/cancel/wait/logs/doctor/repair and returns machine-readable JSON with
nonzero error exits. API responses must omit secret request headers and redact
credential-like URL components.

### MCP

The stdio MCP server is a thin adapter over that same local authenticated API.
Tools expose app status, list/get, add, pause/resume/retry/cancel, and bounded
wait. The MCP process does not download files or access SQLite to mutate jobs.
Its pairing token remains in local configuration/environment and must never be
sent to the model as data. Moth must already be running and sources continue
through the normal supported-source and validation routes.

### Standalone direct-download CLI

`cli/` is a separate, intentionally narrow HTTP downloader. It supports safe
resume when a strong ETag and range support permit it, retry, refreshed-link
validation, optional checksums, JSON progress, and redacted debug events. It
uses `.part` plus sidecar state and a lock file, does not overwrite completed
outputs, and does not support torrents or the desktop DB.

## 8. Media metadata and files view

The app can read ID3v1/ID3v2, MP4/MOV `ilst`, FLAC, and Ogg Vorbis metadata;
write support is limited to ID3v2.3 and MP4 `ilst`. Metadata source precedence
is manual edit, page metadata, embedded file tags, then filename heuristic.
Manual values must not be overwritten by later automatic extraction.

Artwork is validated by file signature, size-limited, stored by content hash
under user data, and served to the renderer over a custom protocol rather than
exposing filesystem access. MP4 writing must account for atom growth and update
chunk offsets correctly; write to a staged copy, parse the result, and only
replace the original after validation succeeds.

The Files view is a view over completed Moth-managed records, not an arbitrary
filesystem browser. Removing a queue record and deleting a final file are
separate explicit choices.

## 9. Diagnostics, logging, and privacy

Moth does not automatically transmit analytics, crash reports, or diagnostics.
Troubleshooting can generate a local minimized JSON report for review. It
contains app/runtime versions, selected performance settings, and aggregate
download statuses/failure categories. It excludes download names, URLs, local
paths, credentials, and logs. The exact preview must be visible before the
user checks an explicit confirmation and opens the OS save dialog. Discarding
the preview invalidates it; saving does not upload it.

Application logs are local rotating JSON lines. Redact tokens, authorization,
cookies, signed URL queries, and other secrets at logging boundaries. Never
include secrets in diagnostic fingerprints or external tool arguments beyond
the scoped transfer task that needs them. Keep failure reports useful through
stable route, strategy, error category, byte, codec, and validation details
where safe.

## 10. Security requirements

Treat source URLs, server headers, filenames, remote metadata, torrent
metainfo, media files, extension messages, and renderer payloads as untrusted.

- Validate and bound all external inputs at their trust boundary.
- Permit only supported schemes and sources; reject local or script URLs.
- Bind control/ingest endpoints to IPv4 loopback and require a strong secret.
- Keep Transmission RPC private and authenticated.
- Strip cross-origin credentials on redirects.
- Sanitize filenames and constrain resolved paths under approved destinations.
- Avoid directory traversal, unsafe archive-like paths, and arbitrary file
  reads/writes.
- Keep renderer privileges minimal and IPC allowlisted/schema-validated.
- Use staged output and atomic/collision-safe promotion; never overwrite a
  final file silently.
- Do not trust process exit status, file size, or server-supplied metadata as
  integrity proof.
- No DRM bypass, cookie-store scraping, access-control circumvention, or
  arbitrary network proxy behavior.

## 11. Testing and acceptance criteria

### Commands

Use the project scripts:

```text
npm run typecheck
npm test
npm run benchmark:resume
npm run test:extension
npm --prefix cli test
npm run smoke
npm run test:ingest
npm run verify
npm run package
```

`npm run verify` covers the typecheck, app suite, extension suite, built-bundle
smoke test, and ingest end-to-end check. The standalone CLI suite is separate.
`npm run benchmark:resume` is an explicit opt-in real-I/O regression benchmark:
it exercises 128 MiB through a local HTTP server with 40 forced range-response
drops, verifies the final SHA-256, and reports retransmitted bytes and elapsed
time. It does not contact a live provider. `MOTH_BENCH_SIZE_MIB` (16–1024) and
`MOTH_BENCH_INTERRUPTION_COUNT` adjust its workload.
Package after verification when the expected result is the current Desktop or
Start Menu application, and check that the shortcut targets the packaged
Windows executable.

### Required automated cases

- Unit tests for schemas, routing, chunk planning, checksum algorithms,
  rate-limiter boundaries, backoff, path containment, and output naming.
- Real local HTTP server + real temporary files/database for range validation,
  redirects, retries, cancellation, changed source identity, interruption,
  recovery, and final-byte equality.
- Regression test that proves the old bug would fail, especially for changed
  content, invalid range responses, or durability ordering.
- Explicitly show whether safe HTTP resume is supported, unsupported, or not
  yet known; explain when the source cannot safely continue and must restart.
- Keep the repeatable local resume benchmark opt-in, checksum-verified, and
  separate from the ordinary unit/integration test suite.
- Generated local FFmpeg fixtures for valid video/audio, missing streams,
  truncation/corruption, failed conversion, and no promotion of invalid output.
  Tests must not depend on a live YouTube provider.
- Torrent tests using generated/local metainfo or a local test daemon/runtime;
  cover selected-file completion, piece/progress accounting, pause/resume,
  failure cleanup, RPC validation, and cap behavior.
- UI and IPC tests for queue state, consent/preview, and validated commands.
- Browser tests for manifest permissions, handoff ordering, pairing failures,
  media detection, and no unintended page monitoring.
- MCP/CLI tests should use a local controlled service and prove secrets are
  not leaked in stdout, model-facing content, or logs.
- Upgrade tests for append-only DB migrations and package tests for required
  platform resources.

### Release acceptance

A recreation is not ready merely because it builds. Require:

1. `npm run verify` passes; run standalone CLI tests separately.
2. Source-routing decisions and unsupported-source behavior are explicit.
3. HTTP integrity and recovery acceptance tests pass with real local I/O.
4. Media completion requires correct streams and decode validation.
5. Torrent completion follows selected wanted bytes and piece verification.
6. Browser/CLI/MCP all use the app-owned queue and supported routes.
7. Privacy, secret redaction, local-only diagnostics, and trust boundaries are
   reviewed.
8. The packaged application starts, a local test download succeeds, and
   shortcuts point at the package the user is expected to launch.
9. Documentation states platform limitations and does not overclaim
   production reliability or support for every provider.

## 12. Current limits and non-goals

The following are not part of the current product contract:

- Torrent support outside Windows x64 packaged builds.
- Torrent tracker/peer administration, RSS/search, configurable seeding,
  torrent quotas, or global torrent rate limiting.
- HLS/DASH manifest downloads as ordinary files.
- DRM circumvention, browser cookie-store import, or authentication bypass.
- A remote/headless multi-user service. Current app APIs are local loopback
  interfaces only.
- A cloud-synced database or cross-machine transfer resume.
- Standalone CLI torrent support.
- A guarantee that every provider, URL, playlist, codec, or server can be
  downloaded.
- Automatic diagnostic or usage-data upload.

Ideas under `docs/FUTURE-DIRECTIONS.md` are proposals, not current behavior or
release commitments.

## 13. Source map

Use these current files as the implementation map:

| Concern | Source of truth |
|---|---|
| Domain types and settings | `src/shared/types.ts` |
| IPC channel types | `src/shared/ipc.ts` |
| IPC validation schemas | `src/shared/schemas.ts` |
| Source routing | `src/main/core/router.ts` |
| Queue/scheduling/engine ownership | `src/main/core/engine.ts` |
| Direct HTTP task | `src/main/core/task.ts` |
| HTTP protocol and redirects | `src/main/net/httpClient.ts` |
| Direct recovery and chunk integrity | `src/main/core/recovery.ts`, `src/main/core/writer.ts` |
| Persistent schema and migrations | `src/main/db/schema.ts` |
| DB access | `src/main/db/repositories.ts` and `src/main/db/mediaRepository.ts` |
| Torrent transport | `src/main/torrent/` |
| yt-dlp and FFmpeg pipeline | `src/main/video/` |
| IPC handlers and main-process API | `src/main/ipc/` and `src/main/ingest/` |
| Renderer | `src/renderer/src/` |
| Preload trust boundary | `src/preload/index.ts` |
| Browser extension | `browser-extension/` |
| Independent direct-download CLI | `cli/` |
| MCP adapter | `scripts/moth-mcp.mjs` |
| Product/setup details | `README.md`, `browser-extension/README.md`, `cli/README.md` |
| Core design rationale | `docs/ARCHITECTURE.md` |

## 14. Additional target requirements

The requirements in this section capture proposed product and engineering
work beyond the current source-tree snapshot above. They are target
requirements, not claims that the current application already implements
them. Keep the distinction visible in the UI and documentation until each
capability is implemented and covered by tests.

### Observability, diagnostics, and repair

- Provide a local health screen that checks database integrity, WAL size,
  orphaned `.mothpart` files, stale/inconsistent chunks, Transmission
  availability, and yt-dlp/FFmpeg versions. Report unavailable checks as
  unavailable or failed; never present a skipped check as healthy.
- Implement `doctor` as a real command that produces a useful, redacted
  report suitable for a user to review and paste into an issue. Preview and
  redact it locally; do not upload diagnostics automatically.
- Emit structured local logs with stable event names, such as
  `http.validator_missing` and `torrent.rpc_timeout`, alongside useful
  context. Apply secret redaction at logging boundaries.
- Implement repair only for well-understood cases, including stale locks,
  half-promoted files, invalid chunk maps, and orphaned temporary directories.
  Show the proposed changes, preserve recoverable data, and do not claim a
  repair succeeded unless its postconditions are verified.
- Bound log retention by both age and/or size so logs cannot grow without
  limit. Rotation must not delete active log files or user downloads.

### Resource discipline and connectivity awareness

- Bound memory and live resources as queue size and active work grow. Close
  streams, file handles, database statements, sockets, and child processes on
  success, failure, cancellation, and shutdown.
- Bound and reuse HTTP range-worker resources across concurrent downloads;
  avoid a worker-per-range design that can exhaust OS handles.
- Before starting a download with a known expected size, compare available
  destination space with the expected output plus staging and metadata
  overhead. Fail early with an actionable disk-space error. For unknown sizes,
  monitor space during transfer and preserve recoverable staged data on
  failure.
- Reconcile managed temporary files after an unclean exit. Delete only files
  proven to be orphaned and outside active/recoverable work.
- Keep Flow animation work bounded. Respect reduced-motion settings, throttle
  when the window is unfocused, and reduce or suspend nonessential animation
  on battery power.
- Where supported, detect metered networks and battery state and apply an
  explicit pause or concurrency-reduction policy. Report the active policy;
  do not silently change user-configured limits. Platform-specific support
  must be capability-detected and tested.

### Actionable and persistent errors

- Normalize failures into stable categories: network, server, validator, disk,
  permission, tool, configuration, integrity, and canceled-by-user.
- Each category must carry the actual underlying cause in details and a
  suggested next action, such as retry, change a setting, free disk space,
  update yt-dlp, or re-pair the browser. Do not replace useful cause details
  with a generic “download failed” message.
- Persist the stable category, code, safe details, and suggested action with
  the download so it remains visible after restart. Redact secrets and
  sensitive URL components from persisted errors.

### Scheduling, limits, and concurrency

- Combine global and per-download HTTP rate caps by applying the
  strictest applicable cap. Neither may mutate or overwrite a saved
  per-download cap.
- Keep rate scheduling smooth using the shared GCRA/virtual-scheduling model,
  rather than independent bursty token buckets per worker. Test inter-request
  timing and burst bounds, not only average throughput.
- Concurrency limits govern starts of engine tasks; starting a new task must
  not retroactively throttle already-running tasks unless an explicit rate
  policy applies.
- Keep Transmission download/upload caps separate from HTTP limits.
  yt-dlp's effective cap is fixed when its process starts; the UI must say so
  and must not imply that changing the setting re-caps a running process.
- Add regression tests proving torrent caps never pass through the HTTP limiter.

### Large-queue workflows

- Support bulk URL entry with per-item source classification and a review
  table where users can select which items to start.
- Support selection-based pause, resume, retry, cancel, and remove actions.
- Provide queue search, filter, and sort for status, category, size, rate, ETA,
  and error, with customizable columns and saved views.
- Provide keyboard shortcuts for common queue operations with discoverable
  help and accessible focus behavior.
- Virtualize large queues; validate rendering and interaction with at least
  1,000 items rather than relying on a naive full DOM list.
- Support explicit JSON queue import/export. Validate imported data, exclude
  secrets, and do not automatically start imported work.

### Data safety and recovery

- Offer a user-initiated, single-file backup and restore flow for the database
  and settings. Use a consistent database snapshot, validate backups before
  restore, and never overwrite the only recoverable copy.
- Record clean/unclean shutdown state and run a database integrity check on
  startup after an unclean shutdown. Present failures clearly before any
  destructive recovery action.
- Provide a recovery mode for an unreadable database that can inventory
  recoverable staged files and offer a verified rebuild path. Never claim
  queue metadata can be reconstructed from file contents alone.
- Write settings atomically: write and validate a staged file, sync it where
  supported, then replace the prior settings file without leaving a partial
  configuration on interruption.
- Store pairing tokens in the operating-system credential store where
  available. Define and test a safe, explicit fallback on platforms without a
  supported keychain; never log or include tokens in exports.

### Platform support and user-facing documentation

- Make unsupported platform features explicit at the point of use. In
  particular, non-Windows builds must identify torrent support as unavailable
  instead of presenting a broken action.
- Test filesystem paths, permissions, case sensitivity, and line endings on
  macOS and Linux before claiming support for those platforms. Do not promise
  an OS or package format that has not been tested.
- Maintain practical user documentation: a README with a short demo, install
  and quick-start steps, limits and non-goals; an FAQ covering resume,
  yt-dlp, torrent platform support, and safety; an architecture document
  describing trust boundaries, durability ordering, and routing; a
  troubleshooting guide with copy-paste `doctor` steps; and release-by-release
  changelog entries.
- Maintain contributor instructions for tests, routing changes, and database
  migrations. Keep documentation consistent with implemented behavior.

### Accessibility and localization

- Make the queue and Flow operable by keyboard and expose meaningful screen
  reader labels for state, progress, and icon-only controls.
- Respect reduced-motion preferences in all Flow animations, not only the
  primary visualization.
- Check text and control contrast in dark and light themes.
- Centralize renderer strings in a localization dictionary; do not add
  hardcoded English UI copy. Format numbers, dates, sizes, and ETAs by locale.
- Support RTL layouts through actual directional mirroring and interaction
  testing, not translation alone.

### Legal, privacy, and dependency posture

- State in the README that Moth is a tool and users are responsible for
  complying with applicable law, copyright/DMCA obligations, and
  source-service terms. Keep DRM and access-control circumvention out of
  scope.
- Document the licenses and acquisition/pinning process for yt-dlp, FFmpeg,
  Transmission, and other redistributed or downloaded tools. Do not bundle
  binaries without confirming redistribution rights.
- Choose and document a project license deliberately. Publish a privacy
  statement even when the policy is that no telemetry is collected.

### Release engineering and operations

- Version releases semantically, publish clear release notes, and keep a
  stable latest-download location plus prior installers for rollback.
- Sign release artifacts and verify signatures. Prefer a reproducible,
  automated GitHub Actions signing and Sigstore provenance process; document
  what users can verify.
- Separate stable and beta update channels, with explicit user choice and
  clear version/status labels.
- Test upgrade paths and preserve a documented rollback plan. Treat Electron
  upgrades and Transmission RPC compatibility as tracked release work; pin or
  test helper versions and provide a helper-update path where safe.
- Evaluate package-manager distribution (such as winget, Scoop, Homebrew, or
  Linux packages) only for platforms with tested support. Document unsigned
  macOS Gatekeeper warnings and common Windows antivirus false positives;
  provide a process for reporting false positives without asking users to
  disable security protections.
- Keep a discoverable feedback channel and public roadmap, and periodically
  prioritize recurring user complaints before adding new feature breadth.

### Measurable performance and failure handling

- Define and publish numeric targets for cold start, rendering a 1,000-item
  queue, memory with 20 active downloads, Flow with 50 nodes, and database
  chunk-commit latency before treating performance as accepted.
- Add repeatable local performance tests for those targets and record the
  workload, machine class, and thresholds. Avoid tests that depend on a live
  provider or network.
- On main-process failure, show a recoverable renderer state. A renderer crash
  must not stop main-process downloads. Supervise yt-dlp, FFmpeg, and
  Transmission with bounded timeouts and clean termination; report actionable
  failures rather than leaving tasks stuck.
- Add worker progress/watchdog checks with explicit timeouts and safe failure
  transitions. Any crash-report capture must be local-only, opt-in, and
  redacted; never auto-upload it.

### Non-negotiable priority

> User bytes must never be corrupted, and the app must never claim work it did
> not verify. When a feature conflicts with transfer integrity, durability,
> recovery, or honest status reporting, defer the feature.
