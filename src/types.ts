/**
 * Shared domain types for the Splunk MCP Server.
 *
 * These interfaces mirror the "Data Models" section of the design document
 * exactly and are consumed by the `SessionManager`, `SplunkClient`, and the
 * MCP tool router. They are intentionally transport-agnostic: nothing here
 * depends on Playwright or the MCP SDK.
 *
 * Requirements:
 * - 14.1, 14.2, 14.4, 14.5, 14.6: the error taxonomy (in `errors.ts`) is
 *   built around the outcome/status shapes declared here (e.g. `SplunkMessage`,
 *   `JobStatus`, `SearchOutcome`).
 */

/**
 * A single message emitted by Splunk alongside results, status, or errors
 * (e.g. syntax errors, warnings, informational notices). Mirrors Splunk's
 * `messages[]` entries.
 */
export interface SplunkMessage {
  /** Splunk severity. Common values: INFO, WARN, ERROR, FATAL. */
  type: "INFO" | "WARN" | "ERROR" | "FATAL" | (string & {});
  /** Human-readable message text as reported by Splunk. */
  text: string;
}

/**
 * Arguments for a search request as accepted by the `splunk_search` tool and
 * the `SplunkClient.search` method.
 */
export interface SearchArgs {
  /** SPL query; a leading `search ` is optional and normalized as needed. */
  query: string;
  /** Splunk time modifier for the start of the range (defaults from config). */
  earliest?: string;
  /** Splunk time modifier for the end of the range (defaults from config). */
  latest?: string;
  /** Maximum rows to return (defaults from config; clamped to a hard ceiling). */
  maxResults?: number;
  /** Execution mode selector; defaults to `auto`. */
  mode?: "auto" | "oneshot" | "async";
}

/**
 * Paging arguments for retrieving a page of results from a completed job.
 */
export interface PageArgs {
  /** Maximum rows to return in the page (clamped to the hard ceiling). */
  count: number;
  /** Zero-based offset into the job's result set. */
  offset: number;
}

/**
 * A normalized page of search results. `fields` preserves Splunk's `fields[]`
 * ordering; `rows` are keyed objects whose keys are a subset of `fields`.
 */
export interface ResultPage {
  /** Column order copied verbatim from Splunk's `fields[]` (empty if absent). */
  fields: string[];
  /** Rows keyed by field name; absent field values are omitted (not nulled). */
  rows: Record<string, unknown>[];
  /** Optional raw Splunk JSON passthrough, present only when requested. */
  raw?: unknown;
  /** True when Splunk marked the results as preview (not final). */
  preview: boolean;
  /** The `init_offset` reported by Splunk for this page. */
  initOffset: number;
  /** Number of rows included in this page (equals `rows.length`). */
  count: number;
  /** Splunk `messages[]` mirrored in order (empty array if absent). */
  messages: SplunkMessage[];
}

/**
 * Status of an asynchronous search job as reported by the job endpoint.
 */
export interface JobStatus {
  /** The search job identifier. */
  sid: string;
  /** Splunk dispatch state (QUEUED, PARSING, RUNNING, DONE, FAILED, ...). */
  dispatchState:
    | "QUEUED"
    | "PARSING"
    | "RUNNING"
    | "FINALIZING"
    | "DONE"
    | "FAILED"
    | (string & {});
  /** True once Splunk reports the job is finished. */
  isDone: boolean;
  /** Completion progress in the inclusive range [0, 1]. */
  doneProgress: number;
  /** Number of result rows produced, when reported by Splunk. */
  resultCount?: number;
  /** Splunk `messages[]` mirrored in order (empty array if absent). */
  messages: SplunkMessage[];
}

/**
 * The outcome of a `search` call. Either results are available (oneshot, or a
 * completed async first page) or an async job did not complete before the
 * timeout and only a handle + last status is returned.
 */
export type SearchOutcome =
  | { kind: "results"; sid?: string; page: ResultPage }
  | { kind: "job"; sid: string; status: JobStatus };

/**
 * The outcome of a {@link cancelJob} request. Splunk either accepts the
 * cancellation (`SUCCESS`) or rejects it — because the SID is unknown or the
 * cancellation is refused — in which case the outcome is `FAILURE` and carries
 * the Splunk-reported messages so callers can surface them (Requirement 6.3).
 *
 * A cancel is modeled as an *outcome* rather than a thrown error: an
 * unrecognized or rejected SID is a normal, non-exceptional result the caller
 * inspects, not a transport/search failure.
 */
export type CancelResult =
  | { outcome: "SUCCESS" }
  | { outcome: "FAILURE"; messages: SplunkMessage[] };

/**
 * Identity + session-health information returned by the identity probe.
 */
export interface CurrentContext {
  /** The authenticated Splunk username. */
  username: string;
  /** Roles assigned to the authenticated user. */
  roles: string[];
  /** Always `true`; a healthy probe is a precondition for returning this. */
  sessionHealthy: true;
}

/**
 * Splunk server version/build information.
 */
export interface ServerInfo {
  /** Splunk version string. */
  version: string;
  /** Splunk build identifier (e.g. "10.5.2605.6"). */
  build: string;
}

/**
 * Result of a session-health probe. Never carries the session cookie value.
 */
export interface SessionHealth {
  /** True only for HTTP 200 + JSON body that is not a login redirect. */
  healthy: boolean;
  /** Discovered username when the probe was healthy. */
  username?: string;
}

/**
 * An internal REST request executed via the in-page fetch mechanism. `path`
 * is relative to the `${baseUrl}/en-US/splunkd/__raw/` proxy prefix.
 */
export interface RawRestRequest {
  /** HTTP method for the REST call. */
  method: "GET" | "POST" | "DELETE";
  /** REST path relative to the proxy prefix, e.g. "services/search/v2/jobs". */
  path: string;
  /** URL-encoded form fields for state-changing (POST) requests. */
  body?: Record<string, string>;
}

/**
 * The structured response of an in-page fetch. The session cookie value is
 * never exposed here (it is attached implicitly by the browser).
 */
export interface RawRestResponse {
  /** True when the underlying HTTP response was 2xx. */
  ok: boolean;
  /** The HTTP status code. */
  status: number;
  /** Parsed JSON body when the content type was JSON; otherwise undefined. */
  json?: unknown;
  /** True when the response looks like an SSO/login redirect or a 401. */
  isLoginRedirect: boolean;
}
