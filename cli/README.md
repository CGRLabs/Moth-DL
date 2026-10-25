# Moth Download CLI (first slice)

This small, dependency-free Node.js CLI is the first step toward a simpler
download core. It is intentionally separate from the Electron app and does not
read or write Moth's application database.

Requires Node.js 22.5 or newer.

```powershell
node cli\src\cli.mjs download https://example.com/large-file.zip --output .\large-file.zip
node cli\src\cli.mjs resume .\large-file.zip
node cli\src\cli.mjs status .\large-file.zip --json
node cli\src\cli.mjs refresh .\large-file.zip https://example.com/new-signed-link --json
```

## Local fault-injection lab

The lab makes a deterministic binary payload in a temporary directory and
serves it only on `127.0.0.1`; it does not contact outside servers. Start it
from the repository root:

```powershell
npm --prefix cli run fault-lab -- --size-mib 128
```

Keep that terminal open and copy the SHA-256 and local URLs it prints into a
second terminal. The payload is removed when you stop the lab with Ctrl+C.
Try these cases (replace `<url>` and `<sha256>` with the printed values):

```powershell
node cli\src\cli.mjs download <url>/ok --output .\lab-ok.bin --sha256 <sha256> --debug --json
node cli\src\cli.mjs download <url>/drop-once --output .\lab-drop.bin --sha256 <sha256> --debug --json
node cli\src\cli.mjs download <url>/no-range --output .\lab-no-range.bin --sha256 <sha256> --debug --json
node cli\src\cli.mjs download <url>/flaky --output .\lab-flaky.bin --sha256 <sha256> --debug --json
node cli\src\cli.mjs download <url>/expired --output .\lab-expired.bin --debug --json
node cli\src\cli.mjs download <url>/bad-range --output .\lab-bad-range.bin --debug --json
node cli\src\cli.mjs download <url>/changed-etag --output .\lab-etag.bin --debug --json
node cli\src\cli.mjs download <url>/stall --output .\lab-stall.bin --timeout-ms 1000 --retries 0 --debug --json
node cli\src\cli.mjs download <url>/redirect --output .\lab-redirect.bin --sha256 <sha256> --debug --json
```

`ok`, `drop-once`, `no-range`, `flaky`, and `redirect` should complete and
match the printed checksum. `expired` (403) and `bad-range` / `changed-etag`
should fail safely rather than accept unverified bytes. `stall` should time out.
Use a new output filename for each run because completed outputs are never
overwritten. The drop is injected only once per lab process, so its retry can
continue using the strong ETag; start a fresh lab process to repeat that fault.

The lab is for hands-on demonstrations. The automated suite remains the
repeatable regression check and also covers interrupted transfers, checksum
verification, locking, retry behavior, redirect-secret redaction, and output
preservation:

```powershell
npm --prefix cli test
```

Use `--sha256 <64-hex-digits>` to verify against a trusted SHA-256 checksum,
`--retries <0-20>` to set the bounded retry count, and `--timeout-ms <100-600000>`
to change the request timeout. `--json` writes newline-delimited progress,
retry, completion, and error events to stdout; errors use stderr and a nonzero
exit code. Add `--debug` for detailed request, redirect, probe, retry, resume,
checkpoint, checksum, and promotion records on stderr. With both `--json` and
`--debug`, both streams contain newline-delimited JSON but remain separate:
application events stay on stdout and diagnostics stay on stderr. Debug output
never includes query strings or secret header values.

Downloads are written to `<output>.part` with sidecar state at
`<output>.part.json`. A lock file prevents two CLI processes writing the same
partial at once. Ranged downloads resume only with a strong ETag and matching
file size; other downloads restart at byte zero after interruption. A refreshed
URL keeps progress only when the new server reports the same size and strong
ETag and supports ranges. ETags are server validators, not cryptographic proof.
The final output is never overwritten; it is created by a same-volume hard link
after the partial has completed and passed any requested checksum check.

This is an early, deliberately narrow implementation—not yet a guarantee that
every host or URL can be downloaded. Some sites require browser authentication,
expire links, block command-line clients, or do not support resumable transfers.
The CLI does not scrape browser sessions or bypass access controls.
