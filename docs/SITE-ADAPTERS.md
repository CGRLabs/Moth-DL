# Site adapters

This project keeps the core download engine stable and leaves optional media-site
support in a separate adapter layer. That makes it much easier to add, test, or
remove experimental support for services like TikTok, Facebook, and similar
public media pages without affecting the direct HTTP or YouTube paths.

## Why this exists

The core engine already has the important guarantees:

- direct file downloads follow the resumable chunked transfer path
- YouTube uses yt-dlp + FFmpeg validation before a file is accepted
- media pages are routed through the generic resolver path
- output files are validated before they are marked complete

This adapter layer is intentionally a side feature. The core app still works
without any site-specific media logic.

## How it is structured

The registry is in `src/main/core/siteAdapters.ts`.

- every adapter has an ID, name, host list, and a `matches()` function
- each adapter can be enabled or disabled independently
- adapters are not part of the direct-file path by default
- a future site-specific extractor can plug into the same validation pipeline

### Default behavior

The built-in adapters shipped in this file are intentionally disabled. That keeps
existing behavior unchanged and makes the feature easy to remove later.

## How to add a new site

1. Create a new adapter object in `src/main/core/siteAdapters.ts`.
2. Register it with a unique `id`.
3. Set `enabled` to `false` while you are testing it.
4. Add a `matches()` function for the URL host and pattern.
5. Implement `extract()` to produce a candidate stream or `kind` + `url`.
6. Keep the real validation path in place; do not trust the adapter result alone.

## How to remove a site later

The project is intentionally simple to remove:

- delete the adapter entry from the registry
- remove any test cases that reference it
- remove any related docs or feature flag entries
- ensure the generic media-page resolver can still cover unsupported sites

No global registration system is required beyond this simple registry.

## Safety rules

Do not let an adapter bypass the project’s standard checks:

- verify the media URL is legitimate and contained
- require the normal decode/validation pass before marking a transfer complete
- keep experimental site adapters disabled by default
- treat future media-site support as an optional extension, not the main engine
