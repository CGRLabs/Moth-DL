# Data model and storage

Detailed reference for how Moth persists state. For the process layout and
module boundaries, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Tables

`downloads` holds one row per transfer; `chunks` holds the range bitmap;
`media_metadata` holds resolved tags for a download, one row each.

| `downloads` | | `chunks` | |
|---|---|---|---|
| `id` | PK, uuid | `id` | PK |
| `url`, `final_url` | original URL is re-probed on resume; final URL is retained for display | `download_id` | FK, cascades |
| `temp_path` | `….mothpart` while in flight | `idx` | unique per download |
| `file_size` | 0 = unknown until probed | `start_byte`, `end_byte` | inclusive |
| `etag`, `last_modified` | sent back as `If-Range` | `status` | pending / active / complete |
| `expected_algorithm`, `expected_checksum` | user-supplied | `bytes_written` | checkpoint |
| `priority`, `speed_limit`, `connections` | scheduling | `checksum` | per-chunk digest |
| `status` | 10 states, including review and scheduled | `attempts`, `last_error` | retry bookkeeping |

Migrations are append-only, so an old install upgrades in place without a
re-download.

The database is opened with `journal_mode=WAL` and `synchronous=FULL` so a
committed chunk map survives a hard power cut, not merely an app crash.

## Where files are stored

Everything lives under Electron's `userData` directory:

| Path | Contents |
|---|---|
| `moth.db` | SQLite database (+ `-wal`, `-shm`) |
| `logs/moth.log` | newline-delimited JSON, rotating at 5 MB × 5 files |
| `artwork/` | content-addressed cover images, one per unique hash |
| `.moth/` | reserved for partial-file metadata |

**Completed files** go to your configured download directory (default: the OS
Downloads folder), sorted into category subfolders when auto-categorisation is
on. **In-flight files** are written as `<name>.mothpart` and only renamed to
their final name after the download completes and verifies — so you never see a
half-finished file in your downloads folder.

## How crash recovery works

On startup, before anything else runs:

1. **Inspect the disk.** The partial file's real size is the ground truth for
   how much data exists.
2. **Load the chunk map.** Validate that it covers `[0, fileSize)` contiguously
   with no gaps or overlaps. If not, rebuild it and salvage progress by byte
   range — only ranges *fully* covered by completed chunks are kept, so a new
   chunk is never marked complete with a hole inside it.
3. **Drop anything past the real end of the file.** If the file is shorter than
   the database claims, the tail chunks cannot be trusted.
4. **Re-digest every completed chunk** (capped at 512 MB per download to bound
   startup time). A chunk whose digest does not match is reset and re-downloaded;
   a chunk with no recorded digest gets one recorded so the *next* recovery can
   check it.
5. **Recompute the byte total** from chunks actually verified, and leave the
   download `paused` with its partial file intact.

The report is surfaced in the UI and written to the log. `Rescan disk` in the
toolbar re-runs any of this on demand.

## The ordering rule

A chunk is only marked `complete` in the database *after* its bytes have been
`fsync`'d to disk. Combined with WAL plus `synchronous=FULL`, a committed
`complete` row is a durable promise that the bytes really reached the platter —
which is what makes recovery step 4 safe to trust.