# Moth browser extension

Lets your browser hand downloads to Moth Download Manager, so they can be
paused, resumed, throttled and retried instead of living in the browser's
fragmented download shelf.

---

## Why an extension is required

This is worth being blunt about, because it is the most common question about
download managers:

**A desktop application cannot silently intercept Chrome's downloads.** There is
no OS hook, no protocol registration, and no "default download handler" slot that
a native app can occupy. Browsers deliberately do not expose their download
pipeline to extensions-free native code.

Every serious download manager solves this the same way — IDM, JDownloader,
Free Download Manager and Xunlei all ship a browser extension. This is that
extension, doing the same job.

What Moth *can* do natively, and does: a **token-protected endpoint on
`127.0.0.1`** that the extension posts URLs to. Moth only listens while it is
running, and only on loopback.

## Supported browsers

| Browser | Build | Notes |
|---|---|---|
| Chrome, Edge, Brave, Opera, Vivaldi | `chrome/` | Manifest V3 service worker |
| Firefox 115+ | `firefox/` | MV3 background page |

---

## Installation

### Chrome / Edge / Brave / Opera / Vivaldi

1. In Moth → **Settings → Browser integration → Manual setup and
   troubleshooting**, click **Prepare guided Chrome setup on Desktop**.
   Moth creates and opens `Moth Chrome Extension Setup`, with a visual guide
   and the unpacked extension in its `extension/` subfolder.
2. Follow `INSTALL.html` in the folder, or open `chrome://extensions` (or
   `edge://extensions`) in the browser.
3. Enable **Developer mode**, click **Load unpacked**, and select the
   `extension/` subfolder (the one containing `manifest.json`).
4. Keep the Desktop folder in place while the extension is installed; Chrome
   loads the extension files directly from it. Remove the extension in Chrome
   before deleting the folder.
5. In the extension popup, enter the port and pairing token shown in Moth
   Settings, then choose **Save & test**. Unpacked development installs have a
   different browser identity and do not use automatic pairing.

### Firefox

1. Open Moth → **Settings → Browser integration**.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**
4. Select the `firefox/manifest.json` file inside the `firefox` folder.
   (Firefox temporary add-ons are removed on restart; for a permanent install
   sign the extension or submit it to addons.mozilla.org.)

---

## Automatic install and pairing (Windows, Chromium browsers)

When browser integration is enabled, Moth can register the signed companion
extension package for detected Chrome, Edge, and Brave browsers:

1. The packed `tiri.crx` (shipped with the app) is staged to a stable path,
   `%APPDATA%\moth-dlm\extension\tiri.crx`. Registry `path` values must never
   point into `release\` or temp directories, which move between updates.
2. For each detected browser Moth writes
   `HKCU\Software\<Vendor>\…\Extensions\<32-char-id>` with `path` and `version`
   (`REG_SZ`) via `reg.exe`. No admin rights needed; it is all under `HKCU`.
3. Restart the browser and check its extensions page. A registry entry only
   records the local install request; it does not prove the browser accepted,
   loaded, or enabled the extension. Chromium may block local CRX installs.
4. If the browser accepts and enables it, the signed extension discovers Moth and pairs itself. No
   port or token copy/paste is needed. Pairing is refreshed after app/browser
   restarts and token rotation. This automatic pairing applies to the signed
   Chromium extension; manual/unpacked and Firefox installs use the token shown
   in Settings.

The panel reports registry state, not whether the browser loaded the extension:
`registered (1.1.3)`, `registered <old> — app ships <new>`, `not registered`,
or `not detected`. A regular Chrome installation without Developer mode needs
the extension distributed through the Chrome Web Store. Force-install policies
are intended for browsers managed by an administrator; Moth does not change
browser policies or bypass browser approval. For local development testing,
use the unpacked extension steps above.

### For maintainers: packing a release

The `.crx` is produced by `npm run pack:extension`, which shells out to the
locally installed Chrome (`chrome.exe --pack-extension`). It needs:

- **Chrome** on the packing machine (else the script fails loudly).
- **The `.pem` key**, generated exactly once (`--init-key`) and stored
  **outside the repo** at `%APPDATA%\moth-dlm\extension-key\moth.pem`
  (override with `--key=` or `MOTH_EXTENSION_KEY`). The extension ID derives
  from this key, so key stability = ID stability. **Back it up:** losing the
  key mints a new identity and every user must enable a "new" extension.
  `*.pem` is gitignored; the public ID is recorded in
  `browser-extension/extension-id.txt` so future packs refuse a wrong key.

Bumping the extension version: edit `chrome/manifest.json` and re-run the pack.
The registry `version` must match the `.crx`, or the browser ignores the entry.
The extension content scripts are plain classic scripts loaded in manifest
order; keep helper files module-free and run `npm run test:extension` after
changing them.

---

## Using it

**One-off (always available).** Right-click any link, image, video or audio
element and choose **Download with Moth**. The browser never starts the
transfer; Moth does, so it is resumable and throttled.

**Quality picker.** When one player offers several discrete files (multiple
`<source>` elements), the badge opens a picker instead of guessing: each row
shows the author's label when the page provides one (`label`, `title`,
`data-quality`), otherwise the filename, with the currently playing file
marked. Playlists, HLS manifests and `blob:` stubs are never offered, because
Moth cannot fetch them — offering them would be a lie.

**Pages with no direct file.** A player backed by streaming playback (no
downloadable URL) offers video quality caps from 360p to 2160p and **Audio
(MP3)**. Picking one sends the *page* to Moth, which resolves and fetches it
through its normal engine. On YouTube, the labeled **Download** button stays
visible while playback is active; click it for the quality choices. Labels stay
generic on purpose.

**Experimental site adapters.** The extension exposes a small, opt-in
experimental hint layer for social or media-heavy sites. It is intentionally
separate from the main media detection path and is disabled by default; it only
surfaces candidate media URLs and site metadata so future adapters can be added,
tested, or removed without regressing the stable file-download flow. The current
site adapter contract is documented in `docs/SITE-ADAPTERS.md` and can be
improved or removed by future AI or human contributors without altering the core
engine.

**Find media on this page.** Open the extension popup and choose **Scan current
page**. On that explicit request, Moth checks media elements and their declared
sources, media links, common page metadata, and browser-reported resource URLs.
It lists recognizable direct files and always offers the existing page resolver
for video or audio, with the available video quality caps; when no media signal
was found, those choices are labeled best-effort. You can also paste a page URL and choose **Resolve video** or
**Resolve audio**, even when the scan cannot identify a player. It does not
monitor or record page traffic in the background. Right-clicking a video/audio
also uses its direct source when available, and otherwise tries resolving the
frame's page URL.

Scanning is best-effort: sites that hide their player in a cross-origin frame
or use unsupported extraction may not be capturable. Streams are passed through
as bytes; Moth does not decrypt playback. HLS/DASH manifests are not sent as
ordinary files; the page resolver may be able to extract a usable stream from
ordinary files; the page resolver may be able to extract a usable stream from
the page, depending on the site. When a video is exposed as separate video and
audio tracks, Moth downloads the video through its normal resumable engine and
uses FFmpeg to mux the audio track into the finished file (up to 720p).
The extension already needs access to web
pages to provide its existing hover badge; this scan adds no broader browser
permissions. The manifests request matching `http`/`https` page access for the
badge. You can restrict that access in the browser's extension site-access
settings, but the badge and scan will only work on sites you allow.

**If Moth isn't running.** A send that fails (closed app, wrong port) does not
die in a notification: the extension hands the URL to the OS as a `moth://`
link, which cold-starts Moth and queues the download on boot. The old
Explicit sends can use the OS link even before the extension has a saved API
token. A failed automatic handoff still leaves the browser download alone.
The OS must have Moth registered for `moth://` links; on Windows, open Moth
once to register it before relying on cold-start links.

**Automatic.** Turn on *Send every download to Moth automatically* in the
extension popup. From then on each new supported `http`/`https` download is:

1. accepted by Moth over the loopback endpoint, and only then
2. cancelled in the browser.

That ordering matters. If Moth is not running, or the token is wrong, the
browser download is **left alone** rather than lost — the extension logs a
warning and does nothing.

Excluded sites and file extensions apply consistently to automatic handoff,
right-click, manual URL sends, page scans, and the in-page media badge.
Excluding a type never cancels the browser's own download. The feature remains
opt-in and the browser download is cancelled only after Moth accepts the
handoff.

The toolbar badge shows connection state: blank for connected, `!` for a
connection problem that needs checking, and `?` for "not paired".

The popup's **Test** reports more than a generic failure: it distinguishes a
missing token, a rejected token, an invalid port, a different service on that
port, and Moth found on another default port. If no Moth listener can be found,
the app may be closed or Browser integration may be disabled; check
**Settings → Browser integration** in Moth. The extension does not change the
app token or enable integration on its own.

### If Moth isn't running

Clicking **Download with Moth** while the app is closed no longer ends in a
"Moth is not running" dead end. The browser opens a
`moth://download?url=<urlencoded>&format=<video|audio>` link instead of posting
to the loopback endpoint:

1. The OS launches Moth — or reuses the running instance (the single-instance
   lock means there is ever only one).
2. Moth validates the link (`http`/`https` target only; foreign schemes,
   wrong paths and unknown formats are ignored) and queues the download.
3. The main window opens on the new download.

The `format` parameter carries the picker's choice (`video` for a plain link,
`audio` when the MP3 row was chosen); when absent, the download queues as
video.

Registration is per-OS, not per-browser: Moth registers the `moth://` handler
on Windows at startup, and **Settings → Browser integration → Cold-start from
browser** shows `registered` / `not registered` with a **Re-register** button
for when another app steals the scheme. macOS and Linux report the row as
unavailable. If the link reaches no registered app, the browser shows its
usual unknown-protocol prompt and nothing is queued — re-register and click
again.

---

## Security

The endpoint is a local HTTP surface, so it is treated as hostile:

- **Loopback only.** Moth binds `127.0.0.1` and never `0.0.0.0`, so nothing on
  your LAN or the internet can reach it.
- **32-byte CSPRNG token** in an `X-Moth-Token` header, compared in constant
  time. Generated on first run; regenerable from the settings panel.
- **`http`/`https` only.** `file:`, `javascript:`, `data:` and UNC paths are
  rejected. It is not a general-purpose proxy — it never fetches anything
  itself, it only hands the URL to the engine.
- **Bounded request bodies** (64 KB); anything larger is rejected, not truncated.
- **Only alive while Moth runs.** Close the app and the port is closed.
- The extension does not request browser-cookie access and does not read or
  forward cookies. It sends the selected URL and referring page; a site that
  requires browser-session cookies may need to be downloaded through the
  browser instead.
- Media metadata is read from the page only after the user activates a media
  grab. The extension does not monitor network traffic or record browsing
  history in the background.
- The browser grants matching web-page access so the existing hover badge and
  explicit media scan work. The only host permission for extension-to-app
  requests is `http://127.0.0.1/*`; it does not need access to `localhost` or
  other network hosts for handoff.

Regenerating the token immediately invalidates any extension already paired.

---

## Troubleshooting

**"Moth is not responding"** — the app is closed, or the port is wrong. Check
Moth → Settings → Browser integration; if it says a different port than 24678
(another program had it), use the number it shows.

**"not paired"** — keep Moth open with browser integration enabled, then reopen
the extension popup or wait for its periodic local discovery. Manual pairing
remains available by copying the port and token from Moth Settings.

**Chrome cancels the download and nothing appears in Moth** — Moth rejected the
URL. Moth only accepts `http`/`https`; `blob:` URLs (common for JavaScript-
generated downloads) and `data:` URLs are refused, because there is no remote
file to range-request.

**A site needs a login** — Moth does not receive browser cookies from the
extension. If the file requires your logged-in browser session, use the
browser's own download or a direct link that Moth can access without those
cookies.

**Extension disappeared after a Firefox restart** — expected for a temporary
add-on. Reinstall it, or sign it for a permanent install.
