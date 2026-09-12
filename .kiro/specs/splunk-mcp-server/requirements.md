# Requirements Document

## Introduction

The Splunk MCP Server is a self-contained Node.js MCP (Model Context Protocol) server that lets an agent run Splunk searches and read results against a Splunk Cloud deployment where API tokens are disabled. Because the only available authentication path is interactive Microsoft Entra (Azure AD) SSO + MFA, the server treats an authenticated browser session as the source of authentication: a human logs in once via a browser managed by the server, and the server reuses that session to drive Splunk's REST layer through the `splunkd/__raw` proxy using the in-page fetch model (same-origin `fetch` executed inside the authenticated page, so the `HttpOnly` session cookie is attached automatically).

These requirements are derived from the approved design document (`design.md`) and are traceable to the design decisions already made. They cover the search lifecycle, session/auth lifecycle, identity and server probes, configuration, result normalization, error taxonomy, security, and packaging. They are written so the six correctness properties defined in the design (Auth Confidentiality, Session-Expiry Detection, Poll Termination, Result Bounds, Mode Fidelity, Config-Only Per-User) can reference specific acceptance criteria.

## Glossary

- **Splunk_MCP_Server**: The self-contained Node.js MCP server described by this specification. Referred to as "the server" in prose.
- **Tool_Router**: The component that registers MCP tools, validates arguments, and maps outcomes and errors into MCP tool responses.
- **Splunk_Client**: The component that encapsulates the Splunk REST lifecycle (oneshot search, async create/poll/results, cancel, probes) as high-level methods.
- **Session_Manager**: The component that owns the Playwright persistent browser context and authenticated page, probes session health, and drives login.
- **Config_Loader**: The component that loads configuration from environment variables and applies defaults.
- **Authenticated_Page**: The single Playwright browser page, on the Splunk origin, whose session cookie authenticates REST calls.
- **In_Page_Fetch**: The mechanism of executing REST calls via same-origin `fetch` inside the Authenticated_Page so the `HttpOnly` session cookie is attached automatically by the browser.
- **User_Data_Dir**: The persistent Chromium profile directory that stores the Microsoft SSO and Splunk session across restarts.
- **Session_Cookie**: The `HttpOnly` `splunkd_8443` cookie that authenticates Splunk requests. Its value is never read by server code.
- **CSRF_Token**: The value of the readable `splunkweb_csrf_token_8443` cookie, sent as the `X-Splunk-Form-Key` header on state-changing requests when present.
- **SID**: A Splunk search job identifier returned when an asynchronous job is created.
- **Oneshot_Search**: A blocking search (`exec_mode=oneshot`) that returns results inline in a single response.
- **Async_Search**: A search (`exec_mode=normal`) that creates a job identified by a SID, is polled until done, and whose results are then fetched.
- **Auto_Mode**: A search mode in which the Splunk_Client selects oneshot or async based on a heuristic.
- **Result_Page**: A normalized page of search results containing an ordered field list, keyed rows, paging metadata, and any Splunk messages.
- **Session_Health_Probe**: A read-only call to `services/authentication/current-context` used to determine whether the Splunk session is live.
- **Login_Redirect**: A response indicating an expired session, detected as HTTP 401, an SSO/login redirect, or non-JSON HTML in the response body.
- **MyApps_Login_Flow**: The confirmed login path that navigates the browser to the Microsoft MyApps portal and clicks the Splunk tile to reach an authenticated Splunk session.

## Requirements

### Requirement 1: Run Splunk Searches

**User Story:** As an agent, I want to run an SPL search with a time range and result limit, so that I can retrieve data from Splunk on behalf of the user.

#### Acceptance Criteria

1. WHEN a search request is received with a non-empty query, THE Splunk_MCP_Server SHALL execute the search against the Splunk REST layer and return normalized results.
2. IF a search request is received with a query that is empty after trimming whitespace, THEN THE Splunk_MCP_Server SHALL reject the request with a validation error and SHALL NOT execute a search.
3. WHEN a search request omits the earliest time, THE Splunk_MCP_Server SHALL apply the configured default earliest time.
4. WHEN a search request omits the latest time, THE Splunk_MCP_Server SHALL apply the configured default latest time.
5. WHEN a search request omits the maximum result count, THE Splunk_MCP_Server SHALL apply the configured default result count.
6. WHEN a search request specifies a maximum result count greater than the hard result ceiling of 10000, THE Splunk_MCP_Server SHALL clamp the count to 10000 before executing the search.
7. IF a search request specifies a maximum result count that is less than 1 or is not a positive integer, THEN THE Splunk_MCP_Server SHALL reject the request with a validation error and SHALL NOT execute a search.
8. WHEN a search request specifies an earliest time and a latest time, THE Splunk_MCP_Server SHALL pass those values through as the `earliest_time` and `latest_time` job arguments without local time parsing.

### Requirement 2: Search Mode Selection

**User Story:** As an agent, I want to control or defer the choice between oneshot and async execution, so that quick lookups return inline while long-running searches are handled asynchronously.

#### Acceptance Criteria

1. WHERE the requested search mode is `oneshot`, THE Splunk_Client SHALL execute the search as an Oneshot_Search.
2. WHERE the requested search mode is `async`, THE Splunk_Client SHALL execute the search as an Async_Search.
3. WHERE the requested search mode is `auto` or the mode is omitted, THE Splunk_Client SHALL select exactly one of Oneshot_Search or Async_Search, defaulting to Oneshot_Search unless the search specifies a time range exceeding 60 seconds of expected runtime or the requested result count exceeds 10000 rows, in which case it SHALL select Async_Search.
4. IF the requested search mode is a non-empty value other than `oneshot`, `async`, or `auto`, THEN THE Splunk_Client SHALL reject the request without executing a search and return an error response indicating the mode value is unsupported, preserving the caller's input unchanged.
5. WHEN executing an Oneshot_Search, THE Splunk_Client SHALL issue a POST to `services/search/jobs` with `exec_mode=oneshot` and return the inline results as a Result_Page.
6. WHEN executing an Async_Search, THE Splunk_Client SHALL issue a POST to `services/search/v2/jobs` with `exec_mode=normal` and obtain a SID from the response.
7. IF an Async_Search POST completes without a retrievable SID in the response, THEN THE Splunk_Client SHALL treat the search as failed and return an error response indicating that job creation did not yield a SID.

### Requirement 3: Asynchronous Job Polling and Completion

**User Story:** As an agent, I want async searches to be polled until they finish, so that I receive completed results without managing the job lifecycle myself.

#### Acceptance Criteria

1. WHEN an Async_Search job has been created, THE Splunk_Client SHALL poll the job status endpoint until the job reports done, the job reports a failed dispatch state, or the elapsed polling time reaches the configured maximum wait time.
2. WHILE polling an Async_Search job, THE Splunk_Client SHALL wait the configured base poll interval before the first poll and multiply the wait by a factor of 2 after each successive poll, up to the configured maximum poll delay.
3. WHILE polling an Async_Search job, THE Splunk_Client SHALL limit each inter-poll wait so that it does not extend beyond the configured maximum wait time deadline.
4. THE Splunk_Client SHALL terminate polling once the elapsed polling time reaches the configured maximum wait time, so that total polling time does not exceed the configured maximum wait time.
5. WHEN an Async_Search job reaches a done state, THE Splunk_Client SHALL fetch the first Result_Page for the job starting at offset 0 with at most the configured default result count of rows and return the results.
6. IF an Async_Search job reaches a failed dispatch state, THEN THE Splunk_Client SHALL return a search error carrying the Splunk-reported messages and SHALL NOT return partial results.
7. IF an Async_Search job does not reach a done or failed state before the configured maximum wait time is reached, THEN THE Splunk_Client SHALL return a job handle containing the SID and the last observed job status.
8. IF a status poll request fails due to a transport or browser-automation error, THEN THE Splunk_Client SHALL return a transport error identifying the SID and SHALL NOT return results.

### Requirement 4: Job Status Inspection

**User Story:** As an agent, I want to check the status of a running job by its SID, so that I can decide when to fetch results after a timeout.

#### Acceptance Criteria

1. WHEN a status request is received for a well-formed SID, THE Splunk_Client SHALL issue a GET to the job status endpoint for that SID and return a job status containing the dispatch state, the done flag, and the done progress as a value between 0 and 1 inclusive.
2. WHEN a status response contains Splunk messages, THE Splunk_Client SHALL include those messages in the returned job status; otherwise THE Splunk_Client SHALL return an empty messages list.
3. IF a status request is received for a SID that is empty after trimming whitespace, THEN THE Splunk_Client SHALL reject the request with a validation error and SHALL NOT issue a status request.
4. IF a status request targets a SID that Splunk does not recognize, THEN THE Splunk_Client SHALL return a search error carrying the Splunk-reported messages and SHALL NOT return a job status.

### Requirement 5: Paged Result Retrieval

**User Story:** As an agent, I want to fetch results for a completed job in pages, so that I can read large result sets without exceeding response limits.

#### Acceptance Criteria

1. WHEN a results request is received for a well-formed SID with a count and an offset, THE Splunk_Client SHALL issue a GET to the job results endpoint with the given count and offset and return a Result_Page.
2. WHEN returning a Result_Page, THE Splunk_Client SHALL include at most the requested count of rows.
3. WHEN returning a Result_Page, THE Splunk_Client SHALL set the page offset to the initial offset reported by Splunk in the results response.
4. WHEN a results request specifies a count that exceeds the hard result ceiling of 10000, THE Splunk_Client SHALL clamp the count to 10000 before issuing the request.
5. IF a results request specifies a count below 0 or an offset below 0, THEN THE Splunk_Client SHALL reject the request with a validation error and SHALL NOT issue a results request.
6. IF a results request specifies an offset at or beyond the number of available rows for the job, THEN THE Splunk_Client SHALL return a Result_Page containing zero rows.

### Requirement 6: Job Cancellation

**User Story:** As an agent, I want to cancel a running job, so that I can free Splunk resources when results are no longer needed.

#### Acceptance Criteria

1. WHEN a cancel request is received for a well-formed SID AND Splunk accepts the cancellation, THE Splunk_Client SHALL issue a DELETE to the job endpoint for that SID and return a cancellation outcome set to a SUCCESS value.
2. IF a cancel request is received for a SID that is empty after trimming whitespace, THEN THE Splunk_Client SHALL reject the request with a validation error and SHALL NOT issue a cancel request.
3. IF a cancel request targets a SID that Splunk does not recognize or the cancellation is rejected by Splunk, THEN THE Splunk_Client SHALL return a cancellation outcome indicating failure carrying the Splunk-reported messages.

### Requirement 7: Result Normalization

**User Story:** As an agent, I want search results in a consistent, agent-friendly shape, so that I can access columns and rows predictably.

#### Acceptance Criteria

1. WHEN normalizing search results, THE Splunk_Client SHALL produce a field list whose entries and left-to-right ordering are identical to the entries and ordering of the Splunk `fields[]` array.
2. IF the Splunk response contains no `fields[]` array, THEN THE Splunk_Client SHALL produce a field list containing zero entries.
3. WHEN normalizing search results, THE Splunk_Client SHALL produce each row as a keyed object whose keys are a subset of the field list, such that no key is present that is absent from the field list.
4. WHEN a field in the field list has no value in a given Splunk result row, THE Splunk_Client SHALL omit that field's key from that row rather than inserting a fabricated or null-substituted value.
5. WHEN normalizing search results, THE Splunk_Client SHALL set the returned Result_Page row count equal to the number of rows included in that Result_Page.
6. WHEN the Splunk response contains a `messages[]` array, THE Splunk_Client SHALL include in the Result_Page a messages list whose entries match the entries of the Splunk `messages[]` array in the same order.
7. IF the Splunk response contains no `messages[]` array, THEN THE Splunk_Client SHALL produce a messages list containing zero entries in the Result_Page.
8. WHERE raw passthrough is requested, THE Splunk_Client SHALL include in the Result_Page the Splunk JSON unchanged from the response as received.
9. WHERE raw passthrough is not requested, THE Splunk_Client SHALL omit the raw Splunk JSON from the Result_Page.

### Requirement 8: Browser-Session Authentication via In-Page Fetch

**User Story:** As a user, I want the server to authenticate using my browser session instead of an API token, so that I can use Splunk despite tokens being disabled.

#### Acceptance Criteria

1. THE Session_Manager SHALL execute every Splunk REST call as an In_Page_Fetch within the Authenticated_Page on the Splunk origin.
2. IF a request uses a state-changing HTTP method (any method other than GET or HEAD) AND the CSRF_Token is present, THEN THE Session_Manager SHALL include the CSRF_Token as the `X-Splunk-Form-Key` header on that request.
3. IF a request uses a state-changing HTTP method (any method other than GET or HEAD), THEN THE Session_Manager SHALL read the CSRF_Token dynamically from the readable cookie at call time.
4. IF a request uses a state-changing HTTP method (any method other than GET or HEAD) AND no CSRF_Token is readable from the cookie at call time, THEN THE Session_Manager SHALL abort the request and return an error indicating a missing CSRF token, without sending the request.
5. WHEN a state-changing request is aborted due to a missing CSRF_Token, THE Session_Manager SHALL NOT block subsequent requests and SHALL re-attempt reading the CSRF_Token from the cookie on each subsequent state-changing request.
6. THE Session_Manager SHALL route every REST call through the `${baseUrl}/en-US/splunkd/__raw/` proxy path.
7. IF an In_Page_Fetch fails to complete or returns a non-2xx HTTP status, THEN THE Session_Manager SHALL return an error indicating the REST call failed, including the returned status when one is available.

### Requirement 9: Persistent Session and Login Lifecycle

**User Story:** As a user, I want my login to survive server restarts and to be prompted only when needed, so that re-authentication is usually silent.

#### Acceptance Criteria

1. WHEN the browser context is launched, THE Session_Manager SHALL use a persistent User_Data_Dir so that the Microsoft SSO session survives across server restarts.
2. WHEN preparing to run work, THE Session_Manager SHALL perform a Session_Health_Probe before executing the requested operation, where the probe is considered live only if it returns a successful (2xx) response within 10 seconds.
3. IF the Session_Health_Probe does not return a successful (2xx) response within 10 seconds, THEN THE Session_Manager SHALL treat the session as not live, open a visible browser window, and drive the MyApps_Login_Flow.
4. WHILE driving the MyApps_Login_Flow, THE Session_Manager SHALL wait for user completion for up to 300 seconds before treating the login flow as failed.
5. WHEN the login flow completes, THE Session_Manager SHALL repeat the Session_Health_Probe to confirm the session is live.
6. IF the session is still not live after the login flow completes or after the login-flow wait limit is reached, THEN THE Session_Manager SHALL return a session-expired error indicating that login did not establish a live session.

### Requirement 10: Session-Expiry Detection

**User Story:** As an agent, I want expired sessions reported clearly, so that I can prompt the user to re-authenticate instead of receiving opaque failures.

#### Acceptance Criteria

1. IF a response returns HTTP status 401, THEN THE Splunk_MCP_Server SHALL classify the response as a Login_Redirect indicating an expired session.
2. IF a response redirects to, or has a body whose content is, a Microsoft SSO or Splunk login page, THEN THE Splunk_MCP_Server SHALL classify the response as a Login_Redirect indicating an expired session.
3. IF a response body has a content type that is not JSON, THEN THE Splunk_MCP_Server SHALL classify the response as a Login_Redirect indicating an expired session.
4. WHEN a response is classified as a Login_Redirect, THE Splunk_MCP_Server SHALL surface a typed session-expired error that identifies the response as an expired session and includes instructions to complete SSO/MFA via the MyApps_Login_Flow.
5. IF a state-changing request is classified as a Login_Redirect, THEN THE Session_Manager SHALL drive the MyApps_Login_Flow and re-issue the original state-changing request exactly once.
6. WHEN the re-issued state-changing request is not classified as a Login_Redirect, THE Splunk_MCP_Server SHALL return the response of the re-issued request.
7. IF the re-issued state-changing request is again classified as a Login_Redirect, THEN THE Splunk_MCP_Server SHALL surface a typed session-expired error and SHALL NOT re-issue the request again.

### Requirement 11: Identity and Session Health Probe

**User Story:** As an agent, I want to query the current identity and session health, so that I can confirm who I am acting as and whether the session is usable.

#### Acceptance Criteria

1. WHEN an identity request is received, THE Splunk_Client SHALL issue a GET to `services/authentication/current-context` and return the username and the list of roles from the response.
2. IF the Session_Health_Probe returns HTTP status 200 with a JSON body and is not classified as a Login_Redirect, THEN THE Session_Manager SHALL report the session as healthy.
3. IF the Session_Health_Probe returns HTTP status 401, is classified as a Login_Redirect, or returns a body whose content type is not JSON, THEN THE Session_Manager SHALL report the session as not healthy and SHALL NOT raise an error.
4. IF the Session_Health_Probe encounters a transport failure, THEN THE Session_Manager SHALL raise a typed transport-failure error and SHALL NOT report the session as either healthy or not healthy, even where an HTTP 401 or Login_Redirect classification also applies to the same attempt.

### Requirement 12: Server Information

**User Story:** As an agent, I want to read the Splunk server version and build, so that I can adapt behavior to the deployment.

#### Acceptance Criteria

1. WHEN a server-info request is received, THE Splunk_Client SHALL issue a GET to `services/server/info` and return the Splunk version and build from the response.
2. IF a server-info request is classified as a Login_Redirect, THEN THE Splunk_MCP_Server SHALL surface a typed session-expired error and SHALL NOT return a version or build.
3. IF the GET to `services/server/info` fails or times out, THEN THE Splunk_Client SHALL return an error to the requesting agent and SHALL NOT return a version or build.

### Requirement 13: Config-Only Per-User Setup

**User Story:** As any user in the organization, I want to configure the server by editing environment variables only, so that I can use it without code changes or values hardcoded to another person.

#### Acceptance Criteria

1. THE Config_Loader SHALL read configuration values exclusively from environment variables, and IF configuration is available from any non-environment-variable source such as a file, THEN THE Config_Loader SHALL NOT use that configuration even where it is otherwise valid.
2. WHEN the base URL environment variable is not set, THE Config_Loader SHALL apply the documented default base URL.
3. IF the base URL environment variable is set to an empty string or a value that is not a syntactically valid URL, THEN THE Config_Loader SHALL reject the configuration, return an error indicating the invalid base URL, and SHALL NOT start the Splunk_MCP_Server.
4. WHEN an optional configuration environment variable is not set, THE Config_Loader SHALL apply its documented default value.
5. IF a required environment variable is not set and has no documented default value, THEN THE Config_Loader SHALL return an error indicating which required variable is missing and SHALL NOT start the Splunk_MCP_Server.
6. THE Splunk_MCP_Server SHALL construct Splunk search paths using the non-namespaced `services/search/...` form without a username segment.
7. THE Splunk_MCP_Server SHALL treat the username configuration value as optional and SHALL complete the full search lifecycle (create, poll, and retrieve results) when the username value is not set.
8. THE Splunk_MCP_Server SHALL NOT reference any username value that is hardcoded in source code, and SHALL derive any username value used at runtime solely from an environment variable.

### Requirement 14: Error Taxonomy

**User Story:** As an agent, I want failures reported using a small, stable set of typed errors, so that I can react appropriately to each condition.

#### Acceptance Criteria

1. IF a Splunk response contains a message of type ERROR or FATAL, or a job reaches a FAILED dispatch state, THEN THE Splunk_MCP_Server SHALL return a search error that carries the concatenated Splunk message text and indicates the error is non-retryable.
2. IF a response returns HTTP 403, or contains a message indicating insufficient permissions or authorization to the requested search or index, THEN THE Splunk_MCP_Server SHALL return a permission error that indicates the error is non-retryable.
3. WHEN a job completes with dispatch state DONE and returns zero result rows, THE Splunk_MCP_Server SHALL return an empty rows result containing an informational message and SHALL NOT return an error.
4. IF a response returns HTTP 429, or contains a message indicating a concurrency limit or quota was exceeded, THEN THE Splunk_MCP_Server SHALL return a throttled error that indicates the request is retryable at a later time.
5. IF an Async_Search job remains not done after the configured maximum wait time (SPLUNK_MAX_WAIT_MS, default 120000 milliseconds) has elapsed, THEN THE Splunk_MCP_Server SHALL return a timeout outcome that contains the job SID and indicates the job is retryable by polling.
6. IF a browser automation or network failure occurs while issuing a request, THEN THE Splunk_MCP_Server SHALL return a transport error that indicates the failure originated in the transport layer rather than in Splunk.
7. WHEN more than one error condition in criteria 1, 2, and 4 could apply to the same response, THE Splunk_MCP_Server SHALL classify the response as a permission error before a throttled error, and as a throttled error before a search error.

### Requirement 15: Session Confidentiality and Secret Handling

**User Story:** As a security-conscious user, I want the server never to expose my session credentials, so that using it does not leak my authenticated access.

#### Acceptance Criteria

1. THE Splunk_MCP_Server SHALL rely on the browser to attach the Session_Cookie implicitly on same-origin requests and SHALL NOT read the Session_Cookie value into server memory.
2. THE Splunk_MCP_Server SHALL exclude the Session_Cookie value from all log output at every log level.
3. THE Splunk_MCP_Server SHALL exclude the Session_Cookie value from all persisted state written outside the User_Data_Dir.
4. WHERE verbose logging is enabled, THE Splunk_MCP_Server SHALL still exclude the CSRF_Token value and full result payloads from log output.
5. IF a secret value (the Session_Cookie or the CSRF_Token) would otherwise be emitted in a log record or error record, THEN THE Splunk_MCP_Server SHALL redact that value before the record is written.

### Requirement 16: Sensitive User-Data-Dir Handling

**User Story:** As a security-conscious user, I want the persisted browser profile protected, so that my live session cannot be trivially reused by others.

#### Acceptance Criteria

1. WHEN no User_Data_Dir location is configured, THE Splunk_MCP_Server SHALL store the User_Data_Dir in a per-user OS application-data directory.
2. WHEN creating the User_Data_Dir, THE Splunk_MCP_Server SHALL restrict its filesystem permissions to owner-only access and deny access to group and other users.
3. IF applying owner-only permissions to the User_Data_Dir definitely fails, THEN THE Splunk_MCP_Server SHALL return an error identifying the permission failure and SHALL NOT proceed to launch the browser context.
4. WHERE applying owner-only permissions to the User_Data_Dir succeeds but verification of the applied permissions is uncertain, THE Splunk_MCP_Server SHALL proceed to launch the browser context.
5. WHEN a logout is requested, THE Splunk_MCP_Server SHALL clear the contents of the User_Data_Dir so that the next request requires re-authentication.

### Requirement 17: Self-Contained Packaging

**User Story:** As a user setting up the server, I want it to install and run without external dependencies, so that setup is a straightforward npm install.

#### Acceptance Criteria

1. THE Splunk_MCP_Server SHALL declare Playwright as a normal npm dependency and SHALL NOT depend on any external MCP server at runtime.
2. WHEN the package is installed, THE Splunk_MCP_Server SHALL install the Chromium browser binary via a postinstall step running `playwright install chromium`.
3. WHERE postinstall network access is restricted, THE Splunk_MCP_Server SHALL support installing Chromium via a documented `npx playwright install chromium` fallback step.
4. IF the Chromium browser binary is not present when the server starts, THEN THE Splunk_MCP_Server SHALL return an error indicating Chromium must be installed and SHALL NOT proceed to launch the browser context.
5. THE Splunk_MCP_Server SHALL expose its tools over the MCP stdio transport.

### Requirement 18: Concurrency Serialization

**User Story:** As an agent, I want concurrent requests handled safely against the single authenticated page, so that overlapping calls do not corrupt session state.

#### Acceptance Criteria

1. WHILE the Authenticated_Page is processing a REST call, THE Session_Manager SHALL hold additional REST calls in a request queue and SHALL prevent any queued call from starting until the in-progress call completes, so that at most one REST call executes against the shared page at a time.
2. WHEN a REST call completes, THE Session_Manager SHALL dequeue and execute the next queued REST call in first-in-first-out order.
3. IF the Authenticated_Page becomes unavailable while REST calls are queued, THEN THE Session_Manager SHALL fail the queued calls with a transport error rather than leaving them pending indefinitely.
