# Changelog

## 1.0.0

Initial release.

- Torrent-style chunked downloads over parallel HTTP `Range` requests, with a
  fsync-before-commit chunk bitmap in SQLite (WAL, `synchronous=FULL`) so a
  kill at 70% resumes with a byte-identical file.
- GCRA speed throttling, exponential-backoff retries, priority queue,
  scheduling, per-chunk heat map, tray, notifications.
- Browser extensions (Chrome MV3, Firefox MV3) posting to a token-protected
  loopback ingest endpoint, plus a download-folder watcher fallback.
- Hand-rolled media tag read/write (ID3v2, MP4 `ilst`, Vorbis) with a
  copy-verify-replace cycle, magic-byte artwork sniffing, and manual overrides.
