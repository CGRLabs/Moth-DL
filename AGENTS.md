# Agent guidance

## Protect the existing project

- `mothwebsite.html` at the repo root is the **official website for Moth Download Manager**. It is a static companion page, not generated from the app. Keep its version, theme list, engine claims, and recovery/limit statements in sync with `package.json`, `src/`, and `README.md` when user-facing behavior changes. Midnight is intentionally listed there ahead of implementation; do not remove it.
- Read `CONTRIBUTING.md`, `README.md`, and the relevant design note in
  `docs/` before changing project architecture or user-facing guarantees.
- This checkout may contain unrelated user changes. Inspect status and diffs,
  preserve them, and do not clean, reset, or delete unrelated work.
- Prefer narrow, testable changes. Do not expand the app's feature surface while
  a transfer-integrity issue remains unresolved.

## Download architecture

- `src/main/core/router.ts` makes deterministic source and transport decisions.
  Keep direct HTTP files, resolved media pages, and YouTube/yt-dlp transfers
  explicit; do not add silent protocol fallbacks.
- The direct HTTP path is implemented in `src/main/core/task.ts` and
  `src/main/net/httpClient.ts`. Reuse existing range, redirect, `If-Range`,
  recovery, and writer helpers rather than duplicating them.
- The YouTube path uses yt-dlp fragments and FFmpeg processing in
  `src/main/video/`. Never mark a video complete based only on process success
  or nonzero file size: verify required streams and decode the staged output.
- BitTorrent is a separate engine in `src/main/torrent/`, not a variant of the
  HTTP downloader. It runs a bundled Transmission daemon over a loopback-only
  RPC endpoint and tracks piece state, not chunk state. Seeding stops because
  `task.ts` issues `torrent-stop` on completion — there is no setting that
  enforces it; do not reintroduce seed-ratio keys into the daemon config.
- Treat remote metadata and media files as untrusted. Preserve the durable
  fsync-before-commit ordering, source identity checks, staged promotion, path
  containment, and secret-redaction behavior.

## Validation

- Run the narrowest affected tests first; for transfer or recovery changes,
  prefer real local HTTP servers, temporary files, and the test database.
- For YouTube media changes, use generated local FFmpeg fixtures where
  available; keep automated tests independent of a live provider.
- Before finishing, run `npm run typecheck`, affected Vitest tests, and
  `git diff --check`. Run `npm test -- --run` when changes affect shared
  application behavior.
- The separate direct-download CLI lives under `cli/`; test it with
  `npm --prefix cli test`. Do not couple it to Electron or the app database
  unless the user asks for that architectural change.
- `scripts/moth.mjs` drives a running app over its loopback ingest endpoint and
  prints JSON. It defaults to the dev profile at `%APPDATA%/moth-dlm`; pass
  `--profile="<dir>"` to target a packaged build. Never point it at the real
  profile when booting.

## Desktop app build

- `npm run build` only updates generated files under `out/`; it does not update
  the packaged app launched by the user's Desktop icon.
- When a user expects to try changes from the Desktop or Start Menu shortcut,
  run `npm run package`. This creates the canonical unpacked Windows app under
  `release/autopair-build/win-unpacked/`; its postbuild step refreshes both
  shortcuts through `npm run shortcut`.
- After packaging, verify that `Moth Download Manager.lnk` on the Desktop points
  to `release/autopair-build/win-unpacked/Moth Download Manager.exe` and that
  the target exists. Do not assume a successful renderer build updated the
  installed app or an older shortcut target.
