/**
 * Redaction-aware logger for the Splunk MCP Server.
 *
 * The server drives an authenticated browser session, so any log record could
 * accidentally capture sensitive material: the `HttpOnly` Session_Cookie
 * (`splunkd_8443`), the readable CSRF_Token (`splunkweb_csrf_token_8443`), or a
 * full result payload. This module centralizes logging so those values are
 * stripped before anything is written — at every level, including verbose mode.
 *
 * All output is written to `stderr`. `stdout` is reserved for the MCP stdio
 * transport (Requirement 17.5), so logging must never touch it.
 *
 * Requirements:
 * - 15.2: Exclude the Session_Cookie value from all log output at every level.
 * - 15.3: Exclude the Session_Cookie value from persisted state written outside
 *   the User_Data_Dir (this logger never persists secrets to such state).
 * - 15.4: Even with verbose logging enabled, exclude the CSRF_Token value and
 *   full result payloads from log output.
 * - 15.5: Redact any secret value (Session_Cookie or CSRF_Token) that would
 *   otherwise be emitted in a log or error record before the record is written.
 */

/** Severity levels in increasing verbosity. */
export type LogLevel = "error" | "warn" | "info" | "debug" | "verbose";

/** Placeholder written in place of any redacted secret value. */
export const REDACTED = "[REDACTED]";

/** Placeholder written in place of an omitted full result payload. */
export const REDACTED_PAYLOAD = "[REDACTED_PAYLOAD]";

/**
 * Cookie names whose values must never appear in log output. Both the
 * `HttpOnly` session cookie and the CSRF token are covered (Requirements 15.2,
 * 15.4, 15.5).
 */
const SECRET_COOKIE_NAMES = [
  "splunkd_8443",
  "splunkweb_csrf_token_8443",
] as const;

/**
 * Header names whose values may carry the CSRF token and must be redacted.
 */
const SECRET_HEADER_NAMES = ["x-splunk-form-key"] as const;

/**
 * Object keys that commonly carry secrets or full payloads. Matched
 * case-insensitively against structured log fields.
 */
const SECRET_KEY_PATTERNS = [
  /cookie/i,
  /csrf/i,
  /form[-_]?key/i,
  /session[-_]?cookie/i,
  /token/i,
];

/**
 * Keys whose values are full result payloads that must be excluded from logs
 * (Requirement 15.4), matched case-insensitively.
 */
const PAYLOAD_KEY_PATTERNS = [/^results$/i, /^rows$/i, /payload/i, /^raw$/i];

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  verbose: 4,
};

/**
 * Redact secret substrings from a free-text string. This catches cases where a
 * cookie header or token has been serialized into a message (e.g.
 * `Cookie: splunkd_8443=abcdef...`) even when it is not a discrete field.
 *
 * @param input - The text to sanitize.
 * @returns The text with any secret cookie/header values replaced.
 */
export function redactString(input: string): string {
  let out = input;
  for (const name of SECRET_COOKIE_NAMES) {
    // Replace `name=<value>` where value runs until `;`, whitespace, or quote.
    const pattern = new RegExp(
      `(${escapeRegExp(name)}\\s*=\\s*)[^;,\\s"']+`,
      "gi",
    );
    out = out.replace(pattern, `$1${REDACTED}`);
  }
  for (const header of SECRET_HEADER_NAMES) {
    // Replace `Header: <value>` and `"Header": "<value>"` forms.
    const pattern = new RegExp(
      `(${escapeRegExp(header)}\\s*[:=]\\s*"?)[^",;\\s]+`,
      "gi",
    );
    out = out.replace(pattern, `$1${REDACTED}`);
  }
  return out;
}

/**
 * Recursively redact a value intended for structured logging. Secret-bearing
 * keys are replaced with {@link REDACTED}; full-payload keys are replaced with
 * {@link REDACTED_PAYLOAD}; strings are scrubbed via {@link redactString}.
 *
 * A visited set guards against cyclic references. Depth is bounded so a
 * pathological structure cannot cause unbounded recursion.
 *
 * @param value - The value to sanitize.
 * @returns A sanitized copy safe to serialize into a log record.
 */
export function redactValue(value: unknown): unknown {
  return redactValueInternal(value, new WeakSet(), 0);
}

function redactValueInternal(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }
  if (depth >= 8) {
    return "[TRUNCATED]";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    return value.map((item) => redactValueInternal(item, seen, depth + 1));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isPayloadKey(key)) {
        out[key] = REDACTED_PAYLOAD;
      } else if (isSecretKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValueInternal(entry, seen, depth + 1);
      }
    }
    return out;
  }
  // Functions, symbols, etc. — never log their content.
  return `[${typeof value}]`;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

function isPayloadKey(key: string): boolean {
  return PAYLOAD_KEY_PATTERNS.some((re) => re.test(key));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A structured record of extra context to attach to a log line. */
export type LogContext = Record<string, unknown>;

/** Options controlling logger behavior. */
export interface LoggerOptions {
  /** Minimum level to emit; more verbose levels are dropped. Default `info`. */
  level?: LogLevel;
  /** Sink for formatted lines. Defaults to writing to `stderr`. */
  sink?: (line: string) => void;
}

/**
 * A minimal, dependency-free logger that redacts secrets and payloads before
 * writing. Every method accepts an optional structured context object which is
 * sanitized recursively.
 */
export class Logger {
  private readonly threshold: number;
  private readonly sink: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    const level = options.level ?? "info";
    this.threshold = LEVEL_ORDER[level];
    this.sink =
      options.sink ??
      ((line: string) => {
        process.stderr.write(`${line}\n`);
      });
  }

  /** Whether records at `level` would be emitted given the current threshold. */
  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] <= this.threshold;
  }

  error(message: string, context?: LogContext): void {
    this.emit("error", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, context);
  }

  /** Most verbose level; still redacts secrets and payloads (Req 15.4). */
  verbose(message: string, context?: LogContext): void {
    this.emit("verbose", message, context);
  }

  private emit(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.isEnabled(level)) {
      return;
    }
    const safeMessage = redactString(message);
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: safeMessage,
    };
    if (context && Object.keys(context).length > 0) {
      const safeContext = redactValue(context) as Record<string, unknown>;
      for (const [key, value] of Object.entries(safeContext)) {
        // Avoid clobbering the reserved fields.
        if (key === "ts" || key === "level" || key === "msg") {
          record[`ctx_${key}`] = value;
        } else {
          record[key] = value;
        }
      }
    }
    this.sink(safeJsonStringify(record));
  }
}

/**
 * Serialize a log record to JSON, degrading gracefully if serialization throws
 * (e.g. an exotic BigInt slipped through). Never throws.
 */
function safeJsonStringify(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "log serialization failed",
    });
  }
}

/**
 * Process-wide default logger. Its verbosity honors `SPLUNK_LOG_LEVEL` when set
 * to a recognized level; otherwise it defaults to `info`.
 */
export const logger = new Logger({
  level: parseLevel(process.env["SPLUNK_LOG_LEVEL"]),
});

function parseLevel(raw: string | undefined): LogLevel {
  switch ((raw ?? "").toLowerCase()) {
    case "error":
      return "error";
    case "warn":
      return "warn";
    case "info":
      return "info";
    case "debug":
      return "debug";
    case "verbose":
      return "verbose";
    default:
      return "info";
  }
}
