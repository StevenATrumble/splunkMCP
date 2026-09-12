/**
 * MCP Tool Router for the Splunk MCP Server (task 6.1).
 *
 * Registers the six agent-facing tools from the design's "Component 1: MCP
 * Server / Tool Router" onto an {@link McpServer} instance, declares their
 * argument schemas + descriptions, validates/normalizes inputs, and dispatches
 * each call to the {@link SplunkClient}.
 *
 * The six tools mirror the design's `ToolName` union:
 * - `splunk_search`        — run an SPL search (oneshot/async/auto).
 * - `splunk_search_status` — inspect an async job by SID.
 * - `splunk_results`       — page results for a completed job.
 * - `splunk_cancel_job`    — cancel a running job by SID.
 * - `splunk_whoami`        — current identity + session health.
 * - `splunk_server_info`   — Splunk version + build.
 *
 * Requirements:
 * - 1.1: a non-empty query is executed and normalized results returned.
 * - 1.2: an empty-after-trim query is rejected without executing a search.
 * - 1.7: a `maxResults` that is not a positive integer is rejected.
 * - 4.3: an empty-after-trim SID is rejected without a status request.
 * - 5.5: a negative `count`/`offset` is rejected without a results request.
 * - 6.2: an empty-after-trim SID is rejected without a cancel request.
 *
 * Input validation is enforced at the schema level (via zod) wherever a rule is
 * expressible there — a non-empty query, a positive-integer `maxResults`, a
 * non-empty SID, and non-negative `count`/`offset` — so malformed arguments are
 * rejected by the MCP layer before any dispatch. The {@link SplunkClient}
 * repeats these checks defensively (it is the authority for the acceptance
 * criteria), so the two layers agree.
 *
 * Error-taxonomy mapping (task 6.3): every handler's `catch` routes the thrown
 * value through {@link mapErrorToResult}, which inspects the typed error from
 * `errors.ts` and produces a structured `isError` {@link CallToolResult} whose
 * JSON payload carries a stable `errorType` category, the message, a
 * `retryable` flag (read from the error's own `retryable` property), and any
 * error-specific detail (SearchError messages, TimeoutError sid/lastStatus,
 * ValidationError field/value). The success path is likewise taxonomy-aware:
 * `splunk_search`/`splunk_results` present a DONE-with-zero-rows page as an
 * informational NON-error (Req 14.3) and an async-timeout job handle as a
 * clearly-labeled pending/timeout NON-error result carrying the SID (Req 14.5).
 *
 * Precedence (Req 14.7): permission > throttled > search. The
 * {@link SplunkClient} already classifies a single HTTP response into the right
 * typed error before it reaches this layer (403 → PermissionError, 429 →
 * ThrottledError, else → SearchError via `mapHttpError`), so the precedence is
 * reflected simply by preserving the thrown type. {@link classifyError} still
 * checks `PermissionError` before `ThrottledError` before `SearchError` so the
 * ordering is explicit and robust even if a future caller could throw an
 * ambiguous subtype.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  isSplunkMcpError,
  PermissionError,
  SearchError,
  SessionExpiredError,
  ThrottledError,
  TimeoutError,
  TransportError,
  ValidationError,
} from "./errors.js";
import type { SplunkClient } from "./splunk-client.js";
import { HARD_RESULT_CEILING } from "./splunk-client.js";
import type { ResultPage, SearchArgs, SearchOutcome } from "./types.js";

/**
 * The server implementation metadata advertised to MCP clients. Kept in one
 * place so the entrypoint (task 6.2) and any tests build an identically-named
 * server.
 */
export const SERVER_INFO = {
  name: "splunk-mcp-server",
  version: "0.1.0",
} as const;

/**
 * A non-empty string schema that trims surrounding whitespace first, so a
 * whitespace-only value is rejected (Requirements 1.2, 4.3, 6.2). The trimmed
 * value is what the handler forwards to the {@link SplunkClient}.
 */
const nonEmptyTrimmed = (label: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, {
      message: `${label} must be a non-empty string.`,
    });

/**
 * Raw zod shape for `splunk_search` arguments. `query` is required and must be
 * non-empty after trimming (Req 1.2); `maxResults`, when present, must be a
 * positive integer (Req 1.7). `earliest`/`latest` pass through verbatim (no
 * local time parsing); the {@link SplunkClient} applies configured defaults for
 * any omitted field (Req 1.3–1.6).
 */
const searchShape = {
  query: nonEmptyTrimmed("query").describe(
    "The SPL query to run. A leading `search ` is optional and normalized " +
      "automatically. Must be non-empty.",
  ),
  earliest: z
    .string()
    .optional()
    .describe(
      "Splunk earliest_time modifier (e.g. `-15m`, `-1h`, `-7d@d`, `0`). " +
        "Passed through verbatim. Defaults to the server's configured " +
        "earliest when omitted.",
    ),
  latest: z
    .string()
    .optional()
    .describe(
      "Splunk latest_time modifier (e.g. `now`). Passed through verbatim. " +
        "Defaults to the server's configured latest when omitted.",
    ),
  maxResults: z
    .number()
    .int({ message: "maxResults must be a positive integer (>= 1)." })
    .positive({ message: "maxResults must be a positive integer (>= 1)." })
    .optional()
    .describe(
      `Maximum rows to return (>= 1). Clamped to a hard ceiling of ` +
        `${HARD_RESULT_CEILING}. Defaults to the server's configured count ` +
        "when omitted.",
    ),
  mode: z
    .enum(["auto", "oneshot", "async"])
    .optional()
    .describe(
      "Execution mode. `oneshot` returns results inline; `async` creates a " +
        "polled job; `auto` (default) picks one, favoring oneshot for quick " +
        "bounded lookups and async for long-running searches.",
    ),
};

/** Raw zod shape for the SID-only tools (`status`, `cancel_job`). */
const sidShape = {
  sid: nonEmptyTrimmed("sid").describe(
    "The search job identifier (SID) returned by a prior async search. " +
      "Must be non-empty.",
  ),
};

/**
 * The default page size applied by `splunk_results` when the caller omits
 * `count`. A sensible, bounded default that keeps a single page small; callers
 * page further with `offset`.
 */
const DEFAULT_RESULTS_COUNT = 100;

/**
 * Raw zod shape for `splunk_results`. `count`/`offset` are optional; when
 * present they must be non-negative integers (Req 5.5). A count of 0 is valid
 * and yields a zero-row page; the {@link SplunkClient} clamps a large count to
 * the hard ceiling and defaults an omitted offset to 0.
 */
const resultsShape = {
  sid: nonEmptyTrimmed("sid").describe(
    "The SID of a completed (or in-progress) search job to page results from. " +
      "Must be non-empty.",
  ),
  count: z
    .number()
    .int({ message: "count must be an integer >= 0." })
    .min(0, { message: "count must be an integer >= 0." })
    .optional()
    .describe(
      `Maximum rows to return in this page (>= 0). Clamped to a hard ceiling ` +
        `of ${HARD_RESULT_CEILING}. Defaults to ${DEFAULT_RESULTS_COUNT} ` +
        "when omitted.",
    ),
  offset: z
    .number()
    .int({ message: "offset must be an integer >= 0." })
    .min(0, { message: "offset must be an integer >= 0." })
    .optional()
    .describe(
      "Zero-based offset into the job's result set (>= 0). Defaults to 0 " +
        "when omitted. An offset at or beyond the available rows yields a " +
        "zero-row page.",
    ),
};

/**
 * The stable set of agent-facing error categories emitted on the `errorType`
 * field of a failure payload. These mirror the design's error taxonomy so the
 * agent can branch on a small, closed vocabulary rather than parsing prose.
 */
export type ErrorType =
  | "session_expired"
  | "search_error"
  | "permission"
  | "throttled"
  | "timeout"
  | "transport"
  | "validation"
  | "unknown";

/**
 * The structured shape carried in the JSON text of an `isError` tool result.
 * `retryable` is copied from the typed error's own flag so the agent can decide
 * whether re-attempting is worthwhile without re-deriving it from `errorType`.
 */
interface ErrorPayload {
  /** Discriminant category from the closed {@link ErrorType} vocabulary. */
  errorType: ErrorType;
  /** Human-readable message (the error's `message`). */
  message: string;
  /** Whether re-attempting the operation could plausibly succeed. */
  retryable: boolean;
  /** Splunk messages carried by a {@link SearchError} (Req 14.1). */
  messages?: SearchError["messages"];
  /** The SID of the timed-out/affected job (TimeoutError / TransportError). */
  sid?: string;
  /** The last observed job status at an async timeout (Req 14.5). */
  lastStatus?: TimeoutError["lastStatus"];
  /** The field that failed validation, when applicable. */
  field?: string;
  /** The caller's offending input, preserved for echoing back. */
  value?: unknown;
}

/**
 * Serialize a successful tool result into the MCP text-content shape. The full
 * value is JSON-encoded so the agent receives the complete normalized outcome
 * (results page, job status, identity, etc.).
 *
 * @param value - The value returned by the dispatched {@link SplunkClient} call.
 * @returns A successful {@link CallToolResult} carrying the JSON text.
 */
function ok(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

/**
 * Classify a thrown value into its {@link ErrorType} category, enforcing the
 * Req 14.7 precedence explicitly: permission before throttled before search
 * error. The remaining typed errors map one-to-one; anything that is not a
 * known `SplunkMcpError` falls through to `"unknown"`.
 *
 * Ordering matters only for the precedence trio (permission → throttled →
 * search); the `instanceof` checks are arranged so that if a value ever
 * satisfied more than one of those (it cannot with the current disjoint
 * hierarchy, but a future subtype might), the higher-precedence category wins.
 *
 * @param error - The thrown value (any type).
 * @returns The matching {@link ErrorType}.
 */
function classifyError(error: unknown): ErrorType {
  // Precedence trio first (Req 14.7): permission > throttled > search.
  if (error instanceof PermissionError) return "permission";
  if (error instanceof ThrottledError) return "throttled";
  if (error instanceof SearchError) return "search_error";
  // Remaining typed errors.
  if (error instanceof SessionExpiredError) return "session_expired";
  if (error instanceof TimeoutError) return "timeout";
  if (error instanceof TransportError) return "transport";
  if (error instanceof ValidationError) return "validation";
  return "unknown";
}

/**
 * Map a thrown value onto a structured `isError` {@link CallToolResult}
 * implementing the agent-facing error taxonomy (Req 14.1, 14.2, 14.4, 14.5,
 * 14.6, 14.7).
 *
 * The payload always carries an `errorType` (see {@link classifyError}), the
 * `message`, and a `retryable` flag taken from the typed error's own property
 * (so `SearchError`/`PermissionError`/`ValidationError` are `false`;
 * `ThrottledError`/`TimeoutError`/`TransportError`/`SessionExpiredError` are
 * `true`). Error-specific detail is attached when present: `SearchError`
 * contributes its `messages[]` (the concatenated text is already the
 * `message`); `TimeoutError` contributes `sid`/`lastStatus`; `TransportError`
 * contributes `sid` when it references a job; `ValidationError` contributes
 * `field`/`value`.
 *
 * Non-`SplunkMcpError` throwables are surfaced as a non-retryable `"unknown"`
 * category so the agent still receives a structured, closed-vocabulary result.
 *
 * @param error - The thrown value (any type).
 * @returns An `isError` {@link CallToolResult} carrying the JSON payload.
 */
function mapErrorToResult(error: unknown): CallToolResult {
  const errorType = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);
  // Retryability is authoritative on the typed error; unknown throwables are
  // treated as non-retryable.
  const retryable = isSplunkMcpError(error) ? error.retryable : false;

  const payload: ErrorPayload = { errorType, message, retryable };

  // Attach error-specific detail so the agent can react precisely.
  if (error instanceof SearchError) {
    payload.messages = error.messages; // Req 14.1: concatenated text + raw messages.
  } else if (error instanceof TimeoutError) {
    payload.sid = error.sid; // Req 14.5: poll later by SID.
    if (error.lastStatus !== undefined) payload.lastStatus = error.lastStatus;
  } else if (error instanceof TransportError) {
    if (error.sid !== undefined) payload.sid = error.sid; // Req 14.6.
  } else if (error instanceof ValidationError) {
    if (error.field !== undefined) payload.field = error.field;
    if (error.value !== undefined) payload.value = error.value;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

/**
 * Present a {@link SearchOutcome} from {@link SplunkClient.search} as a
 * successful (NON-error) tool result, applying the two taxonomy success cases:
 *
 * - Req 14.5 (async timeout): a `{kind:"job"}` outcome means the async job did
 *   not finish before the wait deadline and is still running. It is a valid,
 *   retryable-by-polling outcome — NOT an error. We surface it as
 *   `{status:"pending", sid, jobStatus, retryable:true, note:...}` so the agent
 *   knows to poll `splunk_search_status` / `splunk_results` by SID.
 * - Req 14.3 (DONE with zero rows): a `{kind:"results"}` outcome whose page has
 *   no rows is a successful search that simply matched nothing — NOT an error.
 *   We return the empty page annotated with an informational note (see
 *   {@link resultsPageResult}).
 *
 * @param outcome - The outcome returned by `client.search`.
 * @returns A successful {@link CallToolResult}.
 */
function searchOutcomeResult(outcome: SearchOutcome): CallToolResult {
  if (outcome.kind === "job") {
    // Req 14.5: timed out but still running — a pending job handle, retryable
    // by polling. This is a valid outcome, not an isError.
    return ok({
      status: "pending",
      sid: outcome.sid,
      jobStatus: outcome.status,
      retryable: true,
      note:
        "The search is still running and did not finish within the wait " +
        "limit. Poll it later by SID with `splunk_search_status`, then read " +
        "results with `splunk_results`.",
    });
  }
  // kind === "results": completed inline/async — annotate a zero-row page.
  return resultsPageResult(outcome.page, outcome.sid);
}

/**
 * Present a {@link ResultPage} as a successful (NON-error) tool result,
 * annotating a DONE-with-zero-rows page with an informational note (Req 14.3):
 * a completed search that returned no rows is an ordinary empty result, not an
 * error, so `isError` stays absent.
 *
 * @param page - The normalized result page.
 * @param sid - The originating job SID, when known (async searches).
 * @returns A successful {@link CallToolResult} carrying the page (plus an
 *   informational note when the page is empty).
 */
function resultsPageResult(page: ResultPage, sid?: string): CallToolResult {
  if (page.rows.length === 0) {
    // Req 14.3: zero rows is informational, not an error.
    return ok({
      ...(sid !== undefined ? { sid } : {}),
      page,
      info:
        "The search completed successfully but returned no results. " +
        "Consider widening the time range or adjusting the query.",
    });
  }
  return ok(sid !== undefined ? { sid, page } : { page });
}

/**
 * Build and configure an {@link McpServer} with the six Splunk tools wired to
 * the given {@link SplunkClient}. The returned server is NOT yet connected to a
 * transport — the entrypoint (task 6.2) constructs the stdio transport and
 * calls `server.connect(...)`.
 *
 * @param client - The {@link SplunkClient} that performs the Splunk REST work.
 * @returns A configured {@link McpServer} with all six tools registered.
 */
export function createToolRouter(client: SplunkClient): McpServer {
  const server = new McpServer(SERVER_INFO);

  // --- splunk_search (Req 1.1, 1.2, 1.7) ---
  server.registerTool(
    "splunk_search",
    {
      title: "Run a Splunk search",
      description:
        "Run an SPL search against Splunk and return normalized results. Use " +
        "this to query data on behalf of the user. Provide the SPL as " +
        "`query` (a leading `search ` is optional). Optionally set a time " +
        "range via `earliest`/`latest` (Splunk time modifiers, passed " +
        "through verbatim), a `maxResults` cap, and a `mode` " +
        "(`auto`/`oneshot`/`async`). In `oneshot`/`auto`-quick mode results " +
        "are returned inline; a long-running `async` search may return a job " +
        "handle with a `sid` you can poll via `splunk_search_status` and " +
        "read via `splunk_results`.",
      inputSchema: searchShape,
    },
    async (args) => {
      try {
        // Forward validated args. `query` is already trimmed non-empty by the
        // schema; earliest/latest/maxResults/mode are optional and defaulted by
        // the client. Only include optional fields when present so the client's
        // config defaults apply (Req 1.3–1.6).
        const searchArgs: SearchArgs = { query: args.query };
        if (args.earliest !== undefined) searchArgs.earliest = args.earliest;
        if (args.latest !== undefined) searchArgs.latest = args.latest;
        if (args.maxResults !== undefined)
          searchArgs.maxResults = args.maxResults;
        if (args.mode !== undefined) searchArgs.mode = args.mode;

        const outcome = await client.search(searchArgs);
        // Req 14.3 / 14.5: present a zero-row page as informational and an
        // async-timeout job handle as a pending (retryable-by-polling) outcome,
        // both as NON-error results.
        return searchOutcomeResult(outcome);
      } catch (error) {
        return mapErrorToResult(error);
      }
    },
  );

  // --- splunk_search_status (Req 4.3) ---
  server.registerTool(
    "splunk_search_status",
    {
      title: "Check a search job's status",
      description:
        "Inspect the status of an asynchronous search job by its `sid`. " +
        "Returns the dispatch state (QUEUED/PARSING/RUNNING/DONE/FAILED), a " +
        "done flag, completion progress (0..1), and any Splunk messages. Use " +
        "this to decide when a job is finished so you can fetch results with " +
        "`splunk_results`.",
      inputSchema: sidShape,
    },
    async (args) => {
      try {
        const status = await client.status(args.sid);
        return ok(status);
      } catch (error) {
        return mapErrorToResult(error);
      }
    },
  );

  // --- splunk_results (Req 5.5) ---
  server.registerTool(
    "splunk_results",
    {
      title: "Fetch results for a search job",
      description:
        "Fetch a page of results for a search job by `sid`. Page through a " +
        "large result set with `count` (rows per page, defaults to " +
        `${DEFAULT_RESULTS_COUNT}, clamped to ${HARD_RESULT_CEILING}) and ` +
        "`offset` (zero-based, defaults to 0). An `offset` at or beyond the " +
        "available rows returns an empty page.",
      inputSchema: resultsShape,
    },
    async (args) => {
      try {
        // Req 5.5 negative rejection is enforced by the schema; apply sensible
        // defaults for omitted paging values (count default, offset 0). The
        // client clamps count to the hard ceiling.
        const count = args.count ?? DEFAULT_RESULTS_COUNT;
        const offset = args.offset ?? 0;
        const page = await client.results(args.sid, { count, offset });
        // Req 14.3: a DONE-with-zero-rows page is informational, not an error.
        return resultsPageResult(page, args.sid);
      } catch (error) {
        return mapErrorToResult(error);
      }
    },
  );

  // --- splunk_cancel_job (Req 6.2) ---
  server.registerTool(
    "splunk_cancel_job",
    {
      title: "Cancel a search job",
      description:
        "Cancel a running search job by `sid` to free Splunk resources when " +
        "its results are no longer needed. Returns a SUCCESS outcome when " +
        "Splunk accepts the cancellation, or a FAILURE outcome carrying " +
        "Splunk's messages when the SID is unknown or the cancellation is " +
        "rejected.",
      inputSchema: sidShape,
    },
    async (args) => {
      try {
        const result = await client.cancelJob(args.sid);
        return ok(result);
      } catch (error) {
        return mapErrorToResult(error);
      }
    },
  );

  // --- splunk_whoami (no args) ---
  server.registerTool(
    "splunk_whoami",
    {
      title: "Show current Splunk identity",
      description:
        "Return the authenticated Splunk identity (username + roles) and " +
        "confirm the browser session is live. Use this to verify who you are " +
        "acting as and whether the session is usable before running searches.",
    },
    async () => {
      try {
        const ctx = await client.whoami();
        return ok(ctx);
      } catch (error) {
        return mapErrorToResult(error);
      }
    },
  );

  // --- splunk_server_info (no args) ---
  server.registerTool(
    "splunk_server_info",
    {
      title: "Show Splunk server info",
      description:
        "Return the Splunk deployment's version and build. Use this to adapt " +
        "behavior to the specific Splunk version you are talking to.",
    },
    async () => {
      try {
        const info = await client.serverInfo();
        return ok(info);
      } catch (error) {
        return mapErrorToResult(error);
      }
    },
  );

  return server;
}
