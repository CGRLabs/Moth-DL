---
name: download-engine
description: Use when changing Moth's direct HTTP transfer, download router, resume/recovery rules, or YouTube/yt-dlp media pipeline.
---

# Download engine

Use this skill for transfer-integrity work. Read the applicable project
instructions and inspect the current code before editing; do not assume the
desktop path and standalone CLI share an implementation.

## Route by source, then choose a transfer strategy

- `src/main/core/router.ts` owns deterministic source decisions: direct file
  URLs use the HTTP engine, explicitly requested generic media pages use the
  resolver, and YouTube pages use yt-dlp.
- Resolved streams use parallel ranges only when the server advertises range
  support and reports a positive size. Reuse the existing `If-Range` validator
  selection: a usable strong ETag or `Last-Modified` allows safe resume;
  otherwise discard unverified partial progress after interruption.
- Keep routing explainable and logged. Do not use a scoring/ML layer or silently
  fall back between transports. If the current route cannot safely continue,
  fail clearly or restart according to the established rules.

## Preserve direct-download durability

- A completed chunk is committed only after its bytes are synced and checked.
  Preserve the fsync-before-database-commit order and the existing recovery
  validation.
- Validate every range response against the requested offset, total size, and
  source validator. Do not append bytes from an unverified source version.
- Re-evaluate redirects from the original URL on resumed requests so
  cross-origin credential stripping still applies. Never log signed query
  strings, cookies, or authorization values.
- Keep final outputs staged until integrity checks pass; preserve existing
  collision and path-containment protections.

## Make YouTube completion mean playable output

- yt-dlp owns YouTube format selection, fragment transfer, and stream merging;
  do not feed ephemeral signed media URLs into the generic downloader as an
  implicit fallback.
- Pin resume identity to the selected media options. Do not reuse fragments
  after format, quality, or relevant transfer configuration changes.
- Validate the reported output path is within the job work directory. For a
  requested video, require readable video and audio streams and a successful
  full FFmpeg decode before promotion or a `completed` state.
- Normalize incompatible codecs only through a staged output. If conversion,
  merging, or validation fails, surface a failed state and keep recoverable
  source data; never convert a failed post-process into a success.
- Keep audio-only behavior distinct: its expected stream and output format
  differ from video-with-audio requirements.

## Tests and diagnostics

- Prefer real local HTTP servers and filesystem/database integration tests for
  direct transfer, resume, retries, redirects, and cleanup.
- Generate short synthetic media locally for validation tests. Cover valid
  audio/video, missing streams, truncated/corrupt output, failed conversion,
  and the rule that invalid output is never finalized. Tests should not depend
  on YouTube availability; live-provider checks are separate manual checks.
- Include a regression test that would fail on the old behavior. Run focused
  tests, `npm run typecheck`, and `git diff --check`; run the full app suite for
  shared-path changes.
- Keep diagnostics useful but secret-safe: report route, selected strategy,
  format/codec identity where available, bytes, and validation outcome—not
  cookies, credentials, or signed URL query values.
