# Bundled Transmission runtime

Windows x64 release packages include Transmission `4.1.3` as a separate
`transmission-daemon.exe` process, plus the DLLs it requires at runtime.
Transmission is licensed under GPL-2.0-or-later. Its corresponding source
release archive is included beside the runtime at
`assets/transmission/source/transmission-4.1.3.tar.xz`.

The bundled files are taken from the official upstream Windows x64 release:

- Release: <https://github.com/transmission/transmission/releases/tag/4.1.3>
- Windows x64 MSI SHA-256:
  `c8ea492d8f46fadac26e0c05b244cabba556201d5fe348dfcf1cf036621741f8`
- Corresponding source archive SHA-256:
  `ce7d2d8b101f7eb54bc3cf0bc55f52f7ebd4a25fa48e00bdca9a7e0fc02617da`

The daemon's dynamically linked dependencies are bundled from that same
upstream Windows distribution: OpenSSL (Apache-2.0), libcurl (curl license),
zlib (zlib license), and D-Bus (AFL-2.1/GPL-2.0-or-later). Their license texts
and source links are provided by their upstream projects:

- <https://www.openssl.org/source/license.html>
- <https://curl.se/docs/copyright.html>
- <https://zlib.net/zlib_license.html>
- <https://gitlab.freedesktop.org/dbus/dbus/-/blob/main/COPYING>

Moth launches Transmission as a distinct local process and communicates with
its loopback-only authenticated RPC endpoint. Moth's own source remains under
its existing license; this notice does not change the terms of either project.
