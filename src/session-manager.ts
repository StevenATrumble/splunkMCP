/**
 * SessionManager: owns the Playwright persistent browser context and the single
 * authenticated page that all Splunk REST calls run inside.
 *
 * This module implements tasks 4.1 and 4.2:
 * - Launch `chromium.launchPersistentContext(userDataDir, ...)` with a single
 *   primary page navigated to the Splunk origin (task 4.1).
 * - Create the user-data-dir in a per-user, OS-appropriate location (the
 *   default is computed by {@link loadConfig} in `config.ts`) and restrict its
 *   filesystem permissions to owner-only; abort launch if applying permissions
 *   definitely fails, but proceed when the permissions were applied and only
 *   their verification is uncertain (task 4.1).
 * - Guard startup so a missing Chromium binary aborts before any context is
 *   launched (task 4.1).
 * - `fetchJson()` executes every REST call as a same-origin, in-page `fetch`
 *   inside the authenticated page, so the `HttpOnly` session cookie is attached
 *   implicitly and never read into server memory (task 4.2).
 * - `close()` to tear the context down.
 *
 * Single-instance reuse: because a persistent context demands exclusive access
 * to its `user-data-dir`, a second server process launched against the same
 * profile would otherwise crash on the profile lock ("Opening in existing
 * browser session"). To let multiple concurrent agents share one authenticated
 * window, {@link SessionManager.launch} is attach-first / launch-on-miss:
 * - The owner process launches the persistent context with a fixed loopback
 *   remote-debugging port (`--remote-debugging-port=${config.cdpPort}`) and
 *   writes a small `cdp-endpoint.json` handshake file into the profile dir.
 * - A later process reads that handshake, attaches over CDP
 *   (`chromium.connectOverCDP`) to the already-running browser, and adopts its
 *   context/page instead of launching a second owner. It never closes the
 *   shared browser on shutdown (ownership-aware {@link SessionManager.close}).
 * The CDP endpoint is loopback-only and its ws URL is never logged above debug
 * (it grants full control of the authenticated session).
 *
 * Session probing (`probeSession`), the MyApps login flow (`promptLogin`),
 * readiness orchestration (`ensureReady`), and the serialized request queue are
 * intentionally left as clearly-marked stubs; they are implemented by later
 * tasks (4.4, 4.6). Task 4.6 will wrap the raw {@link SessionManager.fetchJson}
 * path (implemented here as `fetchJsonUnqueued`) with a FIFO queue.
 *
 * Requirements:
 * - 8.1: Execute every Splunk REST call as an in-page fetch within the
 *   authenticated page on the Splunk origin.
 * - 8.2: On a state-changing method with a readable CSRF token, send it as the
 *   `X-Splunk-Form-Key` header.
 * - 8.3: Read the CSRF token dynamically from the readable cookie at call time.
 * - 8.4: On a state-changing method with no readable CSRF token, abort the
 *   request (without sending) and return a missing-CSRF error.
 * - 8.5: A missing-CSRF abort does not block subsequent requests; the token is
 *   re-read from the cookie on each subsequent state-changing request.
 * - 8.6: Route every REST call through the `${baseUrl}/en-US/splunkd/__raw/`
 *   proxy path.
 * - 8.7: If an in-page fetch fails to complete, return a transport error; a
 *   completed non-2xx HTTP response is returned as a structured response (with
 *   its status) for callers to classify.
 * - 9.1: Launch with a persistent User_Data_Dir so the SSO session survives
 *   across server restarts.
 * - 16.1: When no User_Data_Dir is configured, store it in a per-user OS
 *   application-data directory (default supplied by the config loader).
 * - 16.2: Restrict the User_Data_Dir to owner-only access, denying group/other.
 * - 16.3: If applying owner-only permissions definitely fails, return an error
 *   identifying the failure and do NOT launch the browser context.
 * - 16.4: If permissions were applied but verification is uncertain, proceed to
 *   launch the browser context.
 * - 17.4: If the Chromium binary is not present, return an error and do NOT
 *   launch the browser context.
 */

import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

import type { Config } from "./config.js";
import {
  SESSION_EXPIRED_HINT,
  SessionExpiredError,
  SplunkMcpError,
  TransportError,
} from "./errors.js";
import { logger, type Logger } from "./log.js";
import { ensureChromiumInstalled } from "./startup-guard.js";
import type {
  RawRestRequest,
  RawRestResponse,
  SessionHealth,
} from "./types.js";
import { encodeForm, looksLikeLoginHtml, tryParseJson } from "./util.js";

/** Owner-only directory permission bits (`rwx------`). */
const OWNER_ONLY_MODE = 0o700;

/**
 * The readable cookie carrying the CSRF token. Its value is sent as the
 * `X-Splunk-Form-Key` header on state-changing requests (Requirement 8.2). The
 * `HttpOnly` session cookie (`splunkd_8443`) is intentionally NOT named here —
 * it is never read by our code and is attached implicitly by the browser.
 */
const CSRF_COOKIE_NAME = "splunkweb_csrf_token_8443";

/** The proxy path prefix all REST calls route through (Requirement 8.6). */
const RAW_PROXY_PREFIX = "/en-US/splunkd/__raw/";

/** HTTP methods that do not change state and therefore need no CSRF token. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** The read-only REST path used to probe session health (Requirement 11.1). */
const CURRENT_CONTEXT_PATH =
  "services/authentication/current-context?output_mode=json";

/**
 * The Microsoft MyApps portal the login flow navigates to. From there the user
 * selects the Splunk tile, which SAML/SSO-redirects into an authenticated
 * Splunk session (the confirmed MyApps_Login_Flow, Requirement 9.3).
 */
const MYAPPS_URL = "https://myapps.microsoft.com/";

/**
 * Default upper bound for the session-health probe (Requirement 9.2 / 11.2):
 * the probe is only "live" if it returns a successful 2xx within this window.
 * Injectable so tests (task 4.7) need not wait a real 10 seconds.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Default upper bound for waiting on the interactive MyApps login flow to
 * establish a live session (Requirement 9.4). Injectable so tests need not
 * wait a real 300 seconds.
 */
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;

/**
 * How often the login flow re-probes the session while waiting for the user to
 * complete SSO/MFA. Kept modest so completion is detected promptly without
 * hammering the probe endpoint.
 */
const DEFAULT_LOGIN_POLL_INTERVAL_MS = 2_000;

/**
 * The handshake file written into the profile dir by the owner process,
 * recording where the reusable browser is listening for CDP attach. Later
 * processes read it to discover the ws endpoint (the browser's own
 * `SingletonLock` guards the profile but does not reveal where to attach).
 */
const CDP_ENDPOINT_FILENAME = "cdp-endpoint.json";

/** Owner-only file permission bits (`rw-------`) for the handshake file. */
const ENDPOINT_FILE_MODE = 0o600;

/**
 * Default upper bound (ms) for a single CDP attach attempt
 * ({@link SessionManagerDeps.connectOverCDP}). Kept short so a stale endpoint
 * file does not stall startup before falling back to launching an owner.
 * Injectable so tests need not wait real time.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Substrings identifying Playwright/Chromium's "profile already in use" launch
 * error. When the owner launch loses the startup race to another process, the
 * profile lock produces this error; we detect it to re-read the handshake file
 * and attach instead (see the concurrency notes in
 * ANALYSIS-single-instance-reuse.md).
 */
const PROFILE_IN_USE_MARKERS = [
  "Opening in existing browser session",
  "already in use",
] as const;

/**
 * The shape of the {@link CDP_ENDPOINT_FILENAME} handshake file. `wsEndpoint`
 * is the CDP WebSocket URL a later process attaches to; the remaining fields
 * are diagnostic (they identify the owning process and when it started).
 */
export interface CdpEndpointInfo {
  /** The CDP WebSocket endpoint URL to attach to (loopback). */
  wsEndpoint: string;
  /** The loopback remote-debugging port the owner launched with. */
  port: number;
  /** The owning process id (diagnostic; helps identify a stale file). */
  pid: number;
  /** ISO-8601 timestamp of when the owner wrote the file (diagnostic). */
  startedAt: string;
}

/**
 * Raised when the persisted browser profile directory (User_Data_Dir) cannot
 * be secured to owner-only access. This aborts startup before any browser
 * context is launched, because the directory holds a live authenticated
 * session (Requirement 16.3). Non-retryable: the operator must fix filesystem
 * permissions or choose a different `SPLUNK_USER_DATA_DIR`.
 */
export class UserDataDirPermissionError extends SplunkMcpError {
  /** Permission problems require operator intervention, not a retry. */
  override readonly retryable = false;
  /** The directory whose permissions could not be secured. */
  readonly dir: string;

  constructor(dir: string, cause?: unknown) {
    super(
      `Failed to secure the browser profile directory to owner-only access: ${dir}. ` +
        "Fix its filesystem permissions or set SPLUNK_USER_DATA_DIR to a location " +
        "you own, then restart.",
    );
    this.dir = dir;
    if (cause !== undefined) {
      // Preserve the underlying failure for diagnostics without leaking it into
      // the primary message.
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Raised when a state-changing REST call (any method other than GET/HEAD) is
 * attempted but no CSRF token is readable from the `splunkweb_csrf_token_8443`
 * cookie at call time. The request is aborted BEFORE anything is sent
 * (Requirement 8.4). This is a client-side abort, not a Splunk-side failure.
 *
 * The abort is stateless: the token is re-read from the cookie on every
 * subsequent state-changing request, so a transient absence never blocks later
 * calls (Requirement 8.5). Marked retryable for that reason — once the readable
 * cookie is present the same call can succeed.
 */
export class MissingCsrfTokenError extends SplunkMcpError {
  /** Retrying can succeed once the CSRF cookie becomes readable. */
  override readonly retryable = true;
  /** The REST path whose state-changing request was aborted. */
  readonly path: string;
  /** The HTTP method of the aborted request. */
  readonly method: string;

  constructor(method: string, path: string) {
    super(
      `Aborted ${method} ${path}: no CSRF token is readable from the ` +
        `${CSRF_COOKIE_NAME} cookie. The request was not sent. Ensure the ` +
        "browser session is live, then retry.",
    );
    this.method = method;
    this.path = path;
  }
}

/**
 * Dependency seam for the persistent-context launcher, so tests can substitute
 * a fake without importing Playwright. Mirrors the shape of
 * `chromium.launchPersistentContext`. The options carry `args` so the owner
 * launch can pass `--remote-debugging-port=<port>` and tests can assert it.
 */
export type LaunchPersistentContext = (
  userDataDir: string,
  options: { headless: boolean; args?: string[] },
) => Promise<BrowserContext>;

/**
 * Dependency seam for attaching to an already-running browser over CDP, so
 * tests can fake reuse without a real browser. Mirrors the shape of
 * `chromium.connectOverCDP`.
 */
export type ConnectOverCdp = (endpoint: string) => Promise<Browser>;

/**
 * Injectable handshake-file accessors. Default to real filesystem operations on
 * `${userDataDir}/cdp-endpoint.json`; overridden in tests so no real file is
 * touched. `read` resolves `undefined` when the file is absent (never throws
 * for a missing file); `remove` is idempotent (a missing file is not an error).
 */
export interface EndpointFileIo {
  /** Read + parse the handshake file, or `undefined` if it does not exist. */
  read: () => Promise<CdpEndpointInfo | undefined>;
  /** Write the handshake file with owner-only permissions. */
  write: (info: CdpEndpointInfo) => Promise<void>;
  /** Remove the handshake file; a missing file is not an error. */
  remove: () => Promise<void>;
}

/**
 * Injectable collaborators for {@link SessionManager}. All default to the real
 * implementations; tests (task 4.7) override them to avoid launching a real
 * browser or touching the real filesystem.
 */
export interface SessionManagerDeps {
  /** Verifies the Chromium binary is present; throws when missing (Req 17.4). */
  ensureChromium?: () => Promise<void>;
  /** Launches the persistent Chromium context. */
  launchPersistentContext?: LaunchPersistentContext;
  /** Attaches to an already-running browser over CDP (reuse path). */
  connectOverCDP?: ConnectOverCdp;
  /**
   * Handshake-file accessors for the CDP endpoint. Defaults to real filesystem
   * operations on `${userDataDir}/cdp-endpoint.json`; injectable in tests.
   */
  endpointFile?: EndpointFileIo;
  /**
   * Resolve the CDP WebSocket endpoint from the loopback DevTools JSON endpoint
   * (`http://<host>:<port>/json/version` → `webSocketDebuggerUrl`). Injectable
   * and bounded; defaults to a `fetch`-based implementation. Returns
   * `undefined` when the endpoint cannot be resolved (reuse is then skipped for
   * this launch, but the process still serves as owner).
   */
  resolveWsEndpoint?: (host: string, port: number) => Promise<string | undefined>;
  /** Redaction-aware logger. */
  logger?: Logger;
  /** OS platform accessor (injectable so Windows/POSIX branches are testable). */
  getPlatform?: () => NodeJS.Platform;
  /**
   * Upper bound (ms) for a single session-health probe (Req 9.2 / 11.2).
   * Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}; overridable in tests so the
   * 10s wait need not be incurred.
   */
  probeTimeoutMs?: number;
  /**
   * Upper bound (ms) to wait for the interactive login flow to establish a live
   * session (Req 9.4). Defaults to {@link DEFAULT_LOGIN_TIMEOUT_MS}; overridable
   * in tests so the 300s wait need not be incurred.
   */
  loginTimeoutMs?: number;
  /**
   * Interval (ms) between session re-probes while awaiting login completion.
   * Defaults to {@link DEFAULT_LOGIN_POLL_INTERVAL_MS}.
   */
  loginPollIntervalMs?: number;
  /**
   * Upper bound (ms) for a single CDP attach attempt. Defaults to
   * {@link DEFAULT_CONNECT_TIMEOUT_MS}; overridable in tests.
   */
  connectTimeoutMs?: number;
  /**
   * Monotonic clock accessor (ms). Injectable so deadline math is testable
   * without real time. Defaults to {@link Date.now}.
   */
  now?: () => number;
  /**
   * Sleep seam resolving after roughly `ms` milliseconds. Injectable so tests
   * can advance time without real waits. Defaults to a `setTimeout` wrapper.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A single REST call waiting its turn in the serialized queue. Carries the
 * request together with the settlers of the promise handed back to the caller
 * by {@link SessionManager.fetchJson}, so the pump can resolve/reject exactly
 * that caller (Requirements 18.1–18.3).
 */
interface QueuedRequest {
  /** The REST request to execute once this entry reaches the front. */
  readonly req: RawRestRequest;
  /** Resolve the caller's promise with the structured response. */
  readonly resolve: (value: RawRestResponse) => void;
  /** Reject the caller's promise (e.g. transport failure or page teardown). */
  readonly reject: (reason: unknown) => void;
}

/**
 * Owns the browser lifecycle and the single authenticated page. Constructed
 * with a resolved {@link Config}; call {@link launch} once to bring up the
 * persistent context.
 */
export class SessionManager {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly ensureChromium: () => Promise<void>;
  private readonly launchPersistentContext: LaunchPersistentContext;
  private readonly connectOverCDP: ConnectOverCdp;
  private readonly endpointFile: EndpointFileIo;
  private readonly resolveWsEndpointFn: (
    host: string,
    port: number,
  ) => Promise<string | undefined>;
  private readonly getPlatform: () => NodeJS.Platform;
  private readonly probeTimeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly loginPollIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private context: BrowserContext | undefined;
  private primaryPage: Page | undefined;

  /**
   * The attached browser connection when this instance is a *reuse* (attached)
   * session rather than the owner. Held so {@link close} can disconnect it
   * without closing the shared browser. Undefined on the owner path.
   */
  private attachedBrowser: Browser | undefined;

  /**
   * Whether this instance *owns* the browser (launched the persistent context)
   * or is *attached* to another process's browser over CDP. Governs the
   * ownership-aware teardown in {@link close}: the owner closes the context and
   * removes the handshake file; an attached instance only disconnects and
   * leaves the shared browser (and the handshake file) intact.
   */
  private owning = false;

  /**
   * FIFO queue of pending REST calls awaiting the shared page (Requirement
   * 18.1). Each entry pairs the request with its caller's promise settlers so
   * the queue can either run the call or fail it (on page unavailability,
   * Requirement 18.3) without losing the caller.
   */
  private readonly queue: QueuedRequest[] = [];

  /**
   * Whether a queued REST call is currently executing against the shared page.
   * The pump runs at most one call at a time (Requirement 18.1) and advances to
   * the next entry FIFO on completion (Requirement 18.2).
   */
  private pumping = false;

  constructor(config: Config, deps: SessionManagerDeps = {}) {
    this.config = config;
    this.log = deps.logger ?? logger;
    this.ensureChromium = deps.ensureChromium ?? ensureChromiumInstalled;
    this.launchPersistentContext =
      deps.launchPersistentContext ??
      ((userDataDir, options) =>
        chromium.launchPersistentContext(userDataDir, options));
    this.connectOverCDP =
      deps.connectOverCDP ?? ((endpoint) => chromium.connectOverCDP(endpoint));
    this.endpointFile =
      deps.endpointFile ?? createFsEndpointFileIo(config.userDataDir);
    this.resolveWsEndpointFn =
      deps.resolveWsEndpoint ?? defaultResolveWsEndpoint;
    this.getPlatform = deps.getPlatform ?? platform;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.loginPollIntervalMs =
      deps.loginPollIntervalMs ?? DEFAULT_LOGIN_POLL_INTERVAL_MS;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.now = deps.now ?? (() => Date.now());
    this.sleep =
      deps.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /**
   * Launch the persistent browser context and navigate a single primary page
   * to the Splunk origin. Idempotent: a second call is a no-op once launched.
   *
   * Order of operations matters for the guards:
   * 1. Verify Chromium is installed (Req 17.4) — abort before securing the dir
   *    or launching anything.
   * 2. Create and secure the user-data-dir to owner-only (Req 16.1–16.4) —
   *    abort the launch if securing definitely fails.
   * 3. Launch the persistent context and navigate the primary page (Req 9.1).
   *
   * @throws {@link ChromiumMissingError} when the Chromium binary is absent.
   * @throws {@link UserDataDirPermissionError} when owner-only permissions
   *   cannot be applied to the profile directory.
   */
  async launch(): Promise<void> {
    if (this.context) {
      return;
    }

    // Req 17.4: never launch a context when Chromium is missing.
    await this.ensureChromium();

    // Attach-first: if a reusable browser is already running on this profile,
    // adopt it instead of trying to launch a second owner (which would crash on
    // the profile lock). On a miss, launch and become the owner.
    if (await this.tryAttach()) {
      return;
    }

    await this.launchOwned();
  }

  /**
   * The Splunk start URL the primary page is navigated to. Same-origin with
   * `config.baseUrl` so subsequent in-page fetches (task 4.2) work.
   */
  private get startUrl(): string {
    return `${this.config.baseUrl}/en-US/app/${this.config.app}/search`;
  }

  /**
   * Attempt to attach to an already-running browser on this profile.
   *
   * Reads the `cdp-endpoint.json` handshake file; if it names a ws endpoint,
   * connects over CDP (bounded by {@link connectTimeoutMs}) and adopts the
   * existing context, reusing a page on the Splunk origin or opening one.
   *
   * Ownership: a successful attach sets `owning = false` so {@link close} only
   * disconnects and never tears down the shared browser.
   *
   * Stale handling: if the file exists but the connect fails (the owner died
   * without cleanup), the stale file is removed so {@link launchOwned} can take
   * over as the fresh owner.
   *
   * @returns `true` when attached and ready; `false` on any miss/stale/failure
   *   (the caller should then launch an owner).
   */
  private async tryAttach(): Promise<boolean> {
    let info: CdpEndpointInfo | undefined;
    try {
      info = await this.endpointFile.read();
    } catch (error) {
      // A malformed/unreadable handshake file is treated as a miss; remove it
      // so a fresh owner can rewrite it.
      this.log.debug("Could not read CDP endpoint handshake; treating as miss", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.endpointFile.remove().catch(() => {
        /* best-effort */
      });
      return false;
    }

    if (!info || !info.wsEndpoint) {
      // No handshake file (or no endpoint recorded) — nobody to attach to.
      return false;
    }

    let browser: Browser;
    try {
      // Do NOT log info.wsEndpoint above debug: it grants full browser control.
      this.log.debug("Attaching to existing browser over CDP", {
        port: info.port,
      });
      browser = await this.withTimeout(
        this.connectOverCDP(info.wsEndpoint),
        this.connectTimeoutMs,
        "CDP attach",
      );
    } catch (error) {
      // Connect failed/timed out: the recorded endpoint is stale. Remove the
      // file and fall through to launching a fresh owner.
      this.log.debug(
        "CDP attach failed; treating handshake as stale and removing it",
        { port: info.port, error: error instanceof Error ? error.message : String(error) },
      );
      await this.endpointFile.remove().catch(() => {
        /* best-effort */
      });
      return false;
    }

    // Adopt the first available context from the attached browser (a persistent
    // context surfaces as the browser's single context under CDP).
    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0]! : undefined;
    if (!context) {
      // Nothing usable to adopt — disconnect and fall back to owning.
      this.log.debug("Attached browser exposed no context; falling back to launch");
      await browser.close().catch(() => {
        /* disconnect only */
      });
      return false;
    }

    // Reuse an existing page already on the Splunk origin, or open/navigate one.
    const page = await this.acquireOriginPage(context);

    this.attachedBrowser = browser;
    this.context = context;
    this.primaryPage = page;
    this.owning = false;

    this.log.info("Attached to existing browser session", {
      port: info.port,
      headful: this.config.headful,
    });
    return true;
  }

  /**
   * Launch a fresh persistent context and become the owner of the profile.
   *
   * Secures the profile dir owner-only (Req 16.1–16.4) before launching,
   * launches with the fixed loopback remote-debugging port so later processes
   * can attach, navigates the primary page to the Splunk origin (Req 9.1), then
   * writes the `cdp-endpoint.json` handshake file so reuse is discoverable.
   *
   * Startup race: if the launch loses the profile lock to another process
   * (Chromium's "Opening in existing browser session"), the winner should have
   * just written the handshake file — so we re-attempt {@link tryAttach} once
   * and only rethrow a clear error if that also fails.
   */
  private async launchOwned(): Promise<void> {
    // Req 16.1–16.4: create the profile dir and lock it down before launch.
    await this.prepareUserDataDir(this.config.userDataDir);

    // Expose a fixed loopback CDP endpoint so later processes can attach.
    // Chromium binds --remote-debugging-port to localhost by default.
    const args = [`--remote-debugging-port=${this.config.cdpPort}`];

    let context: BrowserContext;
    try {
      // Req 9.1: persistent context keeps the SSO session across restarts.
      // Login is always interactive, so honor the (default true) headful flag.
      context = await this.launchPersistentContext(this.config.userDataDir, {
        headless: !this.config.headful,
        args,
      });
    } catch (error) {
      if (isProfileInUseError(error)) {
        // Lost the startup race: another process now owns the profile and
        // (should have) written the handshake. Re-read and attach.
        this.log.debug(
          "Profile already in use on launch; re-attempting attach (startup race)",
        );
        if (await this.tryAttach()) {
          return;
        }
        throw new TransportError(
          "The browser profile is already in use by another instance, but " +
            "attaching to it failed. Ensure only one Splunk MCP instance owns " +
            "the profile, or that the existing instance exposes its CDP port " +
            `(${this.config.cdpPort}), then retry.`,
        );
      }
      throw error;
    }

    this.context = context;
    this.owning = true;

    // A persistent context opens with one page; reuse it, otherwise create one.
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0]! : await context.newPage();
    this.primaryPage = page;

    // Req 9.1 / task 4.1: navigate onto the Splunk origin for same-origin fetch.
    await page.goto(this.startUrl, { waitUntil: "domcontentloaded" });

    this.log.info("Browser session launched", {
      startUrl: this.startUrl,
      headful: this.config.headful,
      cdpPort: this.config.cdpPort,
    });

    // Publish the handshake so later processes can attach. Best-effort: if the
    // ws endpoint cannot be resolved we still serve as owner, reuse just will
    // not be available until the next launch.
    await this.publishEndpoint(context);
  }

  /**
   * Reuse a page already on the Splunk origin within `context`, or open/navigate
   * one to the Splunk start URL. Used on the attach path where the shared
   * browser may already have the authenticated page open.
   */
  private async acquireOriginPage(context: BrowserContext): Promise<Page> {
    const expectedOrigin = new URL(this.config.baseUrl).origin;
    for (const candidate of context.pages()) {
      let origin = "";
      try {
        origin = new URL(candidate.url()).origin;
      } catch {
        origin = "";
      }
      if (origin === expectedOrigin) {
        return candidate;
      }
    }
    // No page on the origin — open one and navigate it there.
    const page = await context.newPage();
    await page.goto(this.startUrl, { waitUntil: "domcontentloaded" });
    return page;
  }

  /**
   * Resolve the launched browser's CDP ws endpoint and write the handshake
   * file. Prefers the Browser's own `wsEndpoint()` when available; otherwise
   * derives it from the loopback DevTools JSON endpoint on the configured port.
   * Best-effort: on failure it logs at debug and returns without writing (the
   * process still serves as owner, reuse is simply unavailable this run).
   */
  private async publishEndpoint(context: BrowserContext): Promise<void> {
    let wsEndpoint: string | undefined;

    const browser = context.browser();
    // `wsEndpoint()` is not on Playwright's `Browser` type for a persistent
    // context (and is typically undefined there), so probe it defensively.
    const wsEndpointFn = (
      browser as { wsEndpoint?: () => string } | null
    )?.wsEndpoint;
    const direct = typeof wsEndpointFn === "function" ? wsEndpointFn.call(browser) : undefined;
    if (typeof direct === "string" && direct.length > 0) {
      wsEndpoint = direct;
    } else {
      try {
        wsEndpoint = await this.resolveWsEndpointFn(
          this.config.cdpHost,
          this.config.cdpPort,
        );
      } catch (error) {
        this.log.debug("Failed to resolve CDP ws endpoint; reuse unavailable", {
          port: this.config.cdpPort,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    if (!wsEndpoint) {
      this.log.debug(
        "Could not determine CDP ws endpoint; skipping handshake (reuse unavailable)",
        { port: this.config.cdpPort },
      );
      return;
    }

    try {
      await this.endpointFile.write({
        wsEndpoint,
        port: this.config.cdpPort,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      this.log.debug("Published CDP endpoint handshake for reuse", {
        port: this.config.cdpPort,
      });
    } catch (error) {
      // Not fatal: we simply will not be reusable this run.
      this.log.debug("Failed to write CDP endpoint handshake", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create the user-data-dir (recursively) and restrict it to owner-only
   * access.
   *
   * On POSIX, `chmod 0o700` is authoritative: if it throws, the directory is
   * not secured and we abort (Req 16.3). On Windows, POSIX mode bits have
   * limited meaning — `chmod` is best-effort and the resulting ACLs cannot be
   * reliably verified, so a failure there is treated as "applied but uncertain"
   * and we proceed (Req 16.4).
   *
   * @param dir - The resolved user-data-dir path.
   * @throws {@link UserDataDirPermissionError} when securing definitely fails.
   */
  private async prepareUserDataDir(dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true, mode: OWNER_ONLY_MODE });
    } catch (error) {
      // If the directory could not even be created, we cannot secure it.
      throw new UserDataDirPermissionError(dir, error);
    }

    const isWindows = this.getPlatform() === "win32";

    try {
      await chmod(dir, OWNER_ONLY_MODE);
    } catch (error) {
      if (isWindows) {
        // Windows: chmod has limited effect and cannot be reliably applied or
        // verified. Treat as uncertain and proceed (Req 16.4).
        this.log.warn(
          "Could not apply owner-only permissions on Windows; proceeding (verification is uncertain)",
          { dir },
        );
        return;
      }
      // POSIX: chmod is authoritative — a failure means the dir is not secured.
      throw new UserDataDirPermissionError(dir, error);
    }

    // Best-effort verification. Any uncertainty (including all Windows cases)
    // is non-fatal per Req 16.4; only a definite POSIX failure above aborts.
    if (isWindows) {
      this.log.debug(
        "Owner-only permissions applied best-effort on Windows; verification is uncertain, proceeding",
        { dir },
      );
      return;
    }

    try {
      const info = await stat(dir);
      const modeBits = info.mode & 0o777;
      if ((modeBits & 0o077) !== 0) {
        // Group/other bits are still set despite a successful chmod — this is a
        // definite failure to deny group/other (Req 16.2, 16.3).
        throw new UserDataDirPermissionError(dir);
      }
    } catch (error) {
      if (error instanceof UserDataDirPermissionError) {
        throw error;
      }
      // The chmod succeeded but we could not verify the result. Uncertain, not
      // a definite failure — proceed (Req 16.4).
      this.log.debug(
        "Applied owner-only permissions but could not verify them; proceeding",
        { dir },
      );
    }
  }

  /**
   * Close the browser context and release the primary page. Safe to call more
   * than once. Later tasks may extend this to also drain the request queue.
   */
  async close(): Promise<void> {
    const context = this.context;
    const attachedBrowser = this.attachedBrowser;
    const owning = this.owning;
    this.context = undefined;
    this.primaryPage = undefined;
    this.attachedBrowser = undefined;
    this.owning = false;

    // Req 18.3: the shared page is going away. Fail every queued call with a
    // transport error rather than leaving callers pending indefinitely. The
    // in-flight call (if any) races the teardown and will settle on its own via
    // the pump; only calls that have not yet started are drained here.
    this.drainQueue(
      new TransportError(
        "Browser session is closing; the pending REST call was not executed.",
      ),
    );

    if (owning) {
      // Owner: close the context (kills the browser we launched) and remove the
      // handshake file so no later process attaches to a dead endpoint.
      if (context) {
        await context.close();
      }
      await this.endpointFile.remove().catch((error: unknown) => {
        this.log.debug("Failed to remove CDP endpoint handshake on close", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (context) {
        this.log.info("Browser session closed (owner)");
      }
      return;
    }

    // Attached (reuse) session: DISCONNECT only. Closing the CDP-connected
    // Browser detaches this process without terminating the shared browser that
    // the owner still relies on. Never call context.close() here — that would
    // tear the profile out from under the owner. Leave the handshake intact.
    if (attachedBrowser) {
      await attachedBrowser.close().catch((error: unknown) => {
        this.log.debug("Error disconnecting attached CDP browser on close", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.log.info("Detached from shared browser session (attached)");
    }
  }

  /**
   * The single authenticated page, once {@link launch} has run. Exposed for
   * the later tasks that execute in-page fetches against it.
   */
  protected get page(): Page | undefined {
    return this.primaryPage;
  }

  // ---------------------------------------------------------------------------
  // Session probe, login flow, and readiness (task 4.4).
  // ---------------------------------------------------------------------------

  /**
   * Probe `services/authentication/current-context` and report whether the
   * Splunk session is live. Read-only (no state change) and, for an expected
   * dead session, never throws.
   *
   * Classification (Requirements 11.2, 11.3, 9.2):
   * - Healthy iff the probe returns HTTP 200 with a JSON body that is NOT
   *   classified as a login redirect. The discovered username is returned when
   *   present.
   * - Not healthy (WITHOUT throwing) for HTTP 401, a login/SSO redirect, or a
   *   non-JSON body.
   *
   * Transport priority (Requirement 11.4): a transport/browser-automation
   * failure from the underlying in-page fetch propagates as a typed
   * {@link TransportError} and is NOT swallowed — it takes priority even when a
   * 401 / login-redirect classification would otherwise also apply, because the
   * probe never completed a definitive HTTP response. `fetchJson` already maps
   * such failures to {@link TransportError}, so we simply let them propagate
   * here and only catch the "dead session" HTTP classifications.
   *
   * The 10-second bound (Requirement 9.2): the probe is only considered live if
   * it returns a successful response within {@link probeTimeoutMs}. If the
   * underlying fetch does not settle in that window, the probe is treated as a
   * transport failure (the session's liveness could not be confirmed), which
   * surfaces as a {@link TransportError} to callers that want to distinguish it
   * and is treated as "not live" by {@link ensureReady}.
   *
   * @returns `{healthy:true, username}` when the session is live; otherwise
   *   `{healthy:false}`.
   * @throws {@link TransportError} on a transport/browser-automation failure or
   *   when the probe exceeds {@link probeTimeoutMs}.
   */
  async probeSession(): Promise<SessionHealth> {
    let resp: RawRestResponse;
    try {
      resp = await this.withTimeout(
        this.fetchJson({ method: "GET", path: CURRENT_CONTEXT_PATH }),
        this.probeTimeoutMs,
        "session-health probe",
      );
    } catch (error) {
      // Req 11.4: a transport failure (including a probe that did not complete
      // within the bound) takes priority and is surfaced, never reported as a
      // healthy/unhealthy classification. Preserve typed TransportError as-is;
      // wrap anything unexpected so callers always see the transport taxonomy.
      if (error instanceof TransportError) {
        throw error;
      }
      throw new TransportError(
        `Session-health probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Req 11.2 / 9.2: healthy only for 200 + JSON + not-a-login-redirect.
    if (resp.status === 200 && resp.json !== undefined && !resp.isLoginRedirect) {
      const username = extractUsername(resp.json);
      this.log.debug("Session probe reports healthy", { username });
      return username !== undefined
        ? { healthy: true, username }
        : { healthy: true };
    }

    // Req 11.3: 401 / login redirect / non-JSON => not healthy, no error.
    this.log.debug("Session probe reports not healthy", {
      status: resp.status,
      isLoginRedirect: resp.isLoginRedirect,
      hasJson: resp.json !== undefined,
    });
    return { healthy: false };
  }

  /**
   * Drive the interactive MyApps → Splunk-tile login flow and wait for the user
   * to complete SSO/MFA until a live Splunk session is established
   * (Requirements 9.3, 9.4).
   *
   * The persistent context was launched honoring `config.headful` (default
   * true, so the window is visible). The design specifies login is ALWAYS
   * headful; if the operator overrode `SPLUNK_HEADFUL=false` the window will not
   * be visible and interactive login cannot be completed — we log a clear
   * warning in that case. Re-launching the context headless→headful is out of
   * scope for this task; the pragmatic path here drives the existing primary
   * page to MyApps and polls for the session to become live.
   *
   * The flow:
   * 1. Navigate the primary page to the MyApps portal so the user can pick the
   *    Splunk tile (MFA is only prompted if the MS session expired).
   * 2. Poll {@link probeSession} on an interval until it reports healthy or the
   *    {@link loginTimeoutMs} deadline (Req 9.4) is reached.
   *
   * This method resolves once a live session is observed, or returns after the
   * wait limit elapses without establishing one; {@link ensureReady} performs
   * the authoritative final re-probe and raises {@link SessionExpiredError}
   * when the session is still dead (Req 9.6).
   */
  async promptLogin(): Promise<void> {
    const page = this.primaryPage;
    if (!page) {
      // No page to drive: this is a transport-layer condition (the context was
      // never launched or has been closed).
      throw new TransportError(
        "Cannot drive login: the browser page is not available.",
      );
    }

    if (!this.config.headful) {
      // Login is meant to be interactive/headful. Warn but still attempt to
      // drive the flow (a visible window may be required to complete SSO).
      this.log.warn(
        "SPLUNK_HEADFUL is false, but interactive login requires a visible " +
          "window; the MyApps login flow may not be completable until headful " +
          "mode is enabled.",
      );
    }

    this.log.info("Driving MyApps login flow", { url: MYAPPS_URL });
    try {
      await page.goto(MYAPPS_URL, { waitUntil: "domcontentloaded" });
    } catch (error) {
      // Navigation itself failing is a transport-layer problem.
      throw new TransportError(
        `Failed to navigate to the MyApps login portal: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Req 9.4: wait up to loginTimeoutMs for the user to complete SSO/MFA and
    // reach a live Splunk session. Poll the health probe on an interval, but do
    // not let a transient transport error abort the wait — the user may still
    // be mid-login. Only a definitive healthy probe ends the wait early.
    const deadline = this.now() + this.loginTimeoutMs;
    while (this.now() < deadline) {
      let health: SessionHealth;
      try {
        health = await this.probeSession();
      } catch (error) {
        // Mid-login probes may transiently fail (page still on MyApps/SSO).
        // Treat as "not yet live" and keep waiting until the deadline.
        this.log.debug("Login-wait probe not conclusive; continuing to wait", {
          error: error instanceof Error ? error.message : String(error),
        });
        health = { healthy: false };
      }
      if (health.healthy) {
        this.log.info("Login flow established a live session", {
          username: health.username,
        });
        return;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        break;
      }
      await this.sleep(Math.min(this.loginPollIntervalMs, remaining));
    }

    // Wait limit reached without a live session. ensureReady() does the final
    // authoritative re-probe and decides whether to raise (Req 9.6).
    this.log.warn("Login flow wait limit reached without a live session");
  }

  /**
   * Ensure the context is launched and the Splunk session is live, driving the
   * interactive login flow when the probe reports a dead session
   * (Requirements 9.2, 9.3, 9.5, 9.6).
   *
   * Sequence (mirrors the design's `ensureReady` pseudocode):
   * 1. Launch the persistent context if it has not been launched yet.
   * 2. Probe session health (bounded by {@link probeTimeoutMs}, Req 9.2).
   * 3. If not healthy: drive {@link promptLogin} (bounded by
   *    {@link loginTimeoutMs}, Req 9.4), then RE-PROBE (Req 9.5).
   * 4. If still not healthy, raise {@link SessionExpiredError} (Req 9.6).
   *
   * A transport failure from the initial probe is treated as "not live" here so
   * the login flow is given a chance to establish a session, rather than
   * aborting the readiness check outright.
   *
   * @throws {@link SessionExpiredError} when login does not establish a live
   *   session (Req 9.6).
   */
  async ensureReady(): Promise<void> {
    if (!this.context) {
      await this.launch();
    }

    if (await this.isSessionLive()) {
      return;
    }

    // Req 9.3: dead session — open the (visible) login window and drive the
    // MyApps → Splunk-tile flow, waiting up to loginTimeoutMs.
    await this.promptLogin();

    // Req 9.5: confirm the session is live after the login flow completes.
    if (await this.isSessionLive()) {
      return;
    }

    // Req 9.6: still dead after login (or after the wait limit) — surface a
    // typed session-expired error with re-auth instructions.
    throw new SessionExpiredError(
      `Login did not establish a live Splunk session. ${SESSION_EXPIRED_HINT}`,
    );
  }

  /**
   * Run {@link probeSession} and reduce it to a simple liveness boolean,
   * treating a transport failure as "not live" so the caller can proceed to
   * drive login rather than aborting. (Callers that need to distinguish a
   * transport failure should call {@link probeSession} directly.)
   */
  private async isSessionLive(): Promise<boolean> {
    try {
      const health = await this.probeSession();
      return health.healthy;
    } catch (error) {
      this.log.debug("Probe failed while checking readiness; treating as not live", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Race a promise against a timeout, rejecting with a {@link TransportError}
   * if it does not settle within `ms`. Used to enforce the 10-second probe
   * bound (Requirement 9.2 / 11.2). The pending operation is not cancelled (the
   * underlying in-page fetch has no abort seam here); the timeout only bounds
   * how long the caller waits before treating liveness as unconfirmed.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new TransportError(
            `Timed out after ${ms}ms waiting for ${label}.`,
          ),
        );
      }, ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Execute a REST call as an in-page, same-origin `fetch` inside the
   * authenticated page (task 4.2).
   *
   * This entry point serializes every REST call through a FIFO queue so at
   * most one call runs against the shared page at a time (Requirement 18.1).
   * Calls arriving while another is in flight are held in the queue and started
   * only once the in-progress call completes, in first-in-first-out order
   * (Requirement 18.2). If the page becomes unavailable while calls are queued
   * (e.g. {@link close}), the queued calls are failed with a
   * {@link TransportError} rather than left pending (Requirement 18.3).
   *
   * The per-call error semantics of the underlying fetch are preserved: a
   * {@link MissingCsrfTokenError} (Requirement 8.4) or {@link TransportError}
   * (Requirement 8.7) raised by {@link fetchJsonUnqueued} for a given request
   * is delivered to that request's caller only, and never stalls the queue —
   * the pump always advances to the next entry regardless of outcome.
   *
   * @param req - The REST request (method, proxy-relative path, optional body).
   * @returns A structured {@link RawRestResponse} for any completed HTTP
   *   response (including non-2xx such as 401/500), so callers such as the
   *   session probe (task 4.4) and the session-guarded POST (task 5.5) can
   *   classify it.
   * @throws {@link TransportError} when the in-page fetch/evaluate itself fails
   *   (Requirement 8.7), or {@link MissingCsrfTokenError} when a state-changing
   *   request has no readable CSRF token (Requirement 8.4).
   */
  fetchJson(req: RawRestRequest): Promise<RawRestResponse> {
    return new Promise<RawRestResponse>((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      // Kick the pump; if it is already running it will pick this entry up in
      // FIFO order once the in-progress call completes.
      void this.pump();
    });
  }

  /**
   * Serialized worker for the request {@link queue}. Runs at most one call at a
   * time (Requirement 18.1), advancing to the next queued entry FIFO on
   * completion (Requirement 18.2). A per-call failure never stalls the queue:
   * the caller's promise is rejected and the pump continues to the next entry.
   *
   * Re-entrancy is guarded by {@link pumping}: concurrent {@link fetchJson}
   * callers all enqueue, but only the first drives the pump; the rest are
   * serviced as it drains.
   */
  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        // Req 18.3: if the page is gone, fail the remaining queue instead of
        // attempting a call that cannot run.
        if (!this.primaryPage) {
          this.drainQueue(
            new TransportError(
              "Browser page is not available; the queued REST call was not executed.",
            ),
          );
          break;
        }

        const entry = this.queue.shift()!;
        try {
          const response = await this.fetchJsonUnqueued(entry.req);
          entry.resolve(response);
        } catch (error) {
          // Deliver the per-call error to only this caller (Req 8.4/8.7) and
          // keep draining — one failed call must not stall the queue.
          entry.reject(error);
        }
      }
    } finally {
      this.pumping = false;
    }
    // A queued item may have been added between the loop exit and clearing the
    // flag (e.g. from within a caller's continuation). Ensure it is serviced.
    if (this.queue.length > 0 && this.primaryPage) {
      void this.pump();
    }
  }

  /**
   * Reject every queued (not-yet-started) REST call with the given reason and
   * clear the queue. Used when the shared page becomes unavailable so callers
   * do not wait forever (Requirement 18.3). The in-flight call, if any, is not
   * affected here — it settles through the pump on its own.
   */
  private drainQueue(reason: unknown): void {
    if (this.queue.length === 0) {
      return;
    }
    const pending = this.queue.splice(0, this.queue.length);
    for (const entry of pending) {
      entry.reject(reason);
    }
    this.log.debug("Drained queued REST calls after page became unavailable", {
      count: pending.length,
    });
  }

  /**
   * The raw, un-serialized in-page fetch. Implements the design's "In-page
   * fetch (the auth mechanism)" pseudocode.
   *
   * Only the raw HTTP work (reading the CSRF cookie, building headers, calling
   * `fetch`, and reading the response text/status/redirect flag) runs inside
   * the page via `page.evaluate`. Classification (login-redirect detection and
   * JSON parsing) is done here in Node using the shared {@link util} helpers,
   * which cannot be imported into the page context. The form body is encoded in
   * Node with {@link encodeForm} before being passed in (Requirement 15.4).
   *
   * The session cookie value is never read: same-origin `credentials` cause the
   * browser to attach the `HttpOnly` cookie implicitly (Requirements 8.1,
   * 15.1). Only the readable CSRF cookie is read, and only to send it back as a
   * header (Requirements 8.2, 8.3).
   *
   * @param req - The REST request to execute.
   * @returns The structured response.
   * @throws {@link MissingCsrfTokenError} for a state-changing request with no
   *   readable CSRF token (aborted before sending; Requirement 8.4).
   * @throws {@link TransportError} when the fetch/evaluate fails (Requirement
   *   8.7).
   */
  protected async fetchJsonUnqueued(
    req: RawRestRequest,
  ): Promise<RawRestResponse> {
    const page = this.primaryPage;
    if (!page) {
      // The page is unavailable (never launched or already closed): this is a
      // transport-layer failure, not a Splunk-side one (Requirement 8.7).
      throw new TransportError(
        "Browser page is not available; the session has not been launched.",
      );
    }

    // Req 8.1: every REST call runs same-origin inside the authenticated page.
    // Assert the page is on the Splunk origin before evaluating.
    const expectedOrigin = new URL(this.config.baseUrl).origin;
    let actualOrigin: string;
    try {
      actualOrigin = new URL(page.url()).origin;
    } catch {
      actualOrigin = "";
    }
    if (actualOrigin !== expectedOrigin) {
      throw new TransportError(
        `Authenticated page is not on the Splunk origin (expected ` +
          `${expectedOrigin}, was ${actualOrigin || "unknown"}).`,
      );
    }

    const method = req.method;
    const isStateChanging = !SAFE_METHODS.has(method);

    // Req 8.6: route through the __raw proxy prefix.
    const url = `${this.config.baseUrl}${RAW_PROXY_PREFIX}${req.path}`;

    // Req 15.4: encode the form body in Node so nothing but the encoded string
    // crosses into the page context.
    const encodedBody =
      req.body !== undefined ? encodeForm(req.body) : undefined;

    // The payload passed into the page: everything needed to perform the raw
    // fetch. The CSRF token is read INSIDE the page (Req 8.3) — never here.
    const evalArg = {
      url,
      method,
      isStateChanging,
      encodedBody,
      csrfCookieName: CSRF_COOKIE_NAME,
    };

    let raw: {
      status: number;
      redirected: boolean;
      text: string;
      csrfMissing: boolean;
    };
    try {
      raw = await page.evaluate(async (arg): Promise<{
        status: number;
        redirected: boolean;
        text: string;
        csrfMissing: boolean;
      }> => {
        // --- Runs INSIDE the authenticated page (browser context) ---
        // Same-origin: the HttpOnly session cookie is attached automatically
        // and is never read here.

        // Read the readable CSRF cookie dynamically at call time (Req 8.3).
        const readCookie = (name: string): string => {
          const prefix = `${name}=`;
          const parts = document.cookie ? document.cookie.split(";") : [];
          for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.startsWith(prefix)) {
              return decodeURIComponent(trimmed.slice(prefix.length));
            }
          }
          return "";
        };

        const headers: Record<string, string> = {
          "X-Requested-With": "XMLHttpRequest",
        };

        if (arg.isStateChanging) {
          const csrf = readCookie(arg.csrfCookieName);
          if (csrf === "") {
            // Req 8.4: abort WITHOUT sending when the token is absent.
            return {
              status: 0,
              redirected: false,
              text: "",
              csrfMissing: true,
            };
          }
          headers["Content-Type"] = "application/x-www-form-urlencoded";
          // Req 8.2: attach the CSRF token when present.
          headers["X-Splunk-Form-Key"] = csrf;
        }

        const resp = await fetch(arg.url, {
          method: arg.method,
          headers,
          body: arg.isStateChanging ? arg.encodedBody : undefined,
          credentials: "same-origin",
        });

        const text = await resp.text();
        return {
          status: resp.status,
          redirected: resp.redirected,
          text,
          csrfMissing: false,
        };
      }, evalArg);
    } catch (error) {
      // Req 8.7: a failed fetch/evaluate is a transport-layer failure.
      this.log.warn("In-page fetch failed", {
        method,
        path: req.path,
        error,
      });
      throw new TransportError(
        `In-page fetch failed for ${method} ${req.path}.`,
      );
    }

    // Req 8.4/8.5: the token was absent at call time — abort as a client-side
    // error. Because we re-read the cookie on every call, a later request with
    // a readable token is unaffected (no cached "missing" state).
    if (raw.csrfMissing) {
      throw new MissingCsrfTokenError(method, req.path);
    }

    // Classify in Node using the shared helpers (they cannot run in the page).
    const isLoginRedirect =
      raw.redirected || raw.status === 401 || looksLikeLoginHtml(raw.text);
    const json = tryParseJson(raw.text);

    return {
      ok: raw.status >= 200 && raw.status < 300,
      status: raw.status,
      json,
      isLoginRedirect,
    };
  }
}

/**
 * Detect Playwright/Chromium's "profile already in use" launch failure. Used to
 * recognize losing the startup race so we re-attach instead of crashing.
 */
function isProfileInUseError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return PROFILE_IN_USE_MARKERS.some((marker) => message.includes(marker));
}

/**
 * Build the default filesystem-backed {@link EndpointFileIo} for a profile dir.
 * The handshake lives at `${userDataDir}/cdp-endpoint.json`; it is written with
 * owner-only permissions and inherits the profile dir's restricted access.
 */
function createFsEndpointFileIo(userDataDir: string): EndpointFileIo {
  const path = join(userDataDir, CDP_ENDPOINT_FILENAME);
  return {
    read: async () => {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: string }).code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { wsEndpoint?: unknown }).wsEndpoint !== "string"
      ) {
        // Malformed content is treated as absent by the caller.
        throw new Error("CDP endpoint handshake file is malformed.");
      }
      return parsed as CdpEndpointInfo;
    },
    write: async (info) => {
      await writeFile(path, JSON.stringify(info), { mode: ENDPOINT_FILE_MODE });
    },
    remove: async () => {
      await rm(path, { force: true });
    },
  };
}

/**
 * Default {@link SessionManagerDeps.resolveWsEndpoint}: read the CDP ws URL from
 * the loopback DevTools JSON endpoint (`http://<host>:<port>/json/version`,
 * field `webSocketDebuggerUrl`). Bounded by a short abort timeout so a
 * non-responsive port does not stall startup. Returns `undefined` on any
 * failure (the caller then skips publishing the handshake).
 */
async function defaultResolveWsEndpoint(
  host: string,
  port: number,
): Promise<string | undefined> {
  const url = `http://${host}:${port}/json/version`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      return undefined;
    }
    const body = (await resp.json()) as { webSocketDebuggerUrl?: unknown };
    const ws = body.webSocketDebuggerUrl;
    return typeof ws === "string" && ws.length > 0 ? ws : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort extraction of the authenticated username from a
 * `services/authentication/current-context` JSON body. Splunk shapes this as
 * `{ entry: [ { content: { username, roles } } ] }`. Returns `undefined` when
 * the field is absent or the body is not the expected shape — a healthy probe
 * does not require a discoverable username (the type allows it to be omitted).
 *
 * This never throws and never reads or returns any secret value.
 */
function extractUsername(json: unknown): string | undefined {
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
  const username = (content as { username?: unknown }).username;
  return typeof username === "string" && username.length > 0
    ? username
    : undefined;
}
