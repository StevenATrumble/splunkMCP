# Splunk MCP Server — Analysis & Discovery

**Status:** Pre-spec analysis. Findings below were validated live against
`https://hoopp.splunkcloud.com` (Splunk Cloud `10.5.2605.6`) on 2026-09-10 using
Playwright driving an authenticated browser session.

---

## 1. Problem statement

We want an MCP server that lets an agent run Splunk searches and read results.
Splunk's public REST API is unavailable to us because **API tokens are disabled
for the org**. However, an interactive user can log into Splunk Web via browser
(SSO + MFA) and the web UI itself talks to the Splunk REST layer through an
internal proxy. The goal is to drive that same backend programmatically, reusing
the user's authenticated browser session instead of an API token.

## 2. Key constraint: auth is an interactive browser session

- Login is Microsoft Entra (Azure AD) SSO + MFA. There is no unattended/
  service-account path available.
- Therefore the design treats **the authenticated browser session as the source
  of auth**. A human logs in once; the server reuses that session.
- Sessions expire (~1 hour, per `splunkd_8443` cookie `Max-Age=3600`). The design
  must detect expiry and prompt for re-login rather than fail opaquely.
- This is an internal-tooling workaround for the user's own account and data. It
  is **not** suitable for headless/unattended operation. If unattended access is
  ever needed, that requires getting token access from whoever controls the org.

### Verified SSO login flow (2026-09-10)
The reliable login entry point is the Microsoft MyApps portal, not the Splunk
login page directly:
1. Navigate to `https://myapps.microsoft.com/` (Microsoft Entra ID).
2. If not already signed in, the user completes Microsoft SSO + MFA here.
3. Click the **Splunk** app tile. This opens a new tab and performs the SAML/SSO
   redirect, landing directly on
   `https://hoopp.splunkcloud.com/en-US/app/search/search` — fully authenticated.

Key finding: when the **Microsoft identity session is already alive** in the
browser profile, launching Splunk is a **silent redirect with no MFA prompt**.
MFA is only required when the Microsoft session itself has expired. This is the
core reason to use a **persistent Playwright user-data-dir**: it keeps the
Microsoft SSO session alive across restarts so Splunk re-auth is usually silent.

Implication for the MCP server: the "login" bootstrap should drive the MyApps
flow (or at least be able to fall back to it), because hitting Splunk directly may
also work via the same SSO but MyApps is the confirmed-good path. The re-auth
prompt to the human should point them at MyApps if MFA is needed.

## 3. How Splunk Web reaches the backend

Splunk Web proxies REST calls through an internal path:

```
https://hoopp.splunkcloud.com/en-US/splunkd/__raw/<rest-path>
```

- `<rest-path>` is the normal splunkd management REST API (conceptually port 8089),
  tunneled through the web tier.
- User-namespaced endpoints use `servicesNS/<user>/<app>/...`
  (e.g. `servicesNS/strumble/search/...`). Global endpoints use `services/...`.

### Auth artifacts observed in browser requests
- `Cookie: splunkd_8443=...` — the authenticated session cookie. **`HttpOnly`**, so
  JavaScript cannot read it, but the browser sends it automatically on same-origin
  fetch. This is the real credential.
- `splunkweb_csrf_token_8443=...` cookie — CSRF token, readable from JS.
- `X-Splunk-Form-Key: <csrf>` header — CSRF token echoed on state-changing POSTs.
- `X-Requested-With: XMLHttpRequest` header.

## 4. Validated architecture: in-page fetch (browser session = auth)

> **Note on tooling vs. product:** All discovery above was done using a *Playwright
> MCP server* purely as a prototyping harness. **The deliverable does NOT depend on
> any external MCP server.** The Splunk MCP server is self-contained: it declares
> `playwright` as its own npm dependency and drives the browser itself (see §8.1).
> The Playwright MCP server can be removed from the Kiro config once we start
> building.

The cleanest model, confirmed working: **execute REST calls from inside the
authenticated Splunk Web page context** (Playwright `page.evaluate` running
`fetch`). Because the calls are same-origin:

- The `HttpOnly` `splunkd_8443` session cookie rides along automatically. We never
  extract or handle it.
- The CSRF token can be read dynamically at call time from the readable cookie
  (`splunkweb_csrf_token_8443`) — no manual/hardcoded token management.

### CSRF finding (important)
Testing showed that **POST requests from the same-origin page context succeed even
without the `X-Splunk-Form-Key` header** (create-job returned `201`). The session
cookie alone was accepted. Recommendation: still send the token (read dynamically
from the cookie) as a low-cost safeguard, since CSRF enforcement can vary by Splunk
version/config — but the architecture does not depend on manually managing it.

This directly addresses the concern that "passing the CSRF isn't ideal": we read
it dynamically (or omit it), and never hand-copy it.

## 5. Validated search lifecycle

All endpoints below were called live and returned the documented results.

> **Path note:** These were first discovered via the UI's namespaced form
> `servicesNS/<user>/search/search/...`, but the simpler **non-namespaced**
> `services/search/...` form is verified to work identically with no username
> (see §8.3). Prefer the non-namespaced form. Both forms are shown as
> `.../search/...` below — read the leading segment as `services/search`.

### Option A — async job (for longer / larger searches)
1. **Create job**
   ```
   POST /en-US/splunkd/__raw/services/search/v2/jobs
   Content-Type: application/x-www-form-urlencoded
   body: search=<SPL>&output_mode=json&exec_mode=normal
   → 201 Created, body: {"sid":"<SID>"}
   ```
   (Response also carries `Location:` and a `link: <SID>; rel=info` header.)
2. **Poll status**
   ```
   GET /en-US/splunkd/__raw/services/search/v2/jobs/<SID>?output_mode=json
   → entry[0].content.dispatchState  ("QUEUED"→"PARSING"→"RUNNING"→"DONE")
   → entry[0].content.isDone (bool), .doneProgress (0..1)
   ```
   Poll until `isDone === true`.
3. **Fetch results**
   ```
   GET /en-US/splunkd/__raw/services/search/v2/jobs/<SID>/results?output_mode=json&count=<N>&offset=<M>
   → { fields: [...], results: [ {..row..}, ... ], preview, init_offset, messages }
   ```

### Option B — oneshot (for short / interactive searches)
```
POST /en-US/splunkd/__raw/services/search/jobs
body: search=<SPL>&output_mode=json&exec_mode=oneshot
→ 200 OK, results returned inline: { fields, results, ... }  (no polling)
```
Blocking; best for quick lookups. Long/expensive searches should use Option A so we
can stream progress and avoid request timeouts.

### GET behavior
GET endpoints work with just the session cookie (no CSRF, and even without
`X-Requested-With`). Keeping `X-Requested-With: XMLHttpRequest` is harmless and
matches the UI.

## 6. Auth / session probe

Use a lightweight, read-only endpoint to check session health before running work:
```
GET /en-US/splunkd/__raw/services/authentication/current-context?output_mode=json
→ entry[0].content.username, .roles
```
Validated: returned `username: strumble`, `roles: [isg-basic-users]`.
- A live session returns `200` + JSON.
- A dead session is expected to return `401` or an HTML login/SSO redirect —
  the server should detect non-JSON / redirect / 401 and surface a clear
  "session expired, please log in again in the browser" message.

`GET /services/server/info?output_mode=json` is useful for version detection
(returned build `10.5.2605.6`).

## 7. Endpoints that are UI noise (ignore)
Observed in captures but NOT needed by the MCP server:
- `services/messages` (UI banner messages)
- `services/orchestrator/v1/spl2/enabled` (UI feature flag)
- `servicesNS/<user>/search/search/ast` (query-syntax parsing for the editor)
- `saved/searches/_new` (UI form defaults)
- `proxy-esp.experienceservices.splunkdev.net/...` (frontend telemetry, cross-site)

## 8. Proposed MCP server shape (for the spec to refine)

### 8.1 Hard requirement: fully self-contained
- **No dependency on any external MCP server** (including the Playwright MCP
  server used for discovery). This server bundles browser automation itself.
- **Playwright is a normal npm dependency** of this project. Browser binaries are
  installed as part of setup — either via a `postinstall` script running
  `playwright install chromium`, or documented as a one-line `npx playwright
  install chromium` step. The spec should decide which (postinstall is more
  "just works"; explicit step is more predictable in locked-down environments).
- Startup path: `npm install` → (browser download) → run the server. Nothing else
  should be required beyond editing config (see §8.3).
- Package it as a standard Node MCP server invoked from Kiro's `mcp.json` via
  `node <path>/server.js` (or `npx` if published). No global installs assumed.

### 8.2 Runtime & auth/session management
**Runtime:** Node.js MCP server (per user's preference for a simple Node impl),
using the official MCP SDK + Playwright (bundled Chromium).

**Auth/session management:** The server owns a Playwright browser launched with a
**persistent user-data-dir** so the Microsoft SSO session (and thus Splunk
session) survives across restarts.
- On first use (or when the session probe fails), it opens a **visible** browser
  window pointed at the MyApps flow and asks the human to complete SSO+MFA, then
  continues once the Splunk session is live.
- All REST calls run via `page.evaluate` / `page.request` in the authenticated
  context so cookies apply automatically (the validated in-page-fetch model).

### 8.3 Hard requirement: per-user, config-only setup
Any user in the org must be able to use this by editing config only — **no code
changes, nothing hardcoded to a specific person or stack.**

Config fields (names to be finalized in spec), ideally via env vars in `mcp.json`:
- `SPLUNK_BASE_URL` — e.g. `https://hoopp.splunkcloud.com` (default provided).
- `SPLUNK_USERNAME` — used only if we can't auto-discover the namespace; see below.
- `SPLUNK_APP` — namespace app, default `search`.
- Optional: default `earliest`/`latest`, default result `count`, poll interval,
  max wait, user-data-dir location, headful/headless toggle for login.

**Namespace: NO username needed (VERIFIED).** Testing confirmed the
**non-namespaced** path `services/search/...` works for the full search lifecycle
without any `servicesNS/<user>` segment — Splunk defaults the namespace to the
authenticated user. This eliminates the username from required config entirely.
- Verified non-namespaced (all `200`/`201`):
  - oneshot: `POST /en-US/splunkd/__raw/services/search/jobs` (exec_mode=oneshot)
  - async create: `POST /en-US/splunkd/__raw/services/search/v2/jobs` → SID
  - poll: `GET /en-US/splunkd/__raw/services/search/v2/jobs/<SID>`
  - results: `GET /en-US/splunkd/__raw/services/search/v2/jobs/<SID>/results`
- `SPLUNK_USERNAME` becomes fully optional. If ever needed for app-scoped saved
  searches, it can still be auto-discovered via `authentication/current-context`.
- **Net result: for most users the only required config is nothing** — base URL is
  defaulted; they just complete the browser login on first run.

**Candidate tools:**
- `splunk_search` — run SPL; args: `query`, `earliest`, `latest`, `max_results`,
  `mode` (auto|oneshot|async). Auto picks oneshot for quick queries, async
  otherwise. Returns normalized rows (fields + results).
- `splunk_search_status` — check a running job's `dispatchState` / progress by SID.
- `splunk_results` — page results for a SID (`count`, `offset`).
- `splunk_cancel_job` — cancel/delete a running job (`DELETE .../jobs/<SID>`,
  to be validated).
- `splunk_whoami` — current-context probe (username, roles) + session health.
- `splunk_server_info` — version/build.
- (later) `splunk_list_saved_searches`, `splunk_indexes`.

**Cross-cutting requirements:**
- SPL time range passed as `earliest_time` / `latest_time` job args.
- Detect and clearly report: session-expired, search errors (`messages` array in
  results), permission errors, and empty results.
- Never log/persist cookie values or the session token.
- Respect result-size limits; support paging for large result sets.
- Sensible poll backoff + overall timeout for async jobs.

## 9. Open questions for the spec session
1. **Session bootstrap UX:** headful login window on demand vs. a dedicated
   "login" tool the user runs first. How to signal "please re-auth" back through
   MCP. Login should drive the MyApps → Splunk tile flow (confirmed path); decide
   whether to also try hitting Splunk directly first and fall back to MyApps.
2. **Persistence location** for the Playwright user-data-dir (and its security —
   it contains the live session).
3. ~~**Namespace/user**~~ — RESOLVED: use non-namespaced `services/search/...`,
   no username required (verified §8.3). `SPLUNK_USERNAME` is optional override.
4. **oneshot vs async threshold:** how to decide, and default time range.
5. **Result normalization:** raw Splunk JSON passthrough vs. flattened rows vs.
   both. Field ordering from `fields[]`.
6. **Concurrency:** one shared browser page vs. multiple; job cleanup policy.
7. **`DELETE` job / cancel** semantics — validate the endpoint.
8. **Error taxonomy** the tools return to the agent (expired, syntax error,
   no data, throttled, permission denied).

## 10. Confidence / what was actually verified
Verified live (real requests, real responses):
- SSO login via `myapps.microsoft.com` → Splunk tile → silent redirect to an
  authenticated Splunk session (no MFA prompt when MS session already alive). ✅
- Authenticated session reachable; `username=strumble`.
- CSRF token readable from cookie; changes per session (must be dynamic).
- Create async job → `201 {sid}`; poll → `DONE`; results → `200` JSON. ✅
- oneshot → `200` inline results. ✅
- GET works without CSRF and without `X-Requested-With`. ✅
- POST create-job works WITHOUT the CSRF form key from in-page context. ✅
- **Non-namespaced `services/search/...` works for the full lifecycle (oneshot,
  async create/poll/results) with NO username in the path.** ✅
- `current-context` and `server/info` probes. ✅

Not yet verified (defer to spec/impl):
- Behavior of an actually-expired session (exact status/redirect shape).
- `DELETE`/cancel job endpoint.
- Large-result paging and very long-running search behavior.
- Persistent-context login survival across full restarts.
