/**
 * Environment-only configuration loader for the Splunk MCP Server.
 *
 * `loadConfig()` reads exclusively from `process.env` — never from files,
 * command-line arguments, or any other source — and applies the documented
 * defaults from the design's "Component 4: Config" section. Per-user values
 * come from the environment only; there is no hardcoded username and no
 * required per-user configuration beyond what has a default.
 *
 * Requirements:
 * - 13.1: Configuration is environment-only (no files / other sources).
 * - 13.2: Documented defaults applied when a variable is unset.
 * - 13.3: The base URL is validated; an empty/invalid URL refuses startup.
 * - 13.4: Numeric variables are parsed and validated.
 * - 13.5: A missing required variable with no default errors and refuses to start.
 * - 13.7: `SPLUNK_USERNAME` is optional (undefined when unset).
 * - 13.8: No code path references a hardcoded username.
 *
 * The `SPLUNK_CDP_PORT` / `SPLUNK_CDP_HOST` variables configure the loopback
 * remote-debugging endpoint used to attach to an already-running browser on the
 * same profile (single-instance reuse); both apply the same env-only / default
 * rules as every other variable above.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { SplunkMcpError } from "./errors.js";

/**
 * Fully-resolved server configuration. Mirrors the design's `Config`
 * interface. All fields except `username` always have a value after
 * {@link loadConfig} returns (defaults are applied); `username` is optional
 * and is only populated when `SPLUNK_USERNAME` is explicitly set.
 */
export interface Config {
  /** `SPLUNK_BASE_URL`; default `https://hoopp.splunkcloud.com`. */
  baseUrl: string;
  /** `SPLUNK_APP`; default `search`. */
  app: string;
  /** `SPLUNK_USERNAME`; optional override, auto-discovered otherwise. */
  username?: string;
  /** `SPLUNK_DEFAULT_EARLIEST`; default `-15m`. */
  defaultEarliest: string;
  /** `SPLUNK_DEFAULT_LATEST`; default `now`. */
  defaultLatest: string;
  /** `SPLUNK_DEFAULT_COUNT`; default `100`. */
  defaultCount: number;
  /** `SPLUNK_POLL_INTERVAL_MS`; default `750` (base for backoff). */
  pollIntervalMs: number;
  /** `SPLUNK_MAX_WAIT_MS`; default `120000`. */
  maxWaitMs: number;
  /** `SPLUNK_AUTO_ASYNC_THRESHOLD_MS`; default `3000`. */
  autoAsyncThresholdMs: number;
  /** `SPLUNK_USER_DATA_DIR`; default OS-appropriate app dir. */
  userDataDir: string;
  /** `SPLUNK_HEADFUL`; default `true` (login is always headful). */
  headful: boolean;
  /**
   * `SPLUNK_CDP_PORT`; default `9223`. The fixed loopback remote-debugging
   * port the owned browser exposes so later server processes can attach to the
   * already-running instance instead of failing on the profile lock.
   */
  cdpPort: number;
  /**
   * `SPLUNK_CDP_HOST`; default `127.0.0.1`. The host the CDP DevTools endpoint
   * is discovered on. Kept loopback-only by default: a CDP endpoint grants full
   * control of the authenticated browser and must never bind a routable
   * interface.
   */
  cdpHost: string;
}

/**
 * Raised when configuration is invalid or a required value is missing. This
 * condition is not retryable: the process must refuse to start until the
 * environment is corrected. Extends {@link SplunkMcpError} so callers can
 * treat it uniformly with the rest of the error taxonomy.
 *
 * Requirements: 13.3, 13.4, 13.5.
 */
export class ConfigError extends SplunkMcpError {
  /** Configuration problems require operator intervention, not a retry. */
  override readonly retryable = false;

  constructor(message: string) {
    super(message);
  }
}

/** The documented defaults, kept in one place for clarity and testing. */
const DEFAULTS = {
  baseUrl: "https://hoopp.splunkcloud.com",
  app: "search",
  defaultEarliest: "-15m",
  defaultLatest: "now",
  defaultCount: 100,
  pollIntervalMs: 750,
  maxWaitMs: 120000,
  autoAsyncThresholdMs: 3000,
  headful: true,
  cdpPort: 9223,
  cdpHost: "127.0.0.1",
} as const;

/** Environment source shape; injectable so tests need not mutate the global. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Read a raw environment value, trimming surrounding whitespace and treating
 * an empty/whitespace-only string as absent (so it falls back to a default).
 */
function readOptional(env: EnvSource, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read a string value, applying `fallback` when the variable is unset. */
function readString(env: EnvSource, key: string, fallback: string): string {
  return readOptional(env, key) ?? fallback;
}

/**
 * Read a positive-integer value, applying `fallback` when unset. Throws a
 * {@link ConfigError} when the value is present but not a positive integer.
 *
 * Requirement 13.4: numeric variables are validated, not silently coerced.
 */
function readPositiveInt(
  env: EnvSource,
  key: string,
  fallback: number,
): number {
  const raw = readOptional(env, key);
  if (raw === undefined) {
    return fallback;
  }
  // Accept only a clean base-10 integer (no trailing units, floats, etc.).
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(
      `${key} must be a positive integer; received "${raw}".`,
    );
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(
      `${key} must be a positive integer; received "${raw}".`,
    );
  }
  return value;
}

/**
 * Read a boolean value, applying `fallback` when unset. Accepts the common
 * truthy/falsey spellings case-insensitively; anything else is an error.
 */
function readBoolean(env: EnvSource, key: string, fallback: boolean): boolean {
  const raw = readOptional(env, key);
  if (raw === undefined) {
    return fallback;
  }
  const lowered = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(lowered)) {
    return false;
  }
  throw new ConfigError(
    `${key} must be a boolean (true/false); received "${raw}".`,
  );
}

/**
 * Validate and normalize the Splunk base URL. Rejects empty/invalid URLs and
 * anything that is not an http(s) origin, refusing to start.
 *
 * Requirement 13.3.
 */
function validateBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(
      `SPLUNK_BASE_URL is not a valid URL: "${raw}".`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `SPLUNK_BASE_URL must be an http(s) URL; received "${raw}".`,
    );
  }
  // Strip a trailing slash so downstream path concatenation is predictable.
  return raw.replace(/\/+$/, "");
}

/**
 * Compute the default per-user user-data directory in an OS-appropriate
 * application-data location. Callers may override via `SPLUNK_USER_DATA_DIR`.
 *
 * - Windows: `%LOCALAPPDATA%\\splunk-mcp-server\\user-data`
 * - macOS: `~/Library/Application Support/splunk-mcp-server/user-data`
 * - Linux/other: `$XDG_DATA_HOME/splunk-mcp-server/user-data`
 *   (falling back to `~/.local/share/...`)
 */
function defaultUserDataDir(env: EnvSource): string {
  const appName = "splunk-mcp-server";
  const leaf = "user-data";
  const os = platform();
  if (os === "win32") {
    const base =
      readOptional(env, "LOCALAPPDATA") ??
      readOptional(env, "APPDATA") ??
      join(homedir(), "AppData", "Local");
    return join(base, appName, leaf);
  }
  if (os === "darwin") {
    return join(homedir(), "Library", "Application Support", appName, leaf);
  }
  const xdg = readOptional(env, "XDG_DATA_HOME");
  const base = xdg ?? join(homedir(), ".local", "share");
  return join(base, appName, leaf);
}

/**
 * Load and validate the server configuration from the environment.
 *
 * @param env - The environment source (defaults to `process.env`); injectable
 *   for testing so no global mutation is required.
 * @returns A fully-resolved {@link Config} with all defaults applied.
 * @throws {@link ConfigError} when the base URL is empty/invalid, a numeric or
 *   boolean value is malformed, or a required variable with no default is
 *   missing.
 */
export function loadConfig(env: EnvSource = process.env): Config {
  const baseUrl = validateBaseUrl(
    readString(env, "SPLUNK_BASE_URL", DEFAULTS.baseUrl),
  );

  return {
    baseUrl,
    app: readString(env, "SPLUNK_APP", DEFAULTS.app),
    // Optional: undefined when unset. Never falls back to a hardcoded name.
    username: readOptional(env, "SPLUNK_USERNAME"),
    defaultEarliest: readString(
      env,
      "SPLUNK_DEFAULT_EARLIEST",
      DEFAULTS.defaultEarliest,
    ),
    defaultLatest: readString(
      env,
      "SPLUNK_DEFAULT_LATEST",
      DEFAULTS.defaultLatest,
    ),
    defaultCount: readPositiveInt(
      env,
      "SPLUNK_DEFAULT_COUNT",
      DEFAULTS.defaultCount,
    ),
    pollIntervalMs: readPositiveInt(
      env,
      "SPLUNK_POLL_INTERVAL_MS",
      DEFAULTS.pollIntervalMs,
    ),
    maxWaitMs: readPositiveInt(env, "SPLUNK_MAX_WAIT_MS", DEFAULTS.maxWaitMs),
    autoAsyncThresholdMs: readPositiveInt(
      env,
      "SPLUNK_AUTO_ASYNC_THRESHOLD_MS",
      DEFAULTS.autoAsyncThresholdMs,
    ),
    userDataDir: readString(
      env,
      "SPLUNK_USER_DATA_DIR",
      defaultUserDataDir(env),
    ),
    headful: readBoolean(env, "SPLUNK_HEADFUL", DEFAULTS.headful),
    cdpPort: readPositiveInt(env, "SPLUNK_CDP_PORT", DEFAULTS.cdpPort),
    cdpHost: readString(env, "SPLUNK_CDP_HOST", DEFAULTS.cdpHost),
  };
}
