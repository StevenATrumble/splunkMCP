# Analysis: Reuse an existing browser instance instead of failing on a locked profile

## Problem statement

The server refuses to start whenever the Chromium profile (`user-data-dir`) is
already in use by another process. Observed failure:

```
Failed to launch the browser session; refusing to start.
browserType.launchPersistentContext: Opening in existing browser session.
This usually means that the profile is already in use by another instance of Chromium.
--user-data-dir=...\AppData\Local\splunk-mcp-server\user-data
```

This happens because the MCP client (Kiro) can spawn a fresh `node dist/server.js`
while a previous server instance — or a manually opened Chromium on the same
profile — still holds the profile lock. Only one process can own a persistent
context's `user-data-dir` at a time. The goal: if a usable browser is already
running on that profile, attach to it instead of trying to launch a second
owner and dying.

## Root cause (grounded in the code)

The launch happens in `src/session-manager.ts` → `SessionManager.launch()`:

```ts
const context = await this.launchPersistentContext(
  this.config.userDataDir,
  { headless: !this.config.headful },
);
```

`chromium.launchPersistentContext(userDataDir, ...)` demands exclusive access
to `userDataDir`. Playwright/Chromium enforces this with a `SingletonLock` in
that directory. A second launch against the same directory throws the "Opening
in existing browser session" error seen above.

Startup ordering that turns this into a hard failure (`src/server.ts` → `main()`):

1. `loadConfig()`
2. `ensureChromiumInstalled()`
3. construct `SessionManager` + `SplunkClient` + tool router
4. `session.launch()` — **eager**, at startup (documented "Launch-timing
   decision"). This is the line that throws when the profile is locked.
5. connect stdio transport and serve.

Because `launch()` is eager and there is no fallback, step 4 aborts the whole
process (`process.exitCode = 1; return;`). The MCP tools never register, so the
client cannot connect — exactly the symptom.

Relevant design constraints to preserve:

- **Persistent profile is intentional** (Req 9.1 / 16.1): the SSO session must
  survive restarts, so re-auth is usually silent. Any fix must keep using the
  same profile/session, not spin up a throwaway one.
- **A live primary page is required** (see `server.ts` launch-timing note and
  `fetchJson`): REST calls run as same-origin in-page `fetch` on the Splunk
  origin. Whatever we attach to must give us a usable page on `config.baseUrl`.
- **stdout is reserved for the MCP transport**; all diagnostics go to stderr via
  `logger`. A reuse path must not print to stdout.
- **Owner-only dir permissions** are applied in `prepareUserDataDir` (Req
  16.2–16.4). Reuse must not weaken that.

## Why "just detect and reuse" is not one-line

`launchPersistentContext` does not have a "attach if already running" mode. To
connect to an already-running browser you need Playwright's CDP attach
(`chromium.connectOverCDP(endpoint)`), which requires the *existing* browser to
be listening on a known remote-debugging endpoint. Today the server launches
with `--remote-debugging-pipe` (a pipe, not a TCP port), so a second process has
no endpoint to attach to. So the fix has two halves:

1. Make the owned instance *attachable* (expose a stable CDP endpoint).
2. On launch, *try to attach first*; only launch a new persistent context if no
   reusable instance is present.

## Recommended approach

### Option A (recommended): CDP endpoint + attach-first, launch-on-miss

Turn the persistent context into a discoverable, reusable singleton:

1. **Expose a fixed CDP endpoint when launching.**
   Pass a fixed debugging port to `launchPersistentContext` via `args`, e.g.
   `--remote-debugging-port=<port>` (new config `SPLUNK_CDP_PORT`, default e.g.
   `9223`). Bind to loopback only. This makes the owned browser attachable by
   later processes.

2. **Write an endpoint/lock handshake file in the profile dir.**
   After a successful launch, write `cdp-endpoint.json` into `userDataDir`
   containing `{ wsEndpoint, port, pid, startedAt }`. This is the discovery
   mechanism for later processes (the browser's own `SingletonLock` guards the
   profile, but does not tell a new process *where* to attach).

3. **Attach-first launch sequence.** Rework `SessionManager.launch()` to:
   - Read `cdp-endpoint.json` if present.
   - If present, try `chromium.connectOverCDP(endpoint)` (bounded by a short
     timeout). On success: adopt the existing context, find/reuse a page on the
     Splunk origin (or open one), set `this.context` / `this.primaryPage`, and
     mark this instance as an **attached** (non-owning) session. Return.
   - If the endpoint file is missing/stale or the connect fails/times out, fall
     through to the current `launchPersistentContext` path (the **owner**
     path), then write a fresh `cdp-endpoint.json`.

4. **Ownership-aware `close()`.** Track whether this instance *owns* the browser
   (launched it) or is *attached* to someone else's:
   - Owner: on shutdown, close the context (current behavior) and delete
     `cdp-endpoint.json`.
   - Attached: on shutdown, **disconnect** the CDP connection but do **not**
     close the browser — it belongs to another live server. Closing it would
     kill the profile out from under the owner.
   This prevents a secondary Kiro session from tearing down the primary's
   browser.

5. **Stale-endpoint handling.** If `cdp-endpoint.json` exists but `connectOverCDP`
   fails (browser died without cleanup), treat it as stale: delete the file and
   proceed to launch a fresh owner. Guard against races (see concurrency note).

Pros: true reuse — one visible window shared across N server instances; SSO
stays warm; matches the "persistent session" design intent. Cons: more moving
parts (endpoint discovery, ownership tracking, stale cleanup).

### Option B (simpler, weaker): detect-and-degrade

If attaching is deemed too much, at minimum stop failing hard:

1. Detect the "profile already in use" launch error specifically (match on the
   message / Playwright error).
2. Instead of `process.exitCode = 1`, log a clear, actionable stderr message
   ("another Splunk MCP instance already owns the browser profile; only one can
   run at a time — reconnect to the existing instance or stop it") and either:
   - exit cleanly so the client shows a single clear reason, or
   - keep serving with tools that return a typed, retryable
     `TransportError` explaining the single-instance constraint.

Pros: tiny change, removes the confusing crash. Cons: does not actually enable
concurrent use — it just fails gracefully. Does not satisfy the user's goal of
"use the already-open instance".

## Concrete change list (Option A)

- **`src/config.ts`**
  - Add `cdpPort: number` (env `SPLUNK_CDP_PORT`, default e.g. `9223`,
    validated via `readPositiveInt`).
  - Consider `SPLUNK_CDP_HOST` (default `127.0.0.1`) if you ever want non-local
    attach; default loopback-only for safety.

- **`src/session-manager.ts`**
  - Extend the launch args to include `--remote-debugging-port=${cdpPort}`
    (loopback). Note: `launchPersistentContext` accepts `args`; thread these
    through the `LaunchPersistentContext` seam so tests can assert them.
  - Add an `attach()` helper using `chromium.connectOverCDP()` with a bounded
    timeout, reusing the existing origin page or opening one on
    `${baseUrl}/en-US/app/${app}/search`.
  - Rework `launch()` into: `tryAttach()` → on miss `launchOwned()`.
  - Track `private owning: boolean`. Update `close()` to disconnect (attached)
    vs close (owner) accordingly, and to remove the endpoint file only when
    owning.
  - Read/write the `cdp-endpoint.json` handshake file inside `userDataDir`
    (owner-only perms already enforced on the dir).

- **`src/server.ts`**
  - No structural change needed if `launch()` internally does attach-first.
    Keep the eager `session.launch()` call; it now attaches when possible.
  - Optionally soften the launch `catch` so a "profile busy but not attachable"
    condition yields a clear message (fallback to Option B behavior).

- **`src/startup-guard.ts`** — unchanged.

- **Tests** (`vitest`): the existing `SessionManagerDeps` seams
  (`launchPersistentContext` injectable) make this testable. Add:
  - attach-first success (fake `connectOverCDP` returns a context) → does not
    call `launchPersistentContext`.
  - attach miss (no endpoint file) → calls `launchPersistentContext`, writes
    endpoint file.
  - stale endpoint (connect throws) → deletes file, launches owner.
  - `close()` when attached → disconnects, does NOT close the browser, leaves
    endpoint file intact.
  - `close()` when owner → closes context, removes endpoint file.
  - Add a `connectOverCDP` seam to `SessionManagerDeps` mirroring the existing
    `launchPersistentContext` seam so no real browser is needed.

## Concurrency / race notes

- **Launch race:** two servers starting simultaneously can both miss the
  endpoint file and both try to launch. Chromium's `SingletonLock` still makes
  the *second* `launchPersistentContext` fail — so keep the loser's fallback:
  on that specific launch error, re-read the endpoint file (the winner should
  have written it) and attach instead. This closes the startup race without a
  separate lock.
- **Endpoint file staleness:** always treat `connectOverCDP` failure as "stale,
  relaunch". Include `pid` in the file and optionally verify the process is
  alive before trusting it, to avoid attaching to a dead endpoint.
- **Port already bound:** if `SPLUNK_CDP_PORT` is taken by an unrelated process,
  launch will fail; surface a clear config error suggesting a different port.

## Security considerations

- Bind the CDP endpoint to **loopback only** (`127.0.0.1`). A CDP endpoint is
  effectively full control of the browser (and thus the authenticated Splunk
  session); it must never listen on a routable interface.
- Keep the `user-data-dir` owner-only (unchanged). The `cdp-endpoint.json`
  inherits the dir's restricted perms; still write it with restrictive mode.
- Do not log the `wsEndpoint` at info level (it grants browser control). Log at
  debug, or log only the port.

## Recommendation summary

Go with **Option A**: add a fixed loopback CDP port, write a small
`cdp-endpoint.json` handshake in the profile dir, and make `launch()`
attach-first / launch-on-miss with ownership-aware `close()`. This directly
delivers "if an instance is already open, use that one" while preserving the
persistent-SSO design, the single-visible-window UX, and the stdout/transport
and permission guarantees. Keep Option B's graceful-failure message as the
fallback branch for the un-attachable/port-conflict edge cases.
