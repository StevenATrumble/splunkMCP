/**
 * Pure, side-effect-free helpers shared by the SessionManager and SplunkClient.
 *
 * Everything here is deterministic and dependency-free so it can be unit- and
 * property-tested in isolation (tasks 3.2 and 3.3). The functions cover the
 * building blocks referenced by the design's "In-page fetch" and "search
 * orchestration" pseudocode: form encoding, SPL normalization, numeric
 * clamping, login-HTML detection, JSON parsing, and search-body construction.
 *
 * Requirements:
 * - 15.4: `encodeForm` URL-encodes field names and values so no value can
 *   inject additional parameters or break out of the form body.
 */

/**
 * The `exec_mode` values Splunk accepts for a search-job POST. `oneshot`
 * returns results inline; `normal` creates an async job identified by a SID.
 */
export type ExecMode = "oneshot" | "normal";

/**
 * URL-encode a record of form fields into an `application/x-www-form-urlencoded`
 * body string. Both keys and values are percent-encoded via
 * {@link encodeURIComponent}, so a value such as `a=b&c=d` cannot smuggle extra
 * parameters into the body (Requirement 15.4). Field order follows the object's
 * own enumeration order.
 *
 * `undefined` values are skipped entirely; explicit empty strings are preserved
 * (encoded as `key=`), which matches how Splunk expects empty `earliest_time` /
 * `latest_time` to be sent.
 *
 * @param body - Map of field name to string value (or `undefined` to omit).
 * @returns The encoded body, e.g. `search=index%3D_internal&output_mode=json`.
 */
export function encodeForm(body: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}

/**
 * Ensure an SPL query carries a leading `search` command when required.
 *
 * Splunk's search endpoints implicitly prepend `search ` only in some contexts;
 * we normalize explicitly so callers get predictable behavior:
 * - A query that already begins with the `search` command (case-insensitive) is
 *   returned unchanged (aside from trimming surrounding whitespace).
 * - A query that begins with a leading pipe (`|`, a generating command such as
 *   `| tstats ...`) is returned unchanged — prefixing `search` would be invalid.
 * - Any other non-empty query is prefixed with `search `.
 *
 * The returned string is always trimmed of surrounding whitespace. An
 * empty-after-trim query is returned as an empty string; validation of empty
 * queries is the caller's responsibility (Requirement 1.2).
 *
 * @param query - The raw SPL query as provided by the caller.
 * @returns The normalized SPL query.
 */
export function normalizeSpl(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return "";
  }
  // Generating commands begin with a pipe and must not be prefixed.
  if (trimmed.startsWith("|")) {
    return trimmed;
  }
  // Already a `search ...` command (as a whole word), case-insensitive.
  if (/^search(\s|$)/i.test(trimmed)) {
    return trimmed;
  }
  return `search ${trimmed}`;
}

/**
 * Clamp a number into the inclusive range `[lo, hi]`.
 *
 * @param n - The value to clamp.
 * @param lo - The inclusive lower bound.
 * @param hi - The inclusive upper bound (must be `>= lo`).
 * @returns `lo` when `n < lo`, `hi` when `n > hi`, otherwise `n`.
 */
export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) {
    return lo;
  }
  if (n > hi) {
    return hi;
  }
  return n;
}

/**
 * Heuristically detect whether a response body is a Microsoft SSO or Splunk
 * login/HTML page rather than a JSON API payload. Used to classify an expired
 * session as a login redirect (Requirement 10.2, 10.3).
 *
 * The heuristic is intentionally conservative: it treats a body as a login page
 * when it looks like HTML and mentions recognizable login/SSO markers. It never
 * inspects or returns any secret value.
 *
 * @param text - The raw response body text.
 * @returns `true` when the body appears to be an SSO/login HTML page.
 */
export function looksLikeLoginHtml(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  const sample = text.slice(0, 4096).toLowerCase();
  const looksLikeHtml =
    sample.includes("<!doctype html") ||
    sample.includes("<html") ||
    sample.includes("<head") ||
    sample.includes("<body") ||
    sample.includes("<form");
  if (!looksLikeHtml) {
    return false;
  }
  const loginMarkers = [
    "login.microsoftonline.com",
    "microsoftonline",
    "sign in",
    "sign-in",
    "signin",
    "single sign-on",
    "saml",
    "account.splunk", // Splunk login screens
    "splunk_form_key",
    'name="username"',
    'name="password"',
    "loginform",
    "login page",
    "/account/login",
  ];
  return loginMarkers.some((marker) => sample.includes(marker));
}

/**
 * Attempt to parse `text` as JSON, returning the parsed value or `undefined`
 * when the text is absent or not valid JSON. Never throws.
 *
 * @param text - The candidate JSON string (may be `undefined`).
 * @returns The parsed JSON value, or `undefined` on any failure.
 */
export function tryParseJson(text: string | undefined | null): unknown {
  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Build the url-encoded form field map for a search-job POST.
 *
 * Produces the fields validated in the design's REST endpoint reference:
 * `search`, `output_mode=json`, `exec_mode`, `earliest_time`, `latest_time`.
 * The SPL is normalized via {@link normalizeSpl}. The `earliest`/`latest`
 * values are passed through verbatim (no local time parsing, Requirement 1.8);
 * empty strings are preserved so Splunk receives explicit empty time bounds.
 *
 * The returned record is intended to be passed to {@link encodeForm}, which
 * performs the actual percent-encoding.
 *
 * @param spl - The SPL query (will be normalized).
 * @param execMode - `oneshot` for inline results, `normal` for an async job.
 * @param earliest - Splunk `earliest_time` modifier (passed through).
 * @param latest - Splunk `latest_time` modifier (passed through).
 * @param extra - Optional additional form fields merged last (overriding).
 * @returns The form-field map for the search POST body.
 */
export function form(
  spl: string,
  execMode: ExecMode,
  earliest: string,
  latest: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const fields: Record<string, string> = {
    search: normalizeSpl(spl),
    output_mode: "json",
    exec_mode: execMode,
    earliest_time: earliest,
    latest_time: latest,
  };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      fields[key] = value;
    }
  }
  return fields;
}
