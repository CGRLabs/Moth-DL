# Contributing

## Who decides

I maintain this project. I review and merge pull requests, and I make the calls
on scope and direction.

That does **not** mean I hold the repo hostage. Forks are genuinely welcome, and
for a change large enough that a patch would be awkward, a fork is often the
better route — the architecture is deliberately layered so a fork can diverge in
one area without rewriting the rest (see the table below). If you fork, tell me
what you are building so I can point at anything that would save you a week.

There is no CLA. Sign-off on commits is optional.

## Getting set up

```bash
npm install
npm run dev
```

Node 22.5+ is required (24+ recommended). There is no native build step — if
`npm install` completes, the toolchain is fine.

Before opening a pull request:

```bash
npm run verify      # typecheck + unit/integration/extension tests + smoke and ingest checks
```

Layered by runner, so run the narrow one while iterating:

```bash
npm test               # main-process suite (Vitest)
npm run test:extension # browser extension suite (node --test, no bundler)
```

## Project conventions

**TypeScript is strict, and stays strict.** `strict`, `noUncheckedIndexedAccess`,
`noUnusedLocals` and `noUnusedParameters` are all on. Do not widen them to make
an error go away; fix the error. `noUncheckedIndexedAccess` in particular means
array access returns `T | undefined` — that is deliberate, not friction.

**No `any`, no `@ts-ignore`.** Narrow properly. If a type is genuinely wrong, fix
the type.

**No new runtime dependencies without discussion.** The desktop app keeps its
runtime dependency set deliberately small and uses no native addons; the
standalone `cli/` download core has no runtime dependencies. A native addon or
a large framework needs a strong argument.

**Comments explain *why*, not *what*.** The code says what it does. A comment is
worth writing when the reason is not visible from the statement — a constraint, a
tradeoff, a bug being avoided, a protocol requirement. `// increment i` is noise.

**Durability-sensitive code needs a comment explaining the ordering.** Anything
touched by the fsync-before-commit contract in `core/task.ts` and `core/recovery.ts`
must say why the order is what it is.

## Where things go

| Change | Location |
|---|---|
| Domain vocabulary, IPC contract, validation | `src/shared/` |
| Transfer logic, recovery, scheduling | `src/main/core/` |
| Tag read/write, artwork | `src/main/media/` |
| Loopback endpoint, folder watcher | `src/main/ingest/` |
| SQL | `src/main/db/repositories.ts` and `mediaRepository.ts` only |
| HTTP behaviour | `src/main/net/httpClient.ts` |
| Torrent engine | `src/main/torrent/` |
| UI | `src/renderer/src/` |
| Browser extension | `browser-extension/` (plain JS, no bundler) |
| Anything crossing the trust boundary | validate in `src/shared/schemas.ts` |

Never add SQL to a file outside `repositories.ts`, and never let the renderer
reach Node. The renderer has no filesystem access; if a UI feature seems to need
one, it needs an IPC channel with a zod-validated schema.

## Licensing

The app is MIT (see `LICENSE`). Two things matter if you redistribute a build:

**Transmission is GPL.** The Windows package bundles the Transmission daemon as a
separate process, and ships the corresponding source archive alongside it. Any
build you distribute that includes the bundled runtime must keep both the source
archive and `resources/transmission/NOTICE.md` intact. See that notice for the
pinned version, hashes, and license terms. The source archive is downloaded and
hash-verified by `npm run prepare:transmission`, which runs automatically as part
of `npm run package` and `npm run dist`.

**Keep the MIT notice.** Redistributing under any licence of your own is allowed —
MIT does not require you to open-source your changes — but copies must retain the
copyright and permission notice from `LICENSE`.

## Testing

Everything gets a test. The bar differs by layer:

- **Pure functions** — cover the edge cases: empty input, zero, negative,
  boundary sizes, and every rejection path.
- **Anything touching the network, disk or database** — use the real thing. The
  helpers in `test/helpers/` exist for this: a real local HTTP server and a real
  temp-directory database. Do not mock `node:sqlite` or `fetch`; the bugs worth
  catching live precisely in the seams those mocks hide.
- **Anything that could break crash recovery** — needs a test that kills the
  state partway and asserts the resumed result is byte-identical. See
  `test/integration/recovery.test.ts`; treat it as the reference.

When you fix a bug, add the test first and watch it fail. A test that has never
failed has not been shown to test anything.

`browser-extension/` has no bundler on purpose, so its logic stays in pure
functions Node can import directly and runs under `node --test`
(`npm run test:extension`). Keep it that way — a bundler there would put a
second toolchain between a contributor and a failing test.

### Agent testing

Drive the running app over its loopback ingest endpoint with
`scripts/moth.mjs`. Every command prints JSON to stdout; failures go to
stderr with a non-zero exit.

```bash
node scripts/moth.mjs status                           # app and ingest health
node scripts/moth.mjs add <url> --format video         # queue a URL
node scripts/moth.mjs list                             # all downloads
node scripts/moth.mjs get <id>                         # one download
node scripts/moth.mjs wait <id> --timeout 120000       # block until terminal
node scripts/moth.mjs boot                             # scratch-profile app, prints { pid, port, token, profile }
node scripts/moth.mjs kill --pid <n>                   # stop a booted app
node scripts/moth.mjs run <url> --expect-sha256 <hex>  # boot + add + wait + verify + teardown in one call
```

`boot` always uses a scratch profile — never the real one — so test
downloads stay out of your library. `run` is the single-command path for
sandboxed shells that reap stray processes between commands.

The CLI reads the app profile from `%APPDATA%/moth-dlm` by default. If you are
testing a packaged build, point it at that profile instead:

```bash
node scripts/moth.mjs "--profile=%APPDATA%/Moth Download Manager" status
```

## Migrations

Forward-only, append-only. Add a new entry to `MIGRATIONS` in
`src/main/db/schema.ts` with the next version number. **Never edit a migration
that has shipped** — users already have it applied, and SQLite will not re-run it.

## Code review

What a reviewer will look for:

- **Correctness under interruption.** Does this survive a kill at an arbitrary
  moment? Does the ordering of fsync and commit hold?
- **Unbounded growth.** Loops that scale with file size, maps that are never
  pruned, retained sockets. A 40 GB file must not create 640 000 DOM nodes or
  640 000 live timers.
- **The untrusted-input path.** Is new input validated? Does it reach a
  filesystem path without `resolveWithin`?
- **Failure handling.** Is the catch specific, and does it leave the system in a
  consistent state? A bare `catch {}` in the engine is a bug.
- **Tests that would catch a regression**, not tests that would catch the change.

## Commit messages

Short imperative subject, body explaining *why* when it is not obvious.

```
Rate-limit partial chunk retries instead of the whole download

A single flaky chunk was failing the entire transfer and discarding
sibling progress. Retrying at chunk granularity keeps completed
ranges and cuts wasted bandwidth on flaky connections.
```

## Security

Report vulnerabilities privately rather than in an issue — see
[SECURITY.md](SECURITY.md).

## Release checklist

Maintainer-facing, for reference if you fork and cut your own builds:

1. `npm run verify` — all green
2. Bump the version in `package.json`
3. `npm run dist` — produces installers in `release/`
4. Verify the installer launches and a download completes
5. Tag the release