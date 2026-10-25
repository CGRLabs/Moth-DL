# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting instead:

**Security → Report a vulnerability** on this repository
(<https://github.com/realLLUKS/Moth-DL/security/advisories/new>).

You should get an acknowledgement within a few days. Fixes ship as a normal
release, and I will credit you in the advisory unless you would rather stay
anonymous.

## What counts as a vulnerability

Moth downloads and executes things on your machine, so the surface is wider than
it looks. These are in scope:

- **The loopback ingest endpoint.** It binds `127.0.0.1` and is guarded by a
  32-byte token compared in constant time. Anything that lets a web page or a
  local process reach it without the token — or that leaks the token — is a real
  bug.
- **Remote input reaching the engine unvalidated.** Every IPC payload is parsed
  with a zod schema before it reaches the engine, and every path derived from a
  remote filename goes through `resolveWithin`. Bypassing either is a
  path-traversal or remote-command-execution bug.
- **The yt-dlp / FFmpeg pipeline.** Remote metadata and media are treated as
  hostile. Command injection through a filename, URL, or crafted response counts.
- **Resume integrity.** If a download can resume against a *different* remote
  file than it started from, the app will hand you mixed content while claiming
  it verified it. That is the one failure mode this project exists to prevent.

## What is not a vulnerability

- **Content-agnostic transport.** Streams are passed through as bytes; Moth does not inspect, filter, or refuse a payload by what it contains — and never decrypts one.
- **Moth refusing to resume a server without `Range`.** It downloads as a single
  stream and labels itself `no resume`. Working as intended.
- **Progress being discarded when the remote file changed.** Deliberate. Moth
  prefers losing progress over producing a mixed-content file.
- **Other people downloading copyrighted material.** That is between you and
  your jurisdictions. I build the tool; I do not vet what it is pointed at.

## Scope

Windows, macOS and Linux desktop builds, the bundled browser extension, and the
`cli/` core — all in this repository.

Not in scope: third-party components fetched at build time. Transmission is
GPL and shipped as a separate process; report those upstream at
<https://github.com/transmission/transmission>. `yt-dlp` and FFmpeg are
downloaded at runtime; report those to their own projects.