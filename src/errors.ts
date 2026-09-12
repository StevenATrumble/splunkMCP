/**
 * Typed error taxonomy for the Splunk MCP Server.
 *
 * The design's "Error Handling" section defines a small, stable set of error
 * conditions the agent can react to. Each error carries a `retryable` flag
 * (matching the `retryable` boolean convention established by
 * `ChromiumMissingError` in `startup-guard.ts`) so callers and the tool router
 * can decide whether a retry makes sense.
 *
 * Requirements:
 * - 14.1: SearchError carries concatenated Splunk message text, non-retryable.
 * - 14.2: PermissionError for 403 / insufficient-permission messages,
 *   non-retryable.
 * - 14.4: ThrottledError for 429 / concurrency-or-quota messages, retryable.
 * - 14.5: TimeoutError (job handle) for async jobs exceeding max wait,
 *   retryable by polling.
 * - 14.6: TransportError for browser-automation / network failures.
 *
 * `SessionExpiredError` (session-expiry detection) and the `NoDataResult`
 * marker (DONE with zero rows — not an error) round out the taxonomy.
 */

import type { JobStatus, SplunkMessage } from "./types.js";

/**
 * Base class for all Splunk MCP errors. Every subclass declares whether the
 * condition is worth retrying via {@link retryable}.
 */
export abstract class SplunkMcpError extends Error {
  /** Whether re-attempting the operation could plausibly succeed. */
  abstract readonly retryable: boolean;

  protected constructor(message: string) {
    super(message);
    // Preserve the subclass name across transpilation / prototype chains.
    this.name = new.target.name;
  }
}

/**
 * Raised when caller-supplied input fails validation before any Splunk request
 * is issued: an empty query/SID, a non-positive or non-integer result count, a
 * negative offset, or an unsupported `mode` value (Requirement 2.4).
 *
 * Validation errors are non-retryable — the same input will fail identically —
 * so the caller must correct the input. When the failure concerns a specific
 * field, {@link field} names it and {@link value} preserves the caller's
 * offending input unchanged so it can be echoed back (Requirement 2.4).
 */
export class ValidationError extends SplunkMcpError {
  /** Correcting the input is required; retrying the same input will not help. */
  override readonly retryable = false;
  /** The name of the field that failed validation, when applicable. */
  readonly field?: string;
  /** The caller's offending input, preserved unchanged for echoing back. */
  readonly value?: unknown;

  constructor(message: string, field?: string, value?: unknown) {
    super(message);
    this.field = field;
    this.value = value;
  }
}

/** Instructions shown to the user when a Splunk session has expired. */
export const SESSION_EXPIRED_HINT =
  "Splunk session expired — a browser login is required. " +
  "Complete SSO/MFA via the MyApps portal and select the Splunk tile.";

/**
 * Raised when a response is classified as a login/SSO redirect, returns HTTP
 * 401, or otherwise indicates the browser session is no longer authenticated.
 * The server drives a headful login and retries once; if login does not
 * establish a live session this error is surfaced.
 *
 * Requirements: 10.4, 10.7, 9.6.
 */
export class SessionExpiredError extends SplunkMcpError {
  /** Re-auth is interactive; the caller should prompt the user to log in. */
  override readonly retryable = true;

  constructor(message: string = SESSION_EXPIRED_HINT) {
    super(message);
  }
}

/**
 * Raised when Splunk reports a search-side failure: a message of type ERROR or
 * FATAL, or a job that reaches a FAILED dispatch state. Carries the
 * concatenated Splunk message text.
 *
 * Requirement: 14.1 (non-retryable; the agent must fix the query).
 */
export class SearchError extends SplunkMcpError {
  /** Search errors are caused by the query/state; retrying will not help. */
  override readonly retryable = false;
  /** The Splunk messages that produced this error, preserved in order. */
  readonly messages: SplunkMessage[];

  constructor(messages: SplunkMessage[], message?: string) {
    super(message ?? SearchError.concatenate(messages));
    this.messages = messages;
  }

  /** Join Splunk message texts into a single agent-facing string. */
  private static concatenate(messages: SplunkMessage[]): string {
    const text = messages
      .map((m) => m.text)
      .filter((t) => t.length > 0)
      .join("; ");
    return text.length > 0 ? text : "Splunk reported a search error.";
  }
}

/**
 * Raised when Splunk returns HTTP 403 or a message indicating the user lacks
 * permission to the requested search or index.
 *
 * Requirement: 14.2 (non-retryable; surface to the user).
 */
export class PermissionError extends SplunkMcpError {
  /** Permissions will not change on retry. */
  override readonly retryable = false;

  constructor(
    message: string = "Insufficient permissions for this search or index.",
  ) {
    super(message);
  }
}

/**
 * Raised when Splunk returns HTTP 429 or a message indicating a concurrency
 * limit or quota was exceeded.
 *
 * Requirement: 14.4 (retryable at a later time).
 */
export class ThrottledError extends SplunkMcpError {
  /** The request may succeed after backing off. */
  override readonly retryable = true;

  constructor(
    message: string = "Splunk throttled the request; retry later.",
  ) {
    super(message);
  }
}

/**
 * Raised when an async job does not reach a done/failed state before the
 * configured maximum wait time. Carries the job SID and last observed status
 * so the agent can poll later.
 *
 * Requirement: 14.5 (retryable by polling via `splunk_search_status` /
 * `splunk_results`).
 */
export class TimeoutError extends SplunkMcpError {
  /** The job is still running; polling by SID can succeed later. */
  override readonly retryable = true;
  /** The job identifier to poll. */
  readonly sid: string;
  /** The last job status observed before the timeout. */
  readonly lastStatus?: JobStatus;

  constructor(sid: string, lastStatus?: JobStatus, message?: string) {
    super(
      message ??
        `Search job ${sid} did not finish within the wait limit; ` +
          "poll it later by SID.",
    );
    this.sid = sid;
    this.lastStatus = lastStatus;
  }
}

/**
 * Raised when a browser-automation or network failure occurs while issuing a
 * request (as opposed to a Splunk-side error). Optionally references the SID
 * when the failure happened during job polling.
 *
 * Requirement: 14.6.
 */
export class TransportError extends SplunkMcpError {
  /** Transport failures are often transient. */
  override readonly retryable = true;
  /** The affected job SID, when the failure occurred during polling. */
  readonly sid?: string;

  constructor(message: string = "Browser automation error.", sid?: string) {
    super(message);
    this.sid = sid;
  }
}

/**
 * Marker (not an `Error`) representing a job that completed successfully with
 * zero result rows. This is an informational, non-error outcome.
 *
 * Requirement: 14.3 (DONE with zero rows is not an error).
 */
export class NoDataResult {
  /** Discriminant for narrowing against error/results outcomes. */
  readonly kind = "no-data" as const;
  /** Informational message describing the empty result. */
  readonly message: string;

  constructor(
    message: string = "The search completed successfully but returned no results.",
  ) {
    this.message = message;
  }
}

/**
 * Type guard for the shared error base so callers can uniformly read
 * `retryable` without a chain of `instanceof` checks.
 */
export function isSplunkMcpError(value: unknown): value is SplunkMcpError {
  return value instanceof SplunkMcpError;
}
