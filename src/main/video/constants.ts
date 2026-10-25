/**
 * Pinned helper binaries for video-capture slice 1.
 *
 * Helpers are fetched into `<userData>/bin/` (or the `helperDir` settings
 * override) only when needed and are not bundled. yt-dlp is needed to resolve
 * media pages; FFmpeg is fetched later only for conversion or track muxing.
 * Versions are pinned here and in `src/shared/constants.ts`; updates are
 * explicit (prompt-on-breakage), never silent auto-drift.
 *
 * URL maintenance rule: whenever the pinned version is bumped, re-verify
 * every URL below and record the SHA-256 digest from the vendor's published
 * checksum file. A `null` digest means the vendor does not publish a stable
 * hash for that artefact — verification is then skipped with a warning and
 * the failure message names the manual fallback.
 */

export interface HelperAsset {
  /** File name of the binary (or archive) on disk. */
  fileName: string
  /** Where to fetch it for the pinned version. */
  url: string
  /** SHA-256 hex digest when the vendor publishes one, else `null`. */
  sha256: string | null
  /** Vendor page where the user can fetch the binary by hand. */
  manualPage: string
}

export interface FfmpegAsset extends HelperAsset {
  /** Name of the transcoder binary once it is in place. */
  binaryName: string
}

/** Official yt-dlp release page (also the manual fallback for every OS). */
export const YT_DLP_RELEASES_PAGE = 'https://github.com/yt-dlp/yt-dlp/releases'

function ytDlpUrl(version: string, asset: string): string {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${asset}`
}

/** Standalone resolver binary per OS. Ships as a single file, no extraction. */
export function ytDlpAssetFor(platform: NodeJS.Platform, version: string): HelperAsset {
  if (platform === 'win32') {
    return {
      fileName: 'yt-dlp.exe',
      url: ytDlpUrl(version, 'yt-dlp.exe'),
      // Record the digest from the release's SHA2-256SUMS when bumping the pin.
      sha256: null,
      manualPage: YT_DLP_RELEASES_PAGE
    }
  }
  if (platform === 'darwin') {
    return {
      fileName: 'yt-dlp_macos',
      url: ytDlpUrl(version, 'yt-dlp_macos'),
      sha256: null,
      manualPage: YT_DLP_RELEASES_PAGE
    }
  }
  return {
    fileName: 'yt-dlp',
    url: ytDlpUrl(version, 'yt-dlp'),
    sha256: null,
    manualPage: YT_DLP_RELEASES_PAGE
  }
}

/**
 * Official FFmpeg builds per OS (never a fork, always the vendor build).
 *
 * These artefacts are archives: extraction runs automatically on first use
 * (system `tar` first, built-in zip reader as fallback — see `extract.ts`).
 * When extraction itself fails the error still names the archive path, the
 * expected binary name and the vendor page as a manual fallback.
 */
export function ffmpegAssetFor(platform: NodeJS.Platform, version: string): FfmpegAsset {
  if (platform === 'win32') {
    return {
      // Gyan's release-essentials ZIP is versioned by build date, not by a
      // stable version string: re-verify this URL whenever `version` is bumped.
      fileName: 'ffmpeg-release-essentials.zip',
      url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
      sha256: null,
      manualPage: 'https://www.gyan.dev/ffmpeg/builds/',
      binaryName: 'ffmpeg.exe'
    }
  }
  if (platform === 'darwin') {
    return {
      fileName: `ffmpeg-${version}.zip`,
      url: `https://evermeet.cx/ffmpeg/ffmpeg-${version}.zip`,
      sha256: null,
      manualPage: 'https://evermeet.cx/ffmpeg/',
      binaryName: 'ffmpeg'
    }
  }
  return {
    // BtbN tags are rolling `autobuild-YYYY-MM-DD` snapshots, not versions —
    // a `releases/download/n<version>/…` URL 404s (verified 2026-09-29). The
    // johnvansickle static build is one stable URL for latest-release; the
    // prompt-on-breakage updater (not silent drift) is what keeps it honest.
    fileName: 'ffmpeg-release-amd64-static.tar.xz',
    url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    sha256: null,
    manualPage: 'https://johnvansickle.com/ffmpeg/',
    binaryName: 'ffmpeg'
  }
}

/** Cap on a single response body while fetching a helper (300 MiB). */
export const HELPER_DOWNLOAD_CAP_BYTES = 300 * 1024 * 1024
export const HELPER_DOWNLOAD_TIMEOUT_MS = 2 * 60_000

/** Cap on a resolver dump held in memory (24 MiB of `-J` JSON is plenty). */
export const RESOLVER_OUTPUT_CAP_BYTES = 24 * 1024 * 1024

/** Resolver subprocess timeout: listing formats must not hang a grab. */
export const RESOLVER_TIMEOUT_MS = 45_000

/** Transcoder subprocess timeout: a long source file encodes for a while. */
export const TRANSCODE_TIMEOUT_MS = 30 * 60_000
