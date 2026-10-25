# resources/ — Moth brand assets
newmothicon.png: canonical source art for every Moth icon.
icon.png (256): app/window icon, resampled from the source.
trayIcon.png (32), trayIcon@2x.png (64): tray icons, resampled from the source.
moth.ico (16–256): Windows shortcut/installer container, from the source.
Regenerate everything (never hand-edit outputs): npm run icons
Pipeline: scripts/pngDecoder.mjs decodes, scripts/iconEncoder.mjs rescales.
Box-filter downscale only; encoder writes RGBA8 PNG plus the ICO.
Tests: test/unit/icons.test.ts (round-trip, dimensions, non-empty tray).
