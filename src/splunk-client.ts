/**
 * SplunkClient: encapsulates the Splunk REST lifecycle (oneshot search, async
 * create/poll/results, cancel, identity/server probes) as high-level methods,
 * independent of MCP. Mirrors the design's "Component 2: SplunkClient"
 * interface.
 *
 * The {@link SplunkClient} class implements the full method surface from the
 * design, built up across tasks 5.1–5.9:
 * - `normalize` (module-level)         — task 5.1 (exported for 5.2 tests)
 * - `resolveMode` (module-level)       — task 5.3
 * - `search` (oneshot/async)           — task 5.5
 * - `pollUntilDone`                    — task 5.6 (private orchestration)
 * - `status` / `results` / `cancelJob` — task 5.8
 * - `whoami` / `serverInfo`            — task 5.9
 *
 * Requirements (task 5.1):
 * - 7.1: `fields` order/entries identical to Splunk `fields[]`.
 * - 7.2: absent `fields[]` yields an empty field list.
 * - 7.3: each row is keyed only by names present in `fields`.
 * - 7.4: a field with no value in a row has its key omitted (no null/fabricated
 *   value).
 * - 7.5: the returned `count` equals the number of rows included.
 * - 7.6: `messages` mirrors Splunk `messages[]` in order.
 * - 7.7: absent `messages[]` yields an empty messages list.
 * - 7.8: raw passthrough is included only when requested.
 * - 7.9: raw passthrough is omitted when not requested.
 */

import type { Config } from "./config.js";
import {
  PermissionError,
  SearchError,
  SESSION_EXPIRED_HINT,
  SessionExpiredError,
  ThrottledError,
  TransportError,
  ValidationError,
} from "./errors.js";
import type { SessionManager } from "./session-manager.js";
import type {
  CancelResult,
  CurrentContext,
  JobStatus,
  PageArgs,
  RawRestRequest,
  RawRestResponse,
  ResultPage,
  SearchArgs,
  SearchOutcome,
  ServerInfo,
  SplunkMessage,
} from "./types.js";
import { clamp, form, normalizeSpl } from "./util.js";

/**
 * The hard ceiling on the number of result rows a single page may contain
 * (Requirements 1.6 / 5.4). Result normalization also caps the emitted rows at
 * the requested `count`, which callers clamp to this ceiling before requesting.
 */
export const HARD_RESULT_CEILING = 10000;

/**
 * The cap on a single inter-poll wait during {@link SplunkClient.pollUntilDone}
 * (task 5.6). The base interval (`config.pollIntervalMs`) doubles after each
 * poll but is never allowed to grow beyond this ceiling, so a long-running job
 * is still polled at a sensible cadence rather than backing off indefinitely
 * (Requirement 3.2). Individual waits are further clamped to the overall
 * deadline (Requirement 3.3), so this only bounds the geometric growth.
 */
export const MAX_POLL_DELAY_MS = 10_000;

/**
 * Extract the ordered field-name list from a Splunk `fields[]` array.
 *
 * Splunk returns `fields[]` in two observed shapes depending on the endpoint:
 * an array of objects (`[{ name: "foo" }, ...]`) or an array of plain strings
 * (`["foo", ...]`). Both are handled here, extracting the field name and
 * preserving left-to-right ordering exactly (Requirement 7.1). Entries that are
 * neither a non-empty string nor an object with a string `name` are skipped, as
 * they cannot key a row.
 *
 * @param rawFields - The value of the response's `fields` property (any type).
 * @returns The ordered field names (empty when absent/unusable; Req 7.2).
 */
function extractFieldNames(rawFields: unknown): string[] {
  if (!Array.isArray(rawFields)) {
    // Req 7.2: no usable fields[] => empty field list.
    return [];
  }
  const names: string[] = [];
  for (const entry of rawFields) {
    if (typeof entry === "string") {
      if (entry.length > 0) {
        names.push(entry);
      }
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * Normalize a single raw Splunk result row into a keyed object whose keys are a
 * strict subset of `fields` (Requirement 7.3), omitting any field whose value
 * is absent rather than substituting `null` or a fabricated value
 * (Requirement 7.4).
 *
 * "Absent" is defined as: the raw row is not an object, the key is missing, or
 * its value is `undefined`/`null`. A present-but-empty string is a real value
 * and is preserved.
 *
 * @param rawRow - One entry from the response's `results[]` array.
 * @param fields - The ordered field names governing which keys may appear.
 * @returns A keyed row containing only present values for known fields.
 */
function normalizeRow(
  rawRow: unknown,
  fields: string[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (typeof rawRow !== "object" || rawRow === null) {
    return row;
  }
  const source = rawRow as Record<string, unknown>;
  for (const field of fields) {
    // Req 7.3: only keys drawn from `fields` may appear.
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      continue;
    }
    const value = source[field];
    // Req 7.4: omit the key entirely when the field has no value; never
    // substitute null or a fabricated placeholder.
    if (value === undefined || value === null) {
      continue;
    }
    row[field] = value;
  }
  return row;
}

/**
 * Mirror a Splunk `messages[]` array into the normalized {@link SplunkMessage}
 * list, preserving order (Requirement 7.6) and returning an empty list when the
 * array is absent or unusable (Requirement 7.7).
 *
 * Each entry is expected as `{ type, text }`; a missing `type` defaults to
 * `INFO` and a missing/non-string `text` defaults to an empty string so the
 * shape is always valid. Entries that are not objects are skipped.
 *
 * @param rawMessages - The value of the response's `messages` property.
 * @returns The ordered messages (empty when absent; Req 7.7).
 */
function extractMessages(rawMessages: unknown): SplunkMessage[] {
  if (!Array.isArray(rawMessages)) {
    // Req 7.7: no messages[] => empty list.
    return [];
  }
  const messages: SplunkMessage[] = [];
  for (const entry of rawMessages) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const type = (entry as { type?: unknown }).type;
    const text = (entry as { text?: unknown }).text;
    messages.push({
      type: typeof type === "string" && type.length > 0 ? type : "INFO",
      text: typeof text === "string" ? text : "",
    });
  }
  return messages;
}

/**
 * Read a numeric `init_offset` from the raw response, falling back to the
 * requested `offset` when Splunk did not report one (Requirement 5.3 relies on
 * the reported value; here we default sensibly when it is absent).
 *
 * @param rawJson - The parsed Splunk response object (any type).
 * @param offset - The offset the caller requested, used as the fallback.
 * @returns The response's `init_offset` when it is a finite number, else
 *   `offset`.
 */
function extractInitOffset(rawJson: unknown, offset: number): number {
  if (typeof rawJson === "object" && rawJson !== null) {
    const initOffset = (rawJson as { init_offset?: unknown }).init_offset;
    if (typeof initOffset === "number" && Number.isFinite(initOffset)) {
      return initOffset;
    }
  }
  return offset;
}

/**
 * Read the `preview` flag from the raw response, defaulting to `false` when it
 * is absent or not a boolean.
 *
 * @param rawJson - The parsed Splunk response object (any type).
 * @returns The response's `preview` boolean, or `false` when unset.
 */
function extractPreview(rawJson: unknown): boolean {
  if (typeof rawJson === "object" && rawJson !== null) {
    const preview = (rawJson as { preview?: unknown }).preview;
    if (typeof preview === "boolean") {
      return preview;
    }
  }
  return false;
}

/**
 * Normalize a raw Splunk results/oneshot JSON body into the agent-friendly
 * {@link ResultPage} shape (task 5.1).
 *
 * The transformation is pure (no mutation of `rawJson`) and total (never
 * throws): any missing or malformed section degrades to a sensible empty
 * default so callers always receive a well-formed page.
 *
 * Behavior, per Requirement 7:
 * - `fields` copies Splunk's `fields[]` names in exact order, handling both the
 *   object (`{name}`) and plain-string entry shapes; empty when absent
 *   (7.1, 7.2).
 * - `rows` are keyed objects whose keys are a subset of `fields`; a field with
 *   no value in a given row has its key omitted rather than null-substituted
 *   (7.3, 7.4). At most `count` rows are included (Result Bounds; see 5.2/7.5),
 *   so callers can rely on `rows.length <= count`.
 * - `count` equals `rows.length` — the number of rows actually included (7.5).
 * - `messages` mirrors Splunk `messages[]` in order; empty when absent
 *   (7.6, 7.7).
 * - `initOffset` is Splunk's reported `init_offset`, falling back to the
 *   requested `offset` when the response omits it.
 * - `preview` reflects the response's `preview` flag (default `false`).
 * - `raw` carries the untouched `rawJson` only when `includeRaw` is `true`
 *   (7.8); it is omitted otherwise (7.9).
 *
 * @param rawJson - The parsed Splunk results JSON (may be any type; unusable
 *   shapes degrade to empty defaults).
 * @param count - The requested page-size cap; the emitted `rows` never exceed
 *   this length. Values below 0 are treated as 0.
 * @param offset - The zero-based offset requested, used as the `initOffset`
 *   fallback when the response omits `init_offset`.
 * @param includeRaw - When `true`, attach the unchanged `rawJson` as `raw`
 *   (Req 7.8); when `false` (default), omit it (Req 7.9).
 * @returns A fully-formed {@link ResultPage}.
 */
export function normalize(
  rawJson: unknown,
  count: number,
  offset: number,
  includeRaw = false,
): ResultPage {
  // Clamp the cap to a non-negative integer so the row slice is well-defined
  // even for nonsensical inputs; the emitted rows never exceed this (7.5 /
  // Result Bounds).
  const cap = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

  const container =
    typeof rawJson === "object" && rawJson !== null
      ? (rawJson as Record<string, unknown>)
      : undefined;

  const fields = extractFieldNames(container?.["fields"]);

  const rawResults = container?.["results"];
  const rows: Record<string, unknown>[] = [];
  if (Array.isArray(rawResults)) {
    for (const rawRow of rawResults) {
      if (rows.length >= cap) {
        // Enforce the requested page-size cap (Result Bounds: rows.length <=
        // count).
        break;
      }
      rows.push(normalizeRow(rawRow, fields));
    }
  }

  const messages = extractMessages(container?.["messages"]);
  const initOffset = extractInitOffset(rawJson, offset);
  const preview = extractPreview(rawJson);

  const page: ResultPage = {
    fields,
    rows,
    preview,
    initOffset,
    // Req 7.5: count equals the number of rows included in this page.
    count: rows.length,
    messages,
  };

  // Req 7.8/7.9: attach the raw passthrough only when explicitly requested.
  if (includeRaw) {
    page.raw = rawJson;
  }

  return page;
}

/**
 * The resolved execution mode for a search: a blocking inline `oneshot` or an
 * async job (`async`). {@link resolveMode} always collapses the caller's
 * `auto`/undefined request into exactly one of these (Mode Fidelity /
 * Requirement 2.3).
 */
export type ResolvedMode = "oneshot" | "async";

/**
 * Detect signals in an SPL query that suggest a long-running search, used only
 * as a best-effort tie-breaker for `auto` mode (Requirement 2.3).
 *
 * SPL is opaque to us — we do not parse or evaluate it — so this heuristic is
 * intentionally conservative and syntactic. It escalates to async when the
 * query widens the (default short) time window inline via `earliest`/`latest`
 * that reach back further than a minute, since those are the queries whose
 * "expected runtime" is most likely to exceed the ~60s oneshot comfort zone
 * described in Requirement 2.3. It is deterministic and side-effect free.
 *
 * This is a heuristic, not a guarantee: it can neither see Splunk's planner nor
 * measure real runtime. Callers who need certainty should pass an explicit
 * `mode`.
 *
 * @param spl - The (already-normalized) SPL query text.
 * @returns `true` when the query looks likely to be long-running.
 */
function looksLongRunning(spl: string): boolean {
  if (typeof spl !== "string" || spl.length === 0) {
    return false;
  }
  const lower = spl.toLowerCase();

  // An "all time" window (or an explicit earliest reaching back beyond a
  // minute) is the clearest inline signal of a potentially slow search.
  if (/\bearliest\s*=\s*0\b/.test(lower)) {
    return true;
  }
  // earliest=-<n><unit> where the window is wider than ~60 seconds: any
  // minute/hour/day/week/month/year window, or a seconds window > 60.
  const earliestMatch = lower.match(
    /\bearliest\s*=\s*-?(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mon|month|months|y|yr|year|years)\b/,
  );
  if (earliestMatch) {
    const amount = Number.parseInt(earliestMatch[1] ?? "", 10);
    const unit = earliestMatch[2] ?? "";
    const isSecondUnit = /^(s|sec|secs|second|seconds)$/.test(unit);
    // Non-second units always exceed a 60s window; a seconds window escalates
    // only when it is strictly greater than 60.
    if (!isSecondUnit || (Number.isFinite(amount) && amount > 60)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the caller-requested search mode into a concrete {@link ResolvedMode}
 * (task 5.3). Pure and deterministic — no I/O, no mutation.
 *
 * Behavior, per Requirement 2:
 * - An explicit `"oneshot"` or `"async"` is returned verbatim (2.1, 2.2 — Mode
 *   Fidelity).
 * - `"auto"` or `undefined` selects exactly one mode (2.3): it defaults to
 *   `"oneshot"` and escalates to `"async"` only when the search looks
 *   long-running — either the requested result count exceeds the hard ceiling
 *   of {@link HARD_RESULT_CEILING} rows, or the SPL widens the time window past
 *   ~60 seconds of expected runtime (see {@link looksLongRunning}).
 * - Any other non-empty value is rejected with a {@link ValidationError}
 *   without executing a search, preserving the caller's input unchanged on the
 *   error's `value` field (2.4).
 *
 * Note on signature: Requirement 2.3's escalation heuristic references the
 * requested result count, so `maxResults` is accepted as an optional third
 * argument. It is only consulted for `auto`/undefined; explicit modes ignore it
 * (Mode Fidelity). When omitted, only the SPL-based signal is considered.
 *
 * @param requested - The caller's `mode` (`"oneshot" | "async" | "auto"`,
 *   `undefined`, or an unsupported value that triggers a `ValidationError`).
 * @param spl - The SPL query text, consulted only for the `auto` heuristic.
 * @param maxResults - Optional requested result count; escalates to `async`
 *   when it exceeds {@link HARD_RESULT_CEILING} (auto mode only).
 * @returns Exactly one of `"oneshot"` or `"async"`.
 * @throws {ValidationError} When `requested` is a non-empty, unsupported value.
 */
export function resolveMode(
  requested: SearchArgs["mode"] | (string & {}) | undefined,
  spl: string,
  maxResults?: number,
): ResolvedMode {
  // 2.1 / 2.2: explicit modes are honored verbatim (Mode Fidelity).
  if (requested === "oneshot" || requested === "async") {
    // The `string & {}` arm of the parameter type prevents TS from narrowing
    // the literal here, but the runtime comparison guarantees it is one of the
    // two resolved modes.
    return requested as ResolvedMode;
  }

  // 2.3: `auto` or omitted defaults to oneshot, escalating to async only on a
  // long-running signal.
  if (requested === undefined || requested === "auto") {
    // Requested result count above the hard ceiling => async.
    if (
      typeof maxResults === "number" &&
      Number.isFinite(maxResults) &&
      maxResults > HARD_RESULT_CEILING
    ) {
      return "async";
    }
    // Wide/opaque time window signal from the SPL text => async.
    if (looksLongRunning(spl)) {
      return "async";
    }
    return "oneshot";
  }

  // 2.4: any other non-empty value is unsupported — reject without executing,
  // preserving the caller's input on `value`.
  throw new ValidationError(
    `Unsupported search mode: ${JSON.stringify(requested)}. ` +
      'Expected one of "oneshot", "async", or "auto".',
    "mode",
    requested,
  );
}

/**
 * Extract the async job SID from a create-job response body (Requirement 2.6,
 * 2.7). Splunk's `services/search/v2/jobs` create returns `{ sid: "..." }`;
 * some shapes nest it under `entry[0].content.sid`. Both are handled, returning
 * the first non-empty string SID found, or `undefined` when none is present so
 * the caller can treat the create as failed (Req 2.7).
 *
 * @param json - The parsed create-job response body (any type).
 * @returns The SID string, or `undefined` when absent/unusable.
 */
function extractSid(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const direct = (json as { sid?: unknown }).sid;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  // Fallback: some endpoints report the SID inside the entry/content shape.
  const entry = (json as { entry?: unknown }).entry;
  if (Array.isArray(entry) && entry.length > 0) {
    const first = entry[0];
    if (typeof first === "object" && first !== null) {
      const content = (first as { content?: unknown }).content;
      if (typeof content === "object" && content !== null) {
        const nested = (content as { sid?: unknown }).sid;
        if (typeof nested === "string" && nested.length > 0) {
          return nested;
        }
      }
    }
  }
  return undefined;
}

/**
 * Extract any Splunk `messages[]` entries from a raw response body so a failing
 * HTTP response can carry Splunk's own text into a {@link SearchError}. Returns
 * an empty list when absent or unusable.
 *
 * @param json - The parsed response body (any type).
 * @returns The messages in order (empty when absent).
 */
function extractHttpMessages(json: unknown): SplunkMessage[] {
  if (typeof json !== "object" || json === null) {
    return [];
  }
  const rawMessages = (json as { messages?: unknown }).messages;
  if (!Array.isArray(rawMessages)) {
    return [];
  }
  const messages: SplunkMessage[] = [];
  for (const entry of rawMessages) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const type = (entry as { type?: unknown }).type;
    const text = (entry as { text?: unknown }).text;
    messages.push({
      type: typeof type === "string" && type.length > 0 ? type : "ERROR",
      text: typeof text === "string" ? text : "",
    });
  }
  return messages;
}

/**
 * Decide whether a non-2xx {@link RawRestResponse} indicates that the target
 * SID is unknown to Splunk (Requirements 4.4, 5.x, 6.3). Splunk reports an
 * unrecognized job either with an HTTP 404 or with a `messages[]` entry whose
 * text names the job as missing/not found, so both signals are checked.
 *
 * The message-text heuristic is intentionally conservative and case-insensitive
 * so common Splunk phrasings ("Unknown sid", "does not exist", "not found",
 * "cannot find") are recognized without matching unrelated errors.
 *
 * @param resp - The response to inspect.
 * @returns `true` when the response looks like an unknown/not-found SID.
 */
function looksUnknownSid(resp: RawRestResponse): boolean {
  if (resp.status === 404) {
    return true;
  }
  const messages = extractHttpMessages(resp.json);
  return messages.some((m) => {
    const text = m.text.toLowerCase();
    return (
      text.includes("unknown sid") ||
      text.includes("does not exist") ||
      text.includes("not found") ||
      text.includes("cannot find") ||
      text.includes("could not find") ||
      text.includes("no such")
    );
  });
}

/**
 * Build a {@link SearchError} for a response that refers to an unknown SID,
 * carrying Splunk's own `messages[]` when present (Requirement 4.4) and falling
 * back to a clear generic message naming the SID otherwise.
 *
 * @param resp - The unknown-SID response.
 * @param sid - The SID that was not recognized.
 * @returns A {@link SearchError} carrying the Splunk messages.
 */
function unknownSidError(resp: RawRestResponse, sid: string): SearchError {
  const messages = extractHttpMessages(resp.json);
  if (messages.length > 0) {
    return new SearchError(messages);
  }
  return new SearchError(
    [
      {
        type: "ERROR",
        text: `Splunk does not recognize search job ${sid}.`,
      },
    ],
    `Splunk does not recognize search job ${sid}.`,
  );
}

/**
 * Coerce Splunk's `isDone` into a strict boolean. Splunk has been observed to
 * report this flag as a real boolean (`true`/`false`) or as a string
 * (`"1"`/`"0"`), so both spellings are normalized here. Anything else is
 * treated as not-done.
 *
 * @param value - The raw `isDone` value from the job's `content`.
 * @returns `true` only for `true`, `"1"`, or `"true"` (case-insensitive).
 */
function coerceIsDone(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    return lowered === "1" || lowered === "true";
  }
  return false;
}

/**
 * Coerce Splunk's `doneProgress` into the inclusive range [0, 1]
 * (Requirement 4.1). Values arrive as a number or a numeric string; anything
 * unparseable defaults to 0, and out-of-range values are clamped.
 *
 * @param value - The raw `doneProgress` value from the job's `content`.
 * @returns A finite number clamped to [0, 1].
 */
function coerceDoneProgress(value: unknown): number {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number.parseFloat(value);
  } else {
    n = 0;
  }
  if (!Number.isFinite(n)) {
    return 0;
  }
  return clamp(n, 0, 1);
}

/**
 * Coerce Splunk's `resultCount` into a non-negative integer when present,
 * returning `undefined` when it is absent or unparseable so the field stays
 * optional on {@link JobStatus}.
 *
 * @param value - The raw `resultCount` value from the job's `content`.
 * @returns The parsed count, or `undefined` when not reported.
 */
function coerceResultCount(value: unknown): number | undefined {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number.parseInt(value, 10);
  } else {
    return undefined;
  }
  if (!Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return Math.floor(n);
}

/**
 * Parse a raw Splunk job-status response body into a {@link JobStatus}
 * (Requirement 3.1, 4.1, 4.2). Splunk's status endpoint reports the job under
 * `entry[0].content.{dispatchState,isDone,doneProgress,resultCount}` with
 * `messages[]` alongside; both the top-level `messages[]` and the nested
 * `content.messages[]` are considered so Splunk-reported text is preserved.
 *
 * The parse is total (never throws): a missing/malformed body degrades to a
 * not-done `JobStatus` carrying the supplied `sid` and an empty message list,
 * so the poll loop can classify it and keep making progress toward the
 * deadline.
 *
 * @param json - The parsed status response body (any type).
 * @param sid - The job SID the status is for (echoed into the result).
 * @returns A normalized {@link JobStatus} for `sid`.
 */
function parseJobStatus(json: unknown, sid: string): JobStatus {
  const content = extractJobContent(json);
  const dispatchStateRaw = content?.["dispatchState"];
  const dispatchState =
    typeof dispatchStateRaw === "string" && dispatchStateRaw.length > 0
      ? dispatchStateRaw
      : "UNKNOWN";
  const isDone = coerceIsDone(content?.["isDone"]);
  const doneProgress = coerceDoneProgress(content?.["doneProgress"]);
  const resultCount = coerceResultCount(content?.["resultCount"]);

  // Req 4.2: mirror Splunk messages when present (empty list otherwise). Prefer
  // the nested content.messages[], falling back to a top-level messages[].
  let messages = extractMessages(content?.["messages"]);
  if (messages.length === 0) {
    messages = extractMessages(
      typeof json === "object" && json !== null
        ? (json as { messages?: unknown }).messages
        : undefined,
    );
  }

  const status: JobStatus = {
    sid,
    dispatchState,
    isDone,
    doneProgress,
    messages,
  };
  if (resultCount !== undefined) {
    status.resultCount = resultCount;
  }
  return status;
}

/**
 * Extract the `entry[0].content` object from a Splunk job-status response, the
 * shape both the poll and status endpoints use. Returns `undefined` when the
 * body does not carry a usable content object.
 *
 * @param json - The parsed status response body (any type).
 * @returns The job's `content` record, or `undefined` when absent.
 */
function extractJobContent(json: unknown): Record<string, unknown> | undefined {
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const entry = (json as { entry?: unknown }).entry;
  if (!Array.isArray(entry) || entry.length === 0) {
    return undefined;
  }
  const first = entry[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const content = (first as { content?: unknown }).content;
  if (typeof content !== "object" || content === null) {
    return undefined;
  }
  return content as Record<string, unknown>;
}

/**
 * Extract the `entry[0].content` object shared by the `current-context` and
 * `server/info` responses (`{ entry: [ { content: { ... } } ] }`). Returns
 * `undefined` when the body is not the expected shape, so the callers can fall
 * back to sensible defaults. Never throws.
 *
 * @param json - The parsed response body (any type).
 * @returns The `content` record, or `undefined` when absent/unusable.
 */
function extractContent(json: unknown): Record<string, unknown> | undefined {
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const entry = (json as { entry?: unknown }).entry;
  if (!Array.isArray(entry) || entry.length === 0) {
    return undefined;
  }
  const first = entry[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const content = (first as { content?: unknown }).content;
  if (typeof content !== "object" || content === null) {
    return undefined;
  }
  return content as Record<string, unknown>;
}

/**
 * Extract the authenticated username from a `current-context` `content` object
 * (Requirement 11.1). Returns an empty string when absent so a healthy probe
 * without a discoverable username still yields a well-formed
 * {@link CurrentContext} (the username is derived solely from Splunk's
 * response, never from a hardcoded value; Req 13.8).
 *
 * @param content - The `entry[0].content` record, or `undefined`.
 * @returns The username, or `""` when absent.
 */
function extractContextUsername(
  content: Record<string, unknown> | undefined,
): string {
  const username = content?.["username"];
  return typeof username === "string" ? username : "";
}

/**
 * Extract the role list from a `current-context` `content` object
 * (Requirement 11.1). Splunk reports `roles` as an array of strings; non-string
 * entries are skipped and a missing/unusable `roles` yields an empty list.
 *
 * @param content - The `entry[0].content` record, or `undefined`.
 * @returns The roles in order (empty when absent).
 */
function extractContextRoles(
  content: Record<string, unknown> | undefined,
): string[] {
  const raw = content?.["roles"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const roles: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      roles.push(entry);
    }
  }
  return roles;
}

/**
 * Extract a string field from a `server/info` `content` object, defaulting to
 * an empty string when the field is absent or not a string (Requirement 12.1).
 *
 * @param content - The `entry[0].content` record, or `undefined`.
 * @param field - The field name to read (`version` or `build`).
 * @returns The field value, or `""` when absent/non-string.
 */
function extractStringField(
  content: Record<string, unknown> | undefined,
  field: string,
): string {
  const value = content?.[field];
  return typeof value === "string" ? value : "";
}

/**
 * Map a non-2xx {@link RawRestResponse} onto the typed error taxonomy so
 * callers of {@link SplunkClient.search} (and the tool router) receive a
 * meaningful, typed failure rather than an opaque HTTP status.
 *
 * This is a minimal, HTTP-status-driven mapping sufficient for task 5.5:
 * - HTTP 403 => {@link PermissionError} (Req 14.2).
 * - HTTP 429 => {@link ThrottledError} (Req 14.4).
 * - anything else non-2xx => {@link SearchError} carrying any Splunk messages
 *   from the body (Req 14.1), falling back to a generic message with the status.
 *
 * NOTE (task 6.3): the full agent-facing taxonomy — including message-content
 * classification (ERROR/FATAL text, permission/quota keywords) and the
 * permission → throttled → search precedence — is refined at the MCP layer.
 * This mapping only covers the obvious HTTP codes so callers get a typed error
 * at the client boundary.
 *
 * @param resp - The non-2xx response to classify.
 * @returns A typed error appropriate to the response status.
 */
function mapHttpError(
  resp: RawRestResponse,
): PermissionError | ThrottledError | SearchError {
  if (resp.status === 403) {
    return new PermissionError();
  }
  if (resp.status === 429) {
    return new ThrottledError();
  }
  const messages = extractHttpMessages(resp.json);
  if (messages.length > 0) {
    return new SearchError(messages);
  }
  return new SearchError(
    [
      {
        type: "ERROR",
        text: `Splunk request failed with HTTP status ${resp.status}.`,
      },
    ],
    `Splunk request failed with HTTP status ${resp.status}.`,
  );
}

/**
 * High-level Splunk REST orchestration built on top of the {@link
 * SessionManager}'s in-page fetch. Constructed with a resolved {@link Config}
 * and a {@link SessionManager}; the session manager provides the authenticated
 * `fetchJson` path all REST methods will route through.
 *
 * Only the constructor and {@link normalize} (module-level) are implemented in
 * task 5.1. The remaining methods are stubs that later tasks replace with real
 * implementations (see the module doc comment for the task mapping).
 */
/**
 * Injectable collaborators for {@link SplunkClient}. All default to real
 * implementations; the poll-timing seams (`now`, `sleep`) let the unit tests
 * (task 5.10) drive {@link SplunkClient.pollUntilDone}'s backoff and timeout
 * without incurring real waits, and `maxPollDelayMs` overrides the backoff cap.
 */
export interface SplunkClientOptions {
  /**
   * Monotonic clock accessor (ms). Injectable so the poll loop's deadline math
   * is testable without real time. Defaults to {@link Date.now}.
   */
  now?: () => number;
  /**
   * Sleep seam resolving after roughly `ms` milliseconds. Injectable so tests
   * can advance time without real waits. Defaults to a `setTimeout` wrapper.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The cap on a single inter-poll wait (Requirement 3.2). Defaults to
   * {@link MAX_POLL_DELAY_MS}.
   */
  maxPollDelayMs?: number;
}

export class SplunkClient {
  private readonly session: SessionManager;
  private readonly config: Config;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxPollDelayMs: number;

  constructor(
    session: SessionManager,
    config: Config,
    opts: SplunkClientOptions = {},
  ) {
    this.session = session;
    this.config = config;
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.maxPollDelayMs = opts.maxPollDelayMs ?? MAX_POLL_DELAY_MS;
  }

  /**
   * Return the authenticated identity and session health (task 5.9).
   *
   * Issues `GET services/authentication/current-context?output_mode=json` via
   * the read-only in-page fetch and classifies the response exactly as the
   * {@link SessionManager.probeSession} primitive does (Requirement 11.2/11.3):
   * a session is live only for HTTP 200 with a JSON body that is NOT a login
   * redirect. The underlying probe never throws for an expected dead session —
   * it reports `{healthy:false}` — and {@link whoami} builds on that
   * classification here.
   *
   * Behavior, per Requirement 11.1:
   * - Healthy: parse `entry[0].content.username` and `entry[0].content.roles`
   *   from the response and return a {@link CurrentContext}
   *   (`{username, roles, sessionHealthy:true}`).
   * - Dead session (401 / login redirect / non-JSON): the read-only probe
   *   itself does not raise (matching Req 11.3), but a {@link CurrentContext}
   *   requires `sessionHealthy:true` and therefore cannot describe a dead
   *   session. `whoami` surfaces a {@link SessionExpiredError} so the agent is
   *   prompted to re-authenticate rather than receiving a fabricated identity.
   *
   * A transport/browser-automation failure from the underlying fetch propagates
   * as the {@link TransportError} it already maps to (Requirement 11.4); it is
   * not swallowed here.
   *
   * @returns The authenticated {@link CurrentContext} when the session is live.
   * @throws {@link SessionExpiredError} when the session is not live (401 /
   *   login redirect / non-JSON body).
   * @throws {@link TransportError} on a transport/browser-automation failure.
   */
  async whoami(): Promise<CurrentContext> {
    const resp = await this.session.fetchJson({
      method: "GET",
      path: "services/authentication/current-context?output_mode=json",
    });

    // Req 11.2/11.3: live only for 200 + JSON + not-a-login-redirect. Any other
    // classification is a dead session; a CurrentContext cannot represent it,
    // so surface a typed session-expired error (Req 10.4).
    if (
      !resp.ok ||
      resp.status !== 200 ||
      resp.json === undefined ||
      resp.isLoginRedirect
    ) {
      throw new SessionExpiredError(
        `Cannot read the current Splunk identity; the session is not live. ${SESSION_EXPIRED_HINT}`,
      );
    }

    const content = extractContent(resp.json);
    const username = extractContextUsername(content);
    const roles = extractContextRoles(content);

    return { username, roles, sessionHealthy: true };
  }

  /**
   * Return the Splunk server version and build (task 5.9).
   *
   * Issues `GET services/server/info?output_mode=json` via the read-only in-page
   * fetch and parses `entry[0].content.{version,build}` from the response.
   *
   * Behavior, per Requirement 12:
   * - Req 12.1: on a live, successful response, return `{version, build}` from
   *   the server-info body.
   * - Req 12.2: when the response is classified as a login redirect (or HTTP
   *   401), surface a {@link SessionExpiredError} and return no version/build.
   * - Req 12.3: when the GET fails/times out at the transport layer, or returns
   *   a non-2xx status, throw an error and return no version/build. A transport
   *   failure propagates as a {@link TransportError}; a non-2xx status is mapped
   *   onto the typed taxonomy via {@link mapHttpError}.
   *
   * @returns The Splunk {@link ServerInfo} (version + build).
   * @throws {@link SessionExpiredError} when the response is a login redirect
   *   (Req 12.2).
   * @throws {@link TransportError} when the fetch fails/times out (Req 12.3).
   * @throws {@link PermissionError} / {@link ThrottledError} / {@link SearchError}
   *   per {@link mapHttpError} for a non-2xx response (Req 12.3).
   */
  async serverInfo(): Promise<ServerInfo> {
    const resp = await this.session.fetchJson({
      method: "GET",
      path: "services/server/info?output_mode=json",
    });

    // Req 12.2: a login redirect (or 401) is an expired session — no version.
    if (resp.isLoginRedirect || resp.status === 401) {
      throw new SessionExpiredError(
        `Session expired while reading Splunk server info. ${SESSION_EXPIRED_HINT}`,
      );
    }

    // Req 12.3: a non-2xx response is a failure; return no version/build.
    if (!resp.ok) {
      throw mapHttpError(resp);
    }

    const content = extractContent(resp.json);
    const version = extractStringField(content, "version");
    const build = extractStringField(content, "build");

    return { version, build };
  }

  /**
   * Execute a search and return its outcome (task 5.5).
   *
   * The lifecycle, per Requirement 1 and 2:
   * 1. Validate and normalize the arguments BEFORE any REST call:
   *    - Reject an empty-after-trim query with a {@link ValidationError}
   *      (Req 1.2) — no search is issued.
   *    - Reject a `maxResults` that is present but not a positive integer
   *      (< 1 or non-integer) with a {@link ValidationError} (Req 1.7).
   *    - Apply the configured defaults for a missing earliest/latest/count
   *      (Req 1.3, 1.4, 1.5).
   *    - Clamp the effective count to `[1, HARD_RESULT_CEILING]` (Req 1.6).
   *    - Pass earliest/latest through verbatim as `earliest_time`/`latest_time`
   *      with no local time parsing (Req 1.8).
   * 2. Resolve the execution mode (Req 2.1–2.4) via {@link resolveMode}; the
   *    normalized SPL and requested `maxResults` inform the `auto` heuristic.
   * 3. Oneshot (Req 2.5): POST `services/search/jobs` with `exec_mode=oneshot`
   *    and return the inline results as a normalized {@link ResultPage}.
   * 4. Async (Req 2.6, 2.7): POST `services/search/v2/jobs` with
   *    `exec_mode=normal`, extract the SID, and fail with a clear
   *    {@link SearchError} when the response yields no SID.
   *
   * Every state-changing POST goes through {@link postWithSessionGuard}, which
   * drives a re-login and single retry on an expired session (Req 10.5–10.7)
   * and maps non-2xx responses onto the typed error taxonomy.
   *
   * NOTE (task 5.6): the async branch currently returns a job handle with a
   * minimal `RUNNING` status immediately after job creation. Task 5.6 will wire
   * {@link pollUntilDone} in here so the client polls to completion and returns
   * the first result page on DONE. The seam is the clearly-marked call site
   * below.
   *
   * @param args - The search request (query, optional time range, count, mode).
   * @returns A {@link SearchOutcome}: inline results (oneshot) or a job handle
   *   (async, until task 5.6 completes the poll-to-done path).
   * @throws {@link ValidationError} for an empty query or invalid count.
   * @throws {@link SessionExpiredError} when re-login does not restore the
   *   session (Req 10.7).
   * @throws {@link SearchError} when async job creation yields no SID (Req 2.7)
   *   or Splunk reports a non-2xx search failure.
   */
  async search(args: SearchArgs): Promise<SearchOutcome> {
    // --- Validation + defaults (Req 1.2–1.8), all BEFORE any REST call. ---

    // Req 1.2: empty-after-trim query is rejected without executing a search.
    const spl = normalizeSpl(args.query ?? "");
    if (spl.length === 0) {
      throw new ValidationError(
        "Search query must be a non-empty string.",
        "query",
        args.query,
      );
    }

    // Req 1.7: a present maxResults must be a positive integer (>= 1).
    if (args.maxResults !== undefined) {
      if (
        typeof args.maxResults !== "number" ||
        !Number.isInteger(args.maxResults) ||
        args.maxResults < 1
      ) {
        throw new ValidationError(
          "maxResults must be a positive integer (>= 1).",
          "maxResults",
          args.maxResults,
        );
      }
    }

    // Req 1.3/1.4: apply configured defaults for a missing earliest/latest.
    const earliest = args.earliest ?? this.config.defaultEarliest;
    const latest = args.latest ?? this.config.defaultLatest;

    // Req 1.5: apply the configured default count when omitted.
    // Req 1.6: clamp the effective count into [1, HARD_RESULT_CEILING].
    const requestedCount = args.maxResults ?? this.config.defaultCount;
    const count = clamp(requestedCount, 1, HARD_RESULT_CEILING);

    // Req 2.1–2.4: resolve oneshot vs async. The requested (pre-clamp) count
    // informs the auto heuristic (see resolveMode); an unsupported mode raises
    // a ValidationError here before any REST call.
    const mode = resolveMode(args.mode, spl, requestedCount);

    if (mode === "oneshot") {
      // Req 2.5: oneshot POST returns results inline. `form` already sets
      // output_mode=json and exec_mode=oneshot; `count` bounds the inline rows.
      const body = form(spl, "oneshot", earliest, latest, {
        count: String(count),
      });
      const resp = await this.postWithSessionGuard({
        method: "POST",
        path: "services/search/jobs",
        body,
      });
      // Req 1.8 satisfied by passing earliest/latest through verbatim above.
      return {
        kind: "results",
        page: normalize(resp.json, count, 0),
      };
    }

    // Req 2.6: async create POST (exec_mode=normal) yields a job SID.
    const body = form(spl, "normal", earliest, latest);
    const resp = await this.postWithSessionGuard({
      method: "POST",
      path: "services/search/v2/jobs",
      body,
    });

    // Req 2.7: a create that returns no retrievable SID is a failed search.
    const sid = extractSid(resp.json);
    if (sid === undefined) {
      throw new SearchError(
        [
          {
            type: "ERROR",
            text: "Async search job creation did not return a SID.",
          },
        ],
        "Async search job creation did not return a SID.",
      );
    }

    // Poll the job to completion (or the wait deadline) with backoff (task 5.6).
    const status = await this.pollUntilDone(sid);

    // Req 3.5: on DONE, fetch and return the first result page (offset 0,
    // bounded by the effective count).
    if (status.isDone && status.dispatchState === "DONE") {
      const page = await this.fetchResultsPage(sid, count, 0);
      return { kind: "results", sid, page };
    }

    // Req 3.6: a failed dispatch state is a search error carrying Splunk's
    // messages; no partial results are returned.
    if (status.dispatchState === "FAILED") {
      throw new SearchError(
        status.messages.length > 0
          ? status.messages
          : [
              {
                type: "ERROR",
                text: `Search job ${sid} entered a FAILED dispatch state.`,
              },
            ],
      );
    }

    // Req 3.7: not done at the deadline — hand back a job handle with the SID
    // and last observed status so the agent can poll later. (The MCP layer,
    // task 6.3, maps this outcome to a retryable timeout.)
    return { kind: "job", sid, status };
  }

  /**
   * Issue a state-changing POST through the authenticated page, driving a
   * re-login and a single retry when the session has expired (task 5.5).
   *
   * Mirrors the design's `postWithSessionGuard` pseudocode and Requirements
   * 10.5–10.7:
   * 1. Send the request via {@link SessionManager.fetchJson}.
   * 2. If the response is classified as a login redirect or returns HTTP 401,
   *    drive {@link SessionManager.promptLogin} and re-issue the SAME request
   *    exactly once (Req 10.5).
   * 3. If the re-issued request is still a login redirect / 401, raise a
   *    {@link SessionExpiredError} and do NOT retry again (Req 10.7).
   * 4. Otherwise, if the (retried) response is not OK, map it onto the typed
   *    error taxonomy (see {@link mapHttpError}); on success return it (Req 10.6).
   *
   * @param req - A state-changing REST request (method is forced to the request's
   *   own method; callers pass `POST`/`DELETE`).
   * @returns The OK {@link RawRestResponse} of the original or retried request.
   * @throws {@link SessionExpiredError} when re-login does not restore the
   *   session (Req 10.7).
   * @throws {@link PermissionError} / {@link ThrottledError} / {@link SearchError}
   *   per {@link mapHttpError} for a non-2xx response.
   */
  private async postWithSessionGuard(
    req: RawRestRequest,
  ): Promise<RawRestResponse> {
    let resp = await this.session.fetchJson(req);

    if (resp.isLoginRedirect || resp.status === 401) {
      // Req 10.5: expired session — drive the login flow and retry ONCE.
      await this.session.promptLogin();
      resp = await this.session.fetchJson(req);

      // Req 10.7: still expired after the single retry — surface and stop.
      if (resp.isLoginRedirect || resp.status === 401) {
        throw new SessionExpiredError(
          `Session still invalid after re-login. ${SESSION_EXPIRED_HINT}`,
        );
      }
    }

    // Req 10.6: return the (possibly retried) response when it succeeded;
    // otherwise map the non-2xx status onto the typed taxonomy.
    if (!resp.ok) {
      throw mapHttpError(resp);
    }
    return resp;
  }

  /**
   * Poll an async job's status endpoint until it finishes, fails, or the
   * overall wait deadline is reached (task 5.6). Mirrors the design's "Poll
   * with backoff + overall timeout" pseudocode.
   *
   * Timing (Requirements 3.1–3.4):
   * - The deadline is `now() + config.maxWaitMs`; polling never proceeds past
   *   it (Req 3.4), so the total wait cannot exceed `maxWaitMs`.
   * - The first inter-poll wait is `config.pollIntervalMs`; each subsequent
   *   wait doubles, capped at {@link maxPollDelayMs} (Req 3.2).
   * - Every inter-poll wait is additionally clamped so it never extends beyond
   *   the deadline (Req 3.3): `sleep(min(delay, deadline - now()))`.
   *
   * Termination (Requirement 3.1): the loop exits as soon as the job reports
   * `isDone` or a terminal `DONE`/`FAILED` dispatch state, or once the deadline
   * is reached — at which point the last observed status is returned so the
   * caller can apply its timeout policy (Req 3.7). Each iteration strictly
   * advances wall-clock time toward the fixed deadline, guaranteeing
   * termination (Poll Termination property).
   *
   * Transport failures (Requirement 3.8): if a status poll fails at the
   * transport/browser-automation layer, a {@link TransportError} identifying
   * the SID is raised and no results are returned. A {@link TransportError}
   * thrown by the underlying fetch is re-tagged with the SID; any other
   * unexpected throwable is wrapped as a transport failure for the SID.
   *
   * @param sid - The SID of a created async job.
   * @returns The terminal (DONE/FAILED) or last-observed (timeout) status.
   * @throws {@link TransportError} identifying the SID when a poll fails at the
   *   transport layer (Req 3.8).
   */
  private async pollUntilDone(sid: string): Promise<JobStatus> {
    const deadline = this.now() + this.config.maxWaitMs;
    let delay = this.config.pollIntervalMs;
    const path = `services/search/v2/jobs/${encodeURIComponent(sid)}?output_mode=json`;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let resp: RawRestResponse;
      try {
        resp = await this.session.fetchJson({ method: "GET", path });
      } catch (error) {
        // Req 3.8: a poll status transport failure surfaces as a TransportError
        // identifying the SID; no results are returned.
        if (error instanceof TransportError) {
          throw new TransportError(
            `Status poll failed for search job ${sid}: ${error.message}`,
            sid,
          );
        }
        throw new TransportError(
          `Status poll failed for search job ${sid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          sid,
        );
      }

      const status = parseJobStatus(resp.json, sid);

      // Req 3.1: stop once the job is done or reached a terminal dispatch state.
      if (
        status.isDone ||
        status.dispatchState === "DONE" ||
        status.dispatchState === "FAILED"
      ) {
        return status;
      }

      // Req 3.4: terminate at the deadline, returning the last observed status
      // for the caller's timeout policy (Req 3.7).
      if (this.now() >= deadline) {
        return status;
      }

      // Req 3.3: never sleep past the deadline. Req 3.2: exponential backoff,
      // capped at maxPollDelayMs.
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return status;
      }
      await this.sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, this.maxPollDelayMs);
    }
  }

  /**
   * Fetch a single page of results for a completed job and normalize it into a
   * {@link ResultPage}. Shared by the async completion path (task 5.6) and,
   * later, the public {@link results} method (task 5.8) so the GET/normalize
   * logic lives in one place.
   *
   * Issues `GET services/search/v2/jobs/<sid>/results?output_mode=json&count&offset`
   * and normalizes the body via {@link normalize} (offset 0 for the first page,
   * bounded by `count`). A poll/results transport failure surfaces as a
   * {@link TransportError} identifying the SID (Req 3.8).
   *
   * @param sid - The completed job's SID.
   * @param count - The maximum rows to include (already clamped by the caller).
   * @param offset - The zero-based offset into the result set.
   * @returns The normalized {@link ResultPage}.
   * @throws {@link TransportError} identifying the SID on a transport failure.
   */
  private async fetchResultsPage(
    sid: string,
    count: number,
    offset: number,
  ): Promise<ResultPage> {
    const path =
      `services/search/v2/jobs/${encodeURIComponent(sid)}/results` +
      `?output_mode=json&count=${encodeURIComponent(String(count))}` +
      `&offset=${encodeURIComponent(String(offset))}`;
    let resp: RawRestResponse;
    try {
      resp = await this.session.fetchJson({ method: "GET", path });
    } catch (error) {
      if (error instanceof TransportError) {
        throw new TransportError(
          `Fetching results failed for search job ${sid}: ${error.message}`,
          sid,
        );
      }
      throw new TransportError(
        `Fetching results failed for search job ${sid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        sid,
      );
    }
    return normalize(resp.json, count, offset);
  }

  /**
   * Inspect the status of an async job by SID (task 5.8).
   *
   * Behavior, per Requirement 4:
   * 1. Trim the SID; an empty-after-trim SID is rejected with a
   *    {@link ValidationError} and no request is issued (Req 4.3).
   * 2. Issue `GET services/search/v2/jobs/<sid>?output_mode=json` via the
   *    read-only in-page fetch. A status GET is not state-changing, so it does
   *    not go through {@link postWithSessionGuard}; but a login-redirect still
   *    surfaces a {@link SessionExpiredError} rather than a misleading parse
   *    (consistent with Req 10/12).
   * 3. An unknown/not-found SID (HTTP 404 or Splunk "unknown sid" messages) is a
   *    {@link SearchError} carrying the Splunk messages, and no status is
   *    returned (Req 4.4).
   * 4. Otherwise parse the body into a {@link JobStatus} (Req 4.1: dispatch
   *    state, done flag, `doneProgress` clamped to [0,1]; Req 4.2: messages
   *    mirrored, empty list when absent).
   *
   * @param sid - The job SID to inspect.
   * @returns The parsed {@link JobStatus}.
   * @throws {@link ValidationError} when `sid` is empty after trimming (Req 4.3).
   * @throws {@link SessionExpiredError} when the response is a login redirect.
   * @throws {@link SearchError} when Splunk does not recognize the SID (Req 4.4).
   */
  async status(sid: string): Promise<JobStatus> {
    // Req 4.3: reject an empty-after-trim SID without issuing a request.
    const trimmed = (sid ?? "").trim();
    if (trimmed.length === 0) {
      throw new ValidationError(
        "Job SID must be a non-empty string.",
        "sid",
        sid,
      );
    }

    const path = `services/search/v2/jobs/${encodeURIComponent(trimmed)}?output_mode=json`;
    const resp = await this.session.fetchJson({ method: "GET", path });

    // A login redirect on a read-only probe is an expired session.
    if (resp.isLoginRedirect || resp.status === 401) {
      throw new SessionExpiredError(
        `Session expired while checking status for search job ${trimmed}. ${SESSION_EXPIRED_HINT}`,
      );
    }

    // Req 4.4: an unknown/not-found SID is a SearchError carrying Splunk's
    // messages; no status is returned.
    if (!resp.ok && looksUnknownSid(resp)) {
      throw unknownSidError(resp, trimmed);
    }
    // Any other non-2xx is still a failure we surface via the taxonomy.
    if (!resp.ok) {
      throw mapHttpError(resp);
    }

    // Req 4.1 / 4.2: parse dispatch state, done flag, progress, and messages.
    return parseJobStatus(resp.json, trimmed);
  }

  /**
   * Fetch a page of results for a completed job (task 5.8).
   *
   * Behavior, per Requirement 5:
   * 1. Trim the SID; an empty-after-trim SID is rejected with a
   *    {@link ValidationError} and no request is issued.
   * 2. A `count` below 0 or an `offset` below 0 is rejected with a
   *    {@link ValidationError} and no request is issued (Req 5.5). A `count` of
   *    0 is allowed and yields a zero-row page.
   * 3. The effective count is clamped to at most {@link HARD_RESULT_CEILING}
   *    (Req 5.4) before the request is issued.
   * 4. Delegates to {@link fetchResultsPage}, which issues
   *    `GET services/search/v2/jobs/<sid>/results?output_mode=json&count&offset`
   *    and normalizes the body: at most `count` rows (Req 5.2), `initOffset`
   *    from Splunk's reported offset (Req 5.3), and a zero-row page when the
   *    offset is at or beyond the available rows (Req 5.6, which Splunk reports
   *    as an empty `results[]` that {@link normalize} passes through).
   * 5. Returns the {@link ResultPage} (Req 5.1).
   *
   * A login redirect surfaces a {@link SessionExpiredError} and an unknown SID a
   * {@link SearchError}, consistent with {@link status}.
   *
   * @param sid - The completed job's SID.
   * @param page - The requested `count` and `offset`.
   * @returns The normalized {@link ResultPage}.
   * @throws {@link ValidationError} for an empty SID or a negative count/offset
   *   (Req 5.5).
   * @throws {@link SessionExpiredError} when the response is a login redirect.
   * @throws {@link SearchError} when Splunk does not recognize the SID.
   */
  async results(sid: string, page: PageArgs): Promise<ResultPage> {
    // Reject an empty-after-trim SID without issuing a request.
    const trimmed = (sid ?? "").trim();
    if (trimmed.length === 0) {
      throw new ValidationError(
        "Job SID must be a non-empty string.",
        "sid",
        sid,
      );
    }

    // Req 5.5: a count below 0 or an offset below 0 is rejected before any
    // request. (A count of 0 is valid and yields a zero-row page.)
    if (
      typeof page.count !== "number" ||
      !Number.isInteger(page.count) ||
      page.count < 0
    ) {
      throw new ValidationError(
        "Result count must be an integer >= 0.",
        "count",
        page.count,
      );
    }
    if (
      typeof page.offset !== "number" ||
      !Number.isInteger(page.offset) ||
      page.offset < 0
    ) {
      throw new ValidationError(
        "Result offset must be an integer >= 0.",
        "offset",
        page.offset,
      );
    }

    // Req 5.4: clamp the count to the hard ceiling before issuing the request.
    const count = clamp(page.count, 0, HARD_RESULT_CEILING);

    const path =
      `services/search/v2/jobs/${encodeURIComponent(trimmed)}/results` +
      `?output_mode=json&count=${encodeURIComponent(String(count))}` +
      `&offset=${encodeURIComponent(String(page.offset))}`;
    let resp: RawRestResponse;
    try {
      resp = await this.session.fetchJson({ method: "GET", path });
    } catch (error) {
      // A transport failure while fetching results is surfaced identifying the
      // SID (consistent with the poll/results transport handling in task 5.6).
      if (error instanceof TransportError) {
        throw new TransportError(
          `Fetching results failed for search job ${trimmed}: ${error.message}`,
          trimmed,
        );
      }
      throw new TransportError(
        `Fetching results failed for search job ${trimmed}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        trimmed,
      );
    }

    // A login redirect on the read-only results GET is an expired session.
    if (resp.isLoginRedirect || resp.status === 401) {
      throw new SessionExpiredError(
        `Session expired while fetching results for search job ${trimmed}. ${SESSION_EXPIRED_HINT}`,
      );
    }

    // An unknown/not-found SID is a SearchError carrying Splunk's messages.
    if (!resp.ok && looksUnknownSid(resp)) {
      throw unknownSidError(resp, trimmed);
    }
    if (!resp.ok) {
      throw mapHttpError(resp);
    }

    // Req 5.1/5.2/5.3/5.6: normalize the page (at most `count` rows, initOffset
    // from Splunk, zero rows when offset is past the end).
    return normalize(resp.json, count, page.offset);
  }

  /**
   * Cancel a running job by SID (task 5.8).
   *
   * Behavior, per Requirement 6:
   * 1. Trim the SID; an empty-after-trim SID is rejected with a
   *    {@link ValidationError} and no request is issued (Req 6.2).
   * 2. Issue `DELETE services/search/v2/jobs/<sid>` through
   *    {@link postWithSessionGuard}. A DELETE is state-changing, so it needs the
   *    CSRF header and the session guard's single re-login-and-retry.
   * 3. When Splunk accepts the cancellation (2xx), return a {@link CancelResult}
   *    whose outcome is exactly `SUCCESS` (Req 6.1).
   * 4. When Splunk does not recognize the SID or rejects the cancellation,
   *    return a {@link CancelResult} whose outcome is `FAILURE`, carrying the
   *    Splunk-reported messages (Req 6.3). This is returned as an *outcome*, not
   *    thrown, because an unknown/rejected SID is a normal cancel result the
   *    caller inspects.
   *
   * Note: {@link postWithSessionGuard} raises typed errors for a non-2xx
   * response (e.g. {@link SearchError} on an unknown SID, or
   * {@link PermissionError}/{@link ThrottledError}). Per Req 6.3 those are
   * translated back into a `FAILURE` outcome carrying the messages so the caller
   * receives a cancellation outcome rather than an exception. A
   * {@link SessionExpiredError} is allowed to propagate, since that is a session
   * condition rather than a cancel-rejection.
   *
   * @param sid - The job SID to cancel.
   * @returns A {@link CancelResult}: `SUCCESS` on acceptance, else `FAILURE`
   *   carrying Splunk's messages.
   * @throws {@link ValidationError} when `sid` is empty after trimming (Req 6.2).
   * @throws {@link SessionExpiredError} when re-login does not restore the
   *   session.
   */
  async cancelJob(sid: string): Promise<CancelResult> {
    // Req 6.2: reject an empty-after-trim SID without issuing a request.
    const trimmed = (sid ?? "").trim();
    if (trimmed.length === 0) {
      throw new ValidationError(
        "Job SID must be a non-empty string.",
        "sid",
        sid,
      );
    }

    const path = `services/search/v2/jobs/${encodeURIComponent(trimmed)}`;
    try {
      await this.postWithSessionGuard({ method: "DELETE", path });
    } catch (error) {
      // A session expiry is a session condition, not a cancel rejection: let it
      // propagate so the caller can drive re-auth.
      if (error instanceof SessionExpiredError) {
        throw error;
      }
      // Req 6.3: an unknown SID or a rejected cancellation is a FAILURE outcome
      // carrying the Splunk-reported messages, not a thrown error.
      if (error instanceof SearchError) {
        return { outcome: "FAILURE", messages: error.messages };
      }
      if (error instanceof PermissionError || error instanceof ThrottledError) {
        return {
          outcome: "FAILURE",
          messages: [{ type: "ERROR", text: error.message }],
        };
      }
      throw error;
    }

    // Req 6.1: Splunk accepted the cancellation.
    return { outcome: "SUCCESS" };
  }
}
