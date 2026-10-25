# Agent-Native CLI Downloader — Product & Implementation Plan

> **Handoff document.** Save this file as `docs/PLAN.md` in the new repo and read it
> before writing any code. It is self-contained: a new contributor (human or AI)
> should be able to implement the whole thing from this document plus the
> referenced Moth source files.

---

## 1. Product definition

### What it is

A **command-line download tool purpose-built for AI agents**, whose core promise is
the same as Moth Download Manager's: *an interrupted download resumes safely and
produces a byte-identical file.* It adds an **agent-native surface** (JSON
output, stable exit codes, MCP server, streaming progress) on top of a verified,
crash-safe HTTP core.

It is **not** a desktop app, not a browser extension, and not a media pipeline.
It is the thing an agent shells out to (or calls via MCP) when it needs to fetch
a file and be able to trust the result.

### Positioning

> "The only downloader that verifies every byte, resumes after a crash, and
> speaks agent-native (MCP + JSON)."

Do not position it on speed. Position it on **correctness per byte**. Agents are
notoriously bad at handling partial failures; a corrupt model weight or dataset
is a nightmare. Nobody in the agent tooling space owns "verified download."

### Target users

1. AI agents (Claude, Cursor, Copilot, custom agent loops) that need to fetch
   files and trust the result.
2. Developers orchestrating agents who want to observe what their agents are
   downloading.
3. Power users who want a fast, scriptable, verified downloader.

### Success criteria

- An agent can call `agent-dl download <url> --json` and get a structured,
  machine-parseable result with a verified checksum.
- A resumed download produces a byte-identical file (proven by tests).
- The MCP server exposes `download`, `status`, `list`, `cancel`, `verify`,
  `inspect` as tools any MCP client can use with zero glue.
- A human can run `agent-dl status` / `agent-dl list` / `agent-dl tail` to see
  what their agents are doing.
- Zero native addons; `npm install -g` works on a clean machine.

---

## 2. Goals and non-goals

### Goals

- Reliable, resumable, verified HTTP downloads (single and multi-connection).
- Agent-native I/O: JSON/JSONL on stdout, logs on stderr, stable exit codes.
- Idempotency: "download this URL to this path; if it's already there and
  verified, no-op."
- MCP server (stdio transport) wrapping the core.
- Human observability: status, list, tail, per-download state files.
- Crash safety: survives kill -9 mid-download; resumes with byte-identical file.
- Zero native addons (Node built-ins only).

### Non-goals (scope fence — do not build these)

- No GUI, tray, themes, or desktop app (that's Moth).
- No torrent engine.
- No media pipeline (yt-dlp/FFmpeg) — agents can use yt-dlp directly.
- No browser extension or cookie import.
- No auto-update (v1).
- No multi-URL mirroring of one file.
- No HLS / segmented playback.
- No DRM handling of any kind: no decryption, and no refusal either. Bytes are
  transferred exactly as the server sends them.
- No cloud sync of state.

If a feature request touches a non-goal, push back unless it's clearly in scope.

---

## 3. Source of truth: Moth Download Manager

This project reuses Moth's core. The following files are the reference
implementation to port from (paths relative to the Moth repo):

| Moth file | What to port |
|---|---|
| `src/main/net/httpClient.ts` | `probe`, `openRange`, redirects, `If-Range`, range validation, retry, credential stripping |
| `src/main/core/planner.ts` | `chooseChunkSize`, `planChunks`, `validateChunkMap`, `chooseConnections` |
| `src/main/core/task.ts` | The download lifecycle (probe → plan → transfer → verify → finalise) |
| `src/main/core/writer.ts` | `SparseFileWriter` (fsync barrier) |
| `src/main/core/speed.ts` | `SpeedMeter` |
| `src/main/util/checksum.ts` | `hashRange`, `verifyFile`, `parseChecksumInput` |
| `src/main/util/paths.ts` | `sanitizeFilename`, `resolveWithin`, `partialPathFor`, `uniquePath`, `moveFile`, `pathExists` |
| `src/main/util/destination.ts` | destination resolution (simplify for CLI) |
| `src/main/util/errors.ts` | `EngineError`, `toEngineError`, `isCanceled` |
| `src/main/util/backoff.ts` | `withRetry` |
| `src/main/util/rateLimiter.ts` | GCRA `CompositeRateLimiter` |
| `src/main/util/diskUsage.ts` | `ensureDiskSpace` |
| `src/shared/types.ts` | `Chunk`, `Download`, `DownloadId`, `ChecksumSpec` |
| `src/shared/constants.ts` | chunk sizes, partial suffix, etc. |
| `src/shared/schemas.ts` | zod schemas (adapt for CLI) |
| `src/main/core/recovery.ts` | crash recovery (rewind margin, re-digest) |
| `cli/` | the existing standalone core and fault lab — read first |
| `scripts/moth-mcp.mjs` | the existing MCP server — read first |

**Rule:** port the *logic*, not the Electron coupling. The core must have zero
imports from `electron`. Everything in `src/main/` that touches Electron stays
in Moth.

---

## 4. Architecture

### Process model

Single process, single-threaded async. No daemon, no background service. State
lives on disk. Each invocation is independent and reads/writes the shared state
DB. Concurrency between invocations is handled by SQLite's WAL mode + busy
timeout.

```
agent-dl (Node 22+)
├── core/          pure logic: http, planner, writer, task, recovery, checksum, paths, errors, backoff, rateLimiter, diskUsage
├── state/         state DB (node:sqlite), per-download records, chunk map
├── cli/           command parsing, output formatting, exit codes
├── mcp/           MCP server (stdio transport)
└── shared/        types, constants, schemas
```

### Durability invariants (non-negotiable; copied from Moth)

1. **fsync before commit.** A chunk is marked `complete` in SQLite only after
   its bytes are `fsync`'d to disk. `synchronous=FULL` + WAL.
2. **Bitmap, not counter.** Progress is a range bitmap; the live byte total is
   separate and includes in-flight bytes.
3. **Rewind margin.** On resume, rewind `REWIND_SAFETY_BYTES` (1 MiB) before
   restarting a partially written range.
4. **If-Range identity check.** Strong ETag or Last-Modified must still match;
   otherwise discard progress rather than mix bytes.
5. **Staged promotion.** In-flight files are `<name>.part`; renamed to final
   only after verification.
6. **Path containment.** Every path derived from remote input passes through
   `resolveWithin`.
7. **Secret redaction.** Signed query strings never reach disk in logs.
8. **No silent protocol fallback.** Direct HTTP stays direct HTTP.

### Storage layout

```
~/.agent-dl/
├── state.db              SQLite (WAL): downloads, chunks, history
├── state.db-wal / -shm   WAL sidecars
├── logs/
│   └── agent-dl.log      newline-delimited JSON, rotating
├── cache/                (reserved)
└── (partial files live next to their destinations as <name>.part)
```

Config file: `~/.agent-dl/config.json` (optional overrides).

Environment variables (all optional, prefixed `AGENT_DL_`):
`AGENT_DL_CONNECTIONS`, `AGENT_DL_SPEED_LIMIT`, `AGENT_DL_QUOTA`,
`AGENT_DL_DOWNLOAD_DIR`, `AGENT_DL_LOG_LEVEL`, `AGENT_DL_STATE_DIR`.

---

## 5. CLI contract

### Binary name

`agent-dl` (npm bin). Aliases: `adl`.

### Global flags

```
--json          Emit a single JSON object to stdout on completion (success or failure).
--jsonl         Stream JSONL progress events to stdout; final result on the last line.
--quiet         No progress output (errors still go to stderr).
--config <path> Override config file.
--state-dir <d> Override ~/.agent-dl.
--log-level <l> error|warn|info|debug (default info).
--no-color      Disable ANSI.
--version       Print version and exit.
--help          Print help and exit.
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic failure |
| 2 | Invalid arguments / usage |
| 3 | Network failure (retryable class) |
| 4 | Checksum mismatch (file discarded) |
| 5 | Disk full / I/O error |
| 6 | Unsupported (no Range, etc.) |
| 7 | Interrupted (SIGINT/SIGTERM) — partial kept, resumable |
| 8 | Not found (resume candidate, file) |

### Commands

#### `download <url> [options]`

```
agent-dl download <url>
  -o, --out <path>            Destination directory or full file path (default: cwd)
  -n, --name <filename>       Override the filename
  -c, --connections <n>       Parallel range connections (1-32, default 8)
  --checksum <algo:value>     Expected checksum (md5|sha1|sha256|sha512|fast)
  --headers <json>            Custom headers as a JSON object
  --no-verify                 Disable checksum verification (not recommended)
  --resume / --no-resume      Resume from partial (default true)
  --overwrite                 Replace an existing final file
  --category <name>           Auto-categorise into a subfolder
  --quota <bytes>             Stop after N bytes saved
  --speed-limit <bps>         Throttle (bytes/sec)
  --timeout <ms>              Per-request timeout (default 30000)
  --max-retries <n>           (default 5)
  --user-agent <str>
  --dry-run                   Probe + plan only; print plan, download nothing
  --idempotent                Skip if the final file already exists and verifies
  --json / --jsonl / --quiet
```

**JSON result (stdout, when `--json`):**
```json
{
  "schema": "agent-dl/1",
  "command": "download",
  "status": "completed",
  "id": "uuid",
  "url": "https://example.com/file.bin",
  "finalPath": "/abs/path/file.bin",
  "size": 12345,
  "checksum": { "algorithm": "sha256", "value": "abc…" },
  "durationMs": 1234,
  "resumed": false,
  "verified": true
}
```

On failure:
```json
{
  "schema": "agent-dl/1",
  "command": "download",
  "status": "failed",
  "id": "uuid",
  "code": "CHECKSUM_MISMATCH",
  "message": "...",
  "retryable": false,
  "finalPath": null
}
```

**JSONL progress (when `--jsonl`):** one object per line to stdout:
```json
{"event":"progress","id":"...","downloadedBytes":1000,"fileSize":5000,"speed":12345,"eta":10,"chunksComplete":2,"chunksTotal":8}
{"event":"finished","id":"...","finalPath":"...","size":5000,"verified":true}
```

**Human mode (default):** a progress bar on stderr? No — progress goes to stderr so stdout stays clean for piping. Default prints a compact progress line to stderr and a one-line summary on success.

#### `status <id-or-path> [--json]`
Prints the current state of a download (queued / downloading / paused / completed
/ failed, bytes, speed, eta, chunks).

#### `list [--status <state>] [--json]`
Lists downloads. Default: human table. `--json`: array of download records.

#### `cancel <id> [--delete]`
Cancels an in-flight or queued download. `--delete` removes the partial file.

#### `verify <path> --checksum <algo:value>`
Verifies a file against a checksum. Exit 0 on match, 4 on mismatch.

#### `resume <id-or-path> [--json]`
Resumes a paused/failed download.

#### `inspect <url> [--json]`
Probes a URL (HEAD + ranged GET fallback) and prints metadata (size, accept-ranges,
etag, content-type, filename) without downloading.

#### `doctor`
Environment self-check: Node version, state dir writable, disk space, network.
Prints JSON in `--json` mode.

#### `tail [--follow]`
Tails the structured log (human-friendly). `--json` for raw JSONL.

### Rules for all commands

- **Never prompt.** Agents cannot answer. Every confirmation is a flag.
- **Logs to stderr, data to stdout.** So `agent-dl download url --json | jq` works.
- **No ANSI in `--json`/`--jsonl`/`--quiet` mode.**
- **Stable exit codes** (table above).
- **Idempotent by default for `download`:** if the final file exists and its
  checksum matches the expected (or a stored checksum from a prior run), skip
  and return success with `status: "skipped"`.

---

## 6. MCP server contract

Transport: **stdio** (the standard for local MCP). Binary: `agent-dl mcp` (or a
separate `agent-dl-mcp` entry point).

### Tools

| Tool | Args | Returns |
|---|---|---|
| `download` | `url`, `destination?`, `connections?`, `checksum?`, `headers?`, `overwrite?` | `{ id, finalPath, size, verified, checksum }` |
| `status` | `id` | `{ id, status, downloadedBytes, fileSize, speed, eta, chunksComplete, chunksTotal }` |
| `list` | `status?` | array of download records |
| `cancel` | `id`, `deletePartial?` | `{ ok }` |
| `verify` | `path`, `checksum` | `{ ok, actual }` |
| `inspect` | `url` | metadata object |
| `resume` | `id` | result |

### Resources

- `download://<id>` — current status JSON.
- `download://<id>/progress` — streaming progress (if the client supports it).

### Conventions

- Tool results are JSON. Errors are returned as `{ error: { code, message } }`
  with the same codes as the CLI exit codes, so an agent can branch on them.
- The MCP server shares the same state DB as the CLI, so a download started
  from the CLI is visible to the MCP server and vice versa.

---

## 7. Core library design

### Modules (mirror Moth, simplified)

```
src/
├── core/
│   ├── http.ts          probe, openRange, redirect following, If-Range, range validation
│   ├── planner.ts       chooseChunkSize, planChunks, validateChunkMap, chooseConnections
│   ├── task.ts          DownloadTask: probe → plan → transfer → verify → finalise
│   ├── writer.ts        SparseFileWriter (fsync barrier)
│   ├── recovery.ts      crash recovery: inspect disk, load map, re-digest, rewind
│   ├── speed.ts         SpeedMeter
│   ├── rateLimiter.ts   GCRA
│   └── backoff.ts       withRetry
├── util/
│   ├── checksum.ts      hashRange, verifyFile, parseChecksumInput
│   ├── paths.ts         sanitizeFilename, resolveWithin, partialPathFor, uniquePath, moveFile, pathExists
│   ├── destination.ts   resolve destination (simplified: no categories unless requested)
│   ├── errors.ts        EngineError, toEngineError, isCanceled
│   ├── diskUsage.ts     ensureDiskSpace
│   └── logger.ts        structured JSON logger (stderr)
├── state/
│   ├── db.ts            node:sqlite open + migrate
│   ├── schema.ts        migrations
│   └── repos.ts         DownloadRepository, ChunkRepository
├── cli/
│   ├── main.ts          entry point, arg parsing, dispatch
│   ├── output.ts        JSON/JSONL/human formatting
│   └── commands/        one file per command
├── mcp/
│   └── server.ts        MCP server (stdio)
└── shared/
    ├── types.ts
    ├── constants.ts
    └── schemas.ts        zod
```

### Durability invariants (copy verbatim into the new repo's AGENTS.md)

> A chunk is marked `complete` in SQLite only after its bytes are `fsync`'d to
> disk. Progress is a bitmap, not a counter. On resume, rewind 1 MiB. Send
> `If-Range` and discard progress on identity mismatch. Stage as `.part` and
> promote only after verification. Contain all remote-derived paths. Redact
> secrets in logs. No silent protocol fallback.

### State DB schema (minimal)

```sql
CREATE TABLE downloads (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  final_url TEXT,
  filename TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  final_path TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  accept_ranges INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  content_type TEXT,
  status TEXT NOT NULL,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  expected_algorithm TEXT,
  expected_checksum TEXT,
  computed_checksum TEXT,
  resumed_by_sampling INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 5,
  error_code TEXT,
  error_message TEXT,
  speed_limit INTEGER,
  quota_bytes INTEGER,
  scheduled_start_at INTEGER,
  connections INTEGER,
  headers TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL,
  bytes_written INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  checksum TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (download_id, idx)
);

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
```

WAL mode, `synchronous=FULL`.

### Concurrency

- Global concurrency: 3 (configurable).
- Per-download connections: 8 (configurable, 1-32).
- A simple in-process queue; cross-process coordination is via the state DB
  (SQLite busy timeout). Two simultaneous invocations on the same download
  serialize on the row lock.

---

## 8. Observability ("keep up with what agents are doing")

Humans want to see what their agents are fetching. Provide:

- `agent-dl status <id>` and `agent-dl list` — current state.
- `agent-dl tail` — follow the structured log (human-friendly, or `--json`).
- **Per-download state files** in `~/.agent-dl/state/<id>.json`, updated on
  every progress tick, so a human can `watch`/`tail` them or a dashboard can
  poll them without SQLite.
- Tag agent-driven downloads: if `AGENT_DL_AGENT=<name>` is set, store it and
  show it in `list`/`status`.
- Optional: write a single `~/.agent-dl/summary.json` with counts and the
  current throughput, updated on progress.

The desktop Moth app can later read this state dir and show agent downloads as
a tagged queue — but that's a later integration. Keep the CLI standalone first.

---

## 9. Testing strategy (reuse Moth's)

- **Unit:** pure logic — planner, checksum, paths, rate limiter, backoff,
  sanitize, exit-code mapping. No I/O.
- **Integration:** real local HTTP server (`test/helpers/testServer.ts` style)
  that can drop sockets, ignore Range, change bodies, truncate, redirect.
  Real disk, real SQLite.
- **Fault lab:** keep Moth's `cli/` fault-lab approach for chaos testing.
- **No live network in tests.** Ever.

Before finishing any change:
```
npm run typecheck
npm test
```

---

## 10. Milestones

### M1 — Core library (port from Moth)
- Port `http`, `planner`, `writer`, `task`, `recovery`, `checksum`, `paths`,
  `errors`, `backoff`, `rateLimiter`, `diskUsage`.
- Adapt types/constants/schemas.
- State DB + migrations.
- Unit tests for planner, checksum, paths, errors.
- **Exit:** `node -e "import('./dist/core/task.js')"` works; a programmatic
  download + verify succeeds against a local server.

### M2 — CLI surface
- Arg parsing (`util.parseArgs`), dispatch, output (JSON/JSONL/human), exit codes.
- `download`, `status`, `list`, `cancel`, `verify`, `resume`, `inspect`,
  `doctor`, `tail`.
- `--dry-run`, `--idempotent`, env vars, config file.
- Integration tests: full download, resume after kill, checksum mismatch,
  no-Range server, path containment, exit codes.
- **Exit:** `agent-dl download <local-server-url> --json` returns a valid result
  and exit 0; a killed-and-resumed download verifies.

### M3 — MCP server
- `agent-dl mcp` (stdio transport).
- Tools: download, status, list, cancel, verify, inspect, resume.
- Resources: `download://<id>`, `download://<id>/progress`.
- Test against a real MCP client (Claude Desktop / Cursor).
- **Exit:** an agent can download a file through MCP and get a verified result.

### M4 — Observability + polish
- Per-download state files, `tail`, agent tagging, summary file.
- `doctor` command.
- Packaging: `npm install -g`, plus a single executable via Node SEA for
  users without Node.
- Docs: README, man page, examples for common agent frameworks.
- **Exit:** `npm install -g .` works on a clean machine; `agent-dl doctor`
  passes.

### M5 — Optional Moth integration
- Moth reads the agent state dir and shows agent downloads as a tagged queue.
- Or: agent CLI POSTs to Moth's ingest endpoint to hand off to the desktop app.
- **Exit:** a download started by an agent appears in Moth's UI.

---

## 11. Packaging & distribution

- **npm package:** `"bin": { "agent-dl": "dist/cli/main.js" }`. Zero runtime
  deps for the core; the MCP SDK is the only runtime dep (and only loaded by
  `agent-dl mcp`).
- **Single executable (optional):** Node 22's `--experimental-sea-config` can
  bundle everything into one binary. Useful for agents running in containers
  without Node.
- **No native addons.** `node:sqlite` for state.
- **Versioning:** semver. The CLI prints `agent-dl/1.x.y`.
- **License:** MIT (match Moth).

---

## 12. Naming suggestions

- `agent-dl` (clear, agent-first)
- `moth-cli` (ties to the desktop product)
- `fastdl` / `verified-dl` (feature-first)

Recommend `agent-dl` for the binary and `@scope/agent-dl` for the package. The
MCP server can be `agent-dl-mcp` or just `agent-dl mcp`.

---

## 13. What NOT to build (scope fence)

If someone (human or AI) proposes these, push back:

- A GUI or tray icon.
- Torrent support.
- A media pipeline (yt-dlp/FFmpeg).
- Browser integration / cookie import.
- Auto-update (v1).
- Multi-URL mirroring.
- HLS / segmented playback.
- DRM handling of any kind: no decryption, and no refusal either.
- Cloud sync of state.

---

## 14. Integration with Moth (the desktop app)

Two bridges are possible; pick one later:

1. **Shared state dir.** Moth reads `~/.agent-dl/state/` and shows agent
   downloads as a tagged queue. Loose coupling, both stay independent.
2. **Ingest handoff.** The agent CLI POSTs to Moth's loopback ingest endpoint
   (`/api/v1/downloads`) when Moth is running, delegating to the desktop app's
   engine. Tighter coupling, but reuses Moth's richer UI.

Start with (1) — it's simpler and keeps the CLI standalone.

---

## 15. Handoff notes for the implementing AI

- **Read Moth's `cli/` directory and `scripts/moth-mcp.mjs` first.** They are
  the starting point; do not rewrite from scratch.
- **Read Moth's `AGENTS.md` and `CONTRIBUTING.md`** for the invariants and the
  validation gate (`npm run typecheck`, `npm test`, `git diff --check`).
- **Port logic, not Electron.** Anything importing `electron` stays in Moth.
- **The durability invariants in §4 are load-bearing.** Do not weaken fsync
  ordering, If-Range checks, staged promotion, or path containment to gain
  speed.
- **No native addons.** `node:sqlite` for state; `node:fs`, `node:https`,
  `node:zlib` for everything else.
- **Tests use real I/O.** Real local HTTP server, real files, real SQLite. No
  mocks for transfer paths.
- **No live network in tests.**
- **Exit codes are a contract.** Once shipped, don't change them.
- **JSON schemas are a contract.** Version them (`agent-dl/1`) and never break
  a field without a major version.
- **Never prompt.** Agents cannot answer.
- **Logs to stderr, data to stdout.** Always.

### First task for the new repo

1. `mkdir agent-dl && cd agent-dl && npm init -y`
2. Set `"type": "module"`, `"engines": { "node": ">=22.5.0" }`.
3. Copy Moth's `cli/` core + `scripts/moth-mcp.mjs` as a starting point.
4. Implement M1 (core library) with unit tests before touching the CLI.
5. Add the `AGENTS.md` from Moth (adapted) so the invariants are documented.

---

## 16. Open questions (decide before starting)

1. **Name.** `agent-dl` vs `moth-cli` vs something else.
2. **MCP SDK dependency.** Accept `@modelcontextprotocol/sdk` (pure JS, standard)
   or hand-roll the protocol (smaller, more work). Recommend the SDK.
3. **Single binary.** Is Node SEA worth it for v1, or is `npm install -g` enough?
4. **Shared state with Moth.** Defer to M5; start standalone.
5. **Agent tagging.** `AGENT_DL_AGENT` env var vs a `--agent` flag vs both.

---

*End of plan.*
