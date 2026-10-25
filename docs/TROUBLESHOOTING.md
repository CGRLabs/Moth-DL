# Troubleshooting

## Downloads

**"not an http(s) URL"** — only `http` and `https` are accepted; `file:` and
`javascript:` are rejected by design.

**A download shows `no resume`** — the server did not advertise
`Accept-Ranges: bytes`. It will still download, but an interruption restarts it.

**A download shows `CHECKSUM_MISMATCH`** — the bytes received did not match the
expected digest. Moth discards the bad data rather than keeping a file it cannot
vouch for. Re-download, or verify the checksum you entered.

**A download is stuck on `Verifying`** — recovery and final verification
re-digest chunks, which is disk-bound. On a large library this is expected on
startup; see the cap note under [Limitations](../README.md#limitations).

## Application

**Downloads stopped after closing the window** — check *Keep running in the
system tray* in Settings. If the tray icon is unavailable (no icon bundled, or
an unsupported Linux desktop), closing the window quits the app.

**Startup is slow with a large library** — recovery re-digests completed chunks.
Lower the cap by calling `runRecovery` with a smaller `maxVerifyBytes`, or use
the *Rescan disk* button for a one-off check instead.

## Logs

Logs stay local; native crash minidumps are not collected. Open the log folder
from Settings or the status bar. The log is newline-delimited JSON, so
`Select-String`, `jq` and `grep` all work. Choose `debug` or `trace` in Settings
for more runtime detail.

```powershell
Get-Content "$env:APPDATA\moth-dlm\logs\moth.log" |
  ConvertFrom-Json |
  Where-Object { $_.level -eq 'error' } |
  Format-Table timestamp, scope, message
```

The log records main-process exceptions, renderer JavaScript errors and
unhandled rejections, renderer crashes/unresponsive periods, failed page loads,
and media-resolution failures. URL query values, URL credentials, and
cookie/authorization values are redacted before records reach disk.

A sudden OS-level termination can still happen before the latest queued log
record is flushed, so the very last moments of a hard crash may be missing.