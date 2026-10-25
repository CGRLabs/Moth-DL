# Future directions

These are ideas for possible future work, not promises or a committed release
plan. They build on Moth's current desktop app, download engines, browser
extension, local control CLI, and scheduling features.

## Run Moth as a self-hosted service

Let someone run Moth on a machine with persistent storage and control it from
another device or from software they operate, such as their own website. Moth
would still own the queue and route each job through its appropriate engine;
the remote client would submit and manage jobs rather than implement downloads
itself.

**Current state:** Moth is a desktop Electron app. Its token-protected control
and ingest endpoints bind to IPv4 loopback (`127.0.0.1`), and the CLI and
browser extension use those local endpoints. This is useful on the same
computer, but it is not a supported remote or headless service. The existing
pairing token is a secret, not a reason to expose the loopback API directly to
a network.

**What would need design and implementation:**

- A supported way to run without an interactive desktop session, including
  lifecycle management, configuration, logging, shutdown, and upgrades.
- A versioned API contract for submitting jobs and querying, pausing, resuming,
  retrying, and cancelling them, with stable status and error shapes.
- Remote authentication and authorization, secure transport, pairing and
  revocation, and controls for which clients can access which downloads.
- Limits and safeguards for destinations, concurrent jobs, resource use, and
  incoming URLs. The service would have access to its host's network and files;
  it must not become an unrestricted proxy or arbitrary URL-fetch service.
- Clear installation and backup guidance for the machine that owns the
  downloads and Moth's data.

An own website or another device could then act as a client of a privately
operated Moth instance. It should not receive a long-lived pairing secret in
browser-side code. This direction is larger than exposing the current local
endpoint and should be designed as a service boundary first.

## Make browser-to-Moth handoff even easier

Moth already has a browser extension that can send supported page URLs to a
Moth instance on the same computer, using the loopback endpoint and pairing
token. A possible follow-up is a quicker, more memorable handoff—such as a
browser action, keyboard shortcut, or URL-based shortcut that sends the
current page to the user's own Moth.

Changing a few characters in a provider URL cannot by itself reach an app
running only on the user's computer. A URL-shortcut experience would need a
real route from the browser to that local app, for example an extension, a
custom protocol handler, or a user-operated service. A hosted redirect would
introduce a third party and would not be equivalent to a private local handoff.

This should reuse the existing extension pairing flow, keep the pairing token
secret, clearly show what page is being submitted, and report when a source is
unsupported. It should submit the page to Moth's normal routing and validation
pipeline rather than promise that every site or link will work. Remote-device
handoff depends on the self-hosted service direction above.

## Expand download automation gradually

Moth already supports scheduled downloads and one-off queue plans. More
automation could make repeated use easier, but it does not need to begin as a
general-purpose rules engine.

Possible steps, from simpler to more involved:

1. Improve clarity and control for the existing scheduled downloads and
   one-off plans.
2. Consider recurring schedules for jobs the user has already configured,
   including a visible next-run time, missed-run behavior, and an easy way to
   disable them.
3. Only if there is a clear need, explore watching a feed or other user-chosen
   source for new items. This adds source-specific behavior, duplicate
   handling, retention choices, and more failure cases.

Automation should be explicit and inspectable: users should be able to see
what will run and when, pause or remove a rule, and understand failures. It
should not silently expand a submitted URL into an unbounded set of downloads
or imply that a scheduled job is guaranteed to finish by a deadline.
