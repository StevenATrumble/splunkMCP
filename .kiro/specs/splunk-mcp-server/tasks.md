# Implementation Plan: Splunk MCP Server

## Overview

This plan builds the Splunk MCP Server incrementally in **TypeScript** (Node.js LTS), matching the design's interfaces, data models, and testing strategy (`@modelcontextprotocol/sdk`, `playwright`, `fast-check`). Work proceeds bottom-up: scaffolding and shared types first, then the `Config` loader, then the `SessionManager` (browser + in-page fetch + auth + concurrency queue), then the `SplunkClient` (search lifecycle + normalization), then the MCP Tool Router and its six tools, then the error taxonomy wiring, and finally the security hardening and test suites. Each step builds on the previous ones and ends by wiring components together so no orphaned code remains.

Property-based tests validate the six correctness properties from the design (Auth Confidentiality, Session-Expiry Detection, Poll Termination, Result Bounds, Mode Fidelity, Config-Only Per-User) and are placed close to the code they exercise so failures surface early.

## Tasks

- [x] 1. Project scaffolding and shared types
  - [x] 1.1 Initialize the Node.js + TypeScript project and self-contained packaging
    - Create `package.json` declaring `@modelcontextprotocol/sdk` and `playwright` as normal (non-external) dependencies and `fast-check` + `typescript` + a test runner (e.g. `vitest`) as devDependencies
    - Add a `postinstall` script running `playwright install chromium`, and document the `npx playwright install chromium` fallback for restricted networks in `README.md`
    - Add `tsconfig.json`, source layout (`src/`), and build/test npm scripts (use `--run` / single-execution mode for tests, never watch mode)
    - Add a startup guard stub that checks for the Chromium binary and is wired in task 6.2
    - _Requirements: 17.1, 17.2, 17.3, 17.5_

  - [x] 1.2 Define shared domain types and error taxonomy classes
    - Create `src/types.ts` with `SearchArgs`, `SearchOutcome`, `ResultPage`, `JobStatus`, `CurrentContext`, `ServerInfo`, `SplunkMessage`, `RawRestRequest`, `RawRestResponse`, `SessionHealth`, `PageArgs`
    - Create `src/errors.ts` with typed error classes: `SessionExpiredError`, `SearchError`, `PermissionError`, `ThrottledError`, `TimeoutError`, `TransportError`, and a `NoDataResult` marker, each carrying retryability metadata
    - _Requirements: 14.1, 14.2, 14.4, 14.5, 14.6_

- [x] 2. Configuration loader
  - [x] 2.1 Implement the environment-only Config loader
    - Create `src/config.ts` exposing `loadConfig(): Config` reading only from `process.env` (never from files or other sources)
    - Apply documented defaults: `SPLUNK_BASE_URL=https://hoopp.splunkcloud.com`, `SPLUNK_APP=search`, `SPLUNK_DEFAULT_EARLIEST=-15m`, `SPLUNK_DEFAULT_LATEST=now`, `SPLUNK_DEFAULT_COUNT=100`, `SPLUNK_POLL_INTERVAL_MS=750`, `SPLUNK_MAX_WAIT_MS=120000`, `SPLUNK_AUTO_ASYNC_THRESHOLD_MS=3000`, OS-appropriate `SPLUNK_USER_DATA_DIR`, `SPLUNK_HEADFUL=true`
    - Treat `SPLUNK_USERNAME` as optional; never fall back to a hardcoded username
    - Validate the base URL (reject empty/invalid URL with an error and refuse to start); error on any required variable with no default that is missing
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.7, 13.8_

  - [ ]* 2.2 Write property test for Config-Only Per-User
    - **Property 6: Config-Only Per-User**
    - **Validates: Requirements 13.1, 13.6, 13.7, 13.8**
    - Assert loaded config derives username only from env (undefined when unset), that search-path construction uses non-namespaced `services/search/...` with no username segment, and that non-env sources are ignored

  - [ ]* 2.3 Write unit tests for Config loader defaults and validation
    - Table-driven cases for each default, empty/invalid base URL rejection, and missing-required-variable errors
    - _Requirements: 13.2, 13.3, 13.4, 13.5_

- [x] 3. Secret-safe logging and helpers
  - [x] 3.1 Implement redaction-aware logger and pure helpers
    - Create `src/log.ts` with a logger that redacts the session cookie and CSRF token values and full result payloads at every level, including verbose mode
    - Create `src/util.ts` with pure helpers: `encodeForm(body)`, `normalizeSpl(query)`, `clamp(n, lo, hi)`, `looksLikeLoginHtml(text)`, `tryParseJson(text)`, and `form(spl, execMode, earliest, latest, ...)`
    - _Requirements: 15.2, 15.3, 15.4, 15.5_

  - [ ]* 3.2 Write unit tests for helpers and redaction
    - Test `encodeForm` URL-encoding (no body/parameter injection), `normalizeSpl` prefix handling, `looksLikeLoginHtml` detection, and that log output never contains cookie/CSRF/payload values
    - _Requirements: 15.2, 15.4, 15.5_

  - [ ]* 3.3 Write property test for encodeForm round-trip
    - Property: for arbitrary field names/values, `encodeForm` produces properly URL-encoded output that decodes back to the original keys/values with no injection
    - _Requirements: 15.4_

- [x] 4. SessionManager: browser, in-page fetch, auth, concurrency
  - [x] 4.1 Implement persistent context launch and sensitive user-data-dir handling
    - Create `src/session-manager.ts` launching `chromium.launchPersistentContext(userDataDir, ...)` with a single primary page navigated to the Splunk origin
    - Default the user-data-dir to a per-user OS app-data directory; apply owner-only filesystem permissions and deny group/other; error and abort launch if applying permissions definitely fails; proceed if applied but verification is uncertain
    - Guard startup so a missing Chromium binary returns an error and does not launch the context
    - _Requirements: 9.1, 16.1, 16.2, 16.3, 16.4, 17.4_

  - [x] 4.2 Implement in-page fetch (the auth mechanism)
    - Implement `fetchJson(req)` running `fetch` inside the authenticated page via `page.evaluate`, same-origin so the `HttpOnly` cookie attaches automatically and is never read into server memory
    - Route every call through `${baseUrl}/en-US/splunkd/__raw/<path>`; read the CSRF token dynamically from the readable cookie at call time; for state-changing methods (non GET/HEAD) attach `X-Splunk-Form-Key` when the token is present, and abort with a missing-CSRF error (without sending) when absent, while allowing subsequent calls to re-read the token
    - Populate `RawRestResponse` with `ok/status/json/isLoginRedirect` and return a transport/REST error on non-2xx or failed fetch
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [ ]* 4.3 Write property test for Auth Confidentiality
    - **Property 1: Auth Confidentiality**
    - **Validates: Requirements 15.1, 15.2, 15.3**
    - Across arbitrary requests/responses, assert the session cookie value is never read into server state, logged, or persisted outside the user-data-dir

  - [x] 4.4 Implement session probe, MyApps login flow, and readiness
    - Implement `probeSession()` returning healthy only on HTTP 200 + JSON + not-login-redirect within a 10s bound; report not-healthy (without error) for 401/redirect/non-JSON; raise a typed transport-failure error on transport failure even if a 401/redirect classification also applies
    - Implement `ensureReady()` that probes first, and on a dead session opens a visible window, drives the MyApps → Splunk-tile flow (waiting up to 300s), re-probes, and raises `SessionExpiredError` if still dead
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.6, 11.2, 11.3, 11.4_

  - [ ]* 4.5 Write property test for Session-Expiry Detection
    - **Property 2: Session-Expiry Detection**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**
    - For any response that is 401, a login/SSO redirect, or non-JSON HTML, assert classification as a login redirect surfaces a typed `SessionExpiredError` with re-auth instructions, never a silent failure

  - [x] 4.6 Implement the serialized request queue over the shared page
    - Wrap `fetchJson` with a FIFO queue so at most one REST call runs against the shared page at a time; dequeue the next call on completion
    - Fail queued calls with a `TransportError` if the page becomes unavailable, rather than leaving them pending
    - _Requirements: 18.1, 18.2, 18.3_

  - [ ]* 4.7 Write unit tests for SessionManager behavior
    - Mock the `page.evaluate` boundary to return canned `RawRestResponse` values; verify probe classification, missing-CSRF abort + re-read, and FIFO queue serialization/failure semantics
    - _Requirements: 8.4, 8.5, 11.2, 11.3, 18.1, 18.2_

- [x] 5. SplunkClient: search lifecycle and normalization
  - [x] 5.1 Implement result normalization
    - In `src/splunk-client.ts`, implement `normalize(rawJson, count, offset)` producing `fields` in exact Splunk `fields[]` order (empty if absent), rows as keyed objects whose keys are a subset of `fields`, omitting absent field values (no null substitution), `count` equal to rows returned, `messages` mirroring Splunk `messages[]` order (empty if absent), `initOffset` from the response, and optional `raw` passthrough only when requested
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [ ]* 5.2 Write property test for Result Bounds
    - **Property 4: Result Bounds**
    - **Validates: Requirements 5.2, 7.1, 7.3, 7.5**
    - For arbitrary generated Splunk JSON, assert `rows.length <= count`, every row key ∈ `fields`, and `fields` preserves Splunk ordering

  - [x] 5.3 Implement mode resolution
    - Implement `resolveMode(requested, spl)` returning explicit `oneshot`/`async` verbatim; for `auto`/undefined default to `oneshot` and escalate to `async` per the long-running heuristic (wide time range / large maxResults); reject unsupported non-empty mode values without executing, preserving caller input
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 5.4 Write property test for Mode Fidelity
    - **Property 5: Mode Fidelity**
    - **Validates: Requirements 2.1, 2.2**
    - For explicit `mode ∈ {oneshot, async}`, assert `resolveMode` returns exactly that mode; for `auto` assert output ∈ {oneshot, async}

  - [x] 5.5 Implement oneshot and async job creation with session-guarded POST
    - Implement `postWithSessionGuard(req)` that on a login-redirect/401 drives login and re-issues the state-changing request exactly once, returning the retry result or raising `SessionExpiredError`; map non-2xx via the error taxonomy
    - Implement oneshot (`POST services/search/jobs`, `exec_mode=oneshot`) returning an inline `ResultPage`, and async create (`POST services/search/v2/jobs`, `exec_mode=normal`) extracting the SID and failing with a clear error when no SID is returned
    - Apply defaults/clamping for earliest/latest/count (default count, hard ceiling 10000) and reject empty query or invalid count with validation errors before executing
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.5, 2.6, 2.7, 10.5, 10.6, 10.7_

  - [x] 5.6 Implement poll-with-backoff and async completion
    - Implement `pollUntilDone(sid)` with base interval, exponential backoff (×2) capped at a max poll delay, each inter-poll wait clamped to the deadline, and overall termination at `maxWaitMs`
    - On DONE fetch the first `ResultPage` (offset 0, default count); on FAILED return a `SearchError` with Splunk messages and no partial results; on timeout return a job handle with SID + last status; on a poll transport error return a `TransportError` identifying the SID
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [ ]* 5.7 Write property test for Poll Termination
    - **Property 3: Poll Termination**
    - **Validates: Requirements 3.4, 3.1**
    - For any status stream and any `maxWaitMs > 0`, assert `pollUntilDone` terminates and never sleeps past the deadline

  - [x] 5.8 Implement status, paged results, and cancel
    - Implement `status(sid)` (GET job endpoint) returning dispatch state, done flag, `doneProgress` in [0,1], and messages (empty list when absent); reject empty SID and surface a `SearchError` for unknown SIDs
    - Implement `results(sid, {count, offset})` (GET results endpoint) returning a `ResultPage` with at most `count` rows, `initOffset` from Splunk, count clamped to 10000, validation errors for negative count/offset, and zero rows when offset is at/beyond available rows
    - Implement `cancelJob(sid)` (DELETE job endpoint) returning SUCCESS on acceptance, a validation error for empty SID, and a failure outcome carrying Splunk messages for unknown/rejected SIDs
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3_

  - [x] 5.9 Implement whoami and server-info probes
    - Implement `whoami()` (GET `services/authentication/current-context`) returning username + roles and reporting session health per probe classification without raising for expected dead sessions
    - Implement `serverInfo()` (GET `services/server/info`) returning version + build; surface `SessionExpiredError` on login-redirect and an error (no version/build) on failure/timeout
    - _Requirements: 11.1, 12.1, 12.2, 12.3_

  - [ ]* 5.10 Write unit tests for SplunkClient orchestration
    - Mock `fetchJson`; verify path/body construction for oneshot, async create, poll, results, cancel, whoami, server-info; verify backoff sequence, timeout policy, no-SID failure, and empty-page-at-offset behavior
    - _Requirements: 2.5, 2.6, 2.7, 3.2, 4.1, 5.6, 6.1, 12.1_

- [ ] 6. MCP Tool Router and wiring
  - [-] 6.1 Implement the six MCP tools and argument validation
    - Create `src/tool-router.ts` registering `splunk_search`, `splunk_search_status`, `splunk_results`, `splunk_cancel_job`, `splunk_whoami`, `splunk_server_info` with JSON schemas and descriptions
    - Validate/normalize inputs (defaults for earliest/latest/count, positive-integer count, non-empty query/SID) and dispatch to `SplunkClient`
    - _Requirements: 1.1, 1.2, 1.7, 4.3, 5.5, 6.2_

  - [x] 6.2 Wire the server entrypoint over stdio
    - Create `src/server.ts` that loads config, constructs `SessionManager` and `SplunkClient`, registers tools, checks for the Chromium binary at startup (error if missing), and starts the MCP stdio transport
    - Ensure no orphaned modules: every component from tasks 2–5 is constructed and reachable from this entrypoint
    - _Requirements: 13.3, 13.5, 17.4, 17.5_

  - [x] 6.3 Implement error-taxonomy mapping into MCP responses
    - Map `SplunkClient` outcomes/typed errors into MCP tool responses: search errors (ERROR/FATAL messages or FAILED dispatch, non-retryable, concatenated text), 403/permission → permission error, DONE-with-zero-rows → empty rows + informational message (not an error), 429/quota → throttled (retryable), async timeout → job handle with SID (retryable by polling), transport/browser/network → transport error
    - Enforce precedence: permission before throttled before search error when multiple apply
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_

  - [ ]* 6.4 Write unit tests for tool routing and error mapping
    - Verify each tool validates args and dispatches correctly, and that the taxonomy mapping (including the permission→throttled→search precedence and the no-data informational case) produces the expected MCP responses
    - _Requirements: 14.3, 14.7_

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Gated live integration tests
  - [ ]* 8.1 Write gated live smoke integration test
    - Behind an env flag requiring interactive SSO, exercise oneshot, async create/poll/results, whoami, and server-info against the real deployment
    - _Requirements: 1.1, 3.5, 11.1, 12.1_

  - [ ]* 8.2 Write session-expiry and cancel-job integration tests
    - Force a dead session (clear cookies in the profile) and assert `SessionExpiredError` + login-prompt path; exercise `DELETE .../v2/jobs/<SID>` and codify the observed cancel response
    - _Requirements: 9.6, 10.4, 16.5, 6.1, 6.3_

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement acceptance criteria for traceability.
- Property tests validate the six correctness properties (Auth Confidentiality, Session-Expiry Detection, Poll Termination, Result Bounds, Mode Fidelity, Config-Only Per-User); unit tests cover examples and edge cases.
- Checkpoints ensure incremental validation.
- Implementation language is TypeScript, matching the design's interfaces, `fast-check` property tests, and `@modelcontextprotocol/sdk` transport.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.2", "3.3", "4.1"] },
    { "id": 4, "tasks": ["4.2"] },
    { "id": 5, "tasks": ["4.3", "4.4"] },
    { "id": 6, "tasks": ["4.5", "4.6"] },
    { "id": 7, "tasks": ["4.7", "5.1", "5.3"] },
    { "id": 8, "tasks": ["5.2", "5.4", "5.5"] },
    { "id": 9, "tasks": ["5.6", "5.8", "5.9"] },
    { "id": 10, "tasks": ["5.7", "5.10"] },
    { "id": 11, "tasks": ["6.1", "6.2", "6.3"] },
    { "id": 12, "tasks": ["6.4", "8.1", "8.2"] }
  ]
}
```
