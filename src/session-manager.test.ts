/**
 * Tests for the single-instance browser-reuse behavior of {@link SessionManager}
 * (Option A from ANALYSIS-single-instance-reuse.md): attach-first /
 * launch-on-miss `launch()`, the startup race fallback, and ownership-aware
 * `close()`.
 *
 * All Playwright and filesystem interactions are exercised through the
 * injectable {@link SessionManagerDeps} seams (launchPersistentContext,
 * connectOverCDP, endpointFile, resolveWsEndpoint), so no real browser,
 * network, or profile directory is touched.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Browser, BrowserContext, Page } from "playwright";

import type { Config } from "./config.js";
import { TransportError } from "./errors.js";
import {
  MissingCsrfTokenError,
  SessionManager,
  type CdpEndpointInfo,
  type EndpointFileIo,
} from "./session-manager.js";

// ---------------------------------------------------------------------------
// Minimal fakes for the Playwright surfaces SessionManager touches.
// ---------------------------------------------------------------------------

interface FakePage {
  url: () => string;
  goto: ReturnType<typeof vi.fn>;
  /** Liveness signal read by SessionManager.isBrowserLive/fetchJsonUnqueued. */
  isClosed: () => boolean;
  /** In-page fetch seam; controllable so tests can simulate transport failure. */
  evaluate: ReturnType<typeof vi.fn>;
  /** Mark this fake page closed so isClosed() reports it as dead. */
  _markClosed: () => void;
}

/**
 * Build a fake Page. Defaults to "live" (not closed) and an `evaluate` that
 * returns a healthy 200/JSON raw fetch result, so existing tests are
 * unaffected. Pass `evaluate` to control the in-page fetch result per test.
 */
function makePage(
  url: string,
  evaluate?: ReturnType<typeof vi.fn>,
): FakePage {
  let closed = false;
  return {
    url: () => url,
    goto: vi.fn(async () => null),
    isClosed: () => closed,
    evaluate:
      evaluate ??
      vi.fn(async () => ({
        status: 200,
        redirected: false,
        text: "{}",
        csrfMissing: false,
      })),
    _markClosed: () => {
      closed = true;
    },
  };
}

interface FakeContextOptions {
  pages?: FakePage[];
  browser?: FakeBrowser;
}

interface FakeContext {
  pages: () => FakePage[];
  newPage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  browser: () => FakeBrowser | null;
}

function makeContext(opts: FakeContextOptions = {}): FakeContext {
  const pages = opts.pages ?? [];
  return {
    pages: () => pages,
    newPage: vi.fn(async () => {
      const p = makePage("about:blank");
      pages.push(p);
      return p;
    }),
    close: vi.fn(async () => undefined),
    browser: () => opts.browser ?? null,
  };
}

interface FakeBrowser {
  contexts: () => FakeContext[];
  close: ReturnType<typeof vi.fn>;
  wsEndpoint?: () => string;
  /** Connection liveness read by SessionManager.isBrowserLive. */
  isConnected: () => boolean;
  /** Mark this fake browser disconnected so isConnected() reports it dead. */
  _markDisconnected: () => void;
}

function makeBrowser(contexts: FakeContext[], wsEndpoint?: string): FakeBrowser {
  let connected = true;
  const browser: FakeBrowser = {
    contexts: () => contexts,
    close: vi.fn(async () => undefined),
    isConnected: () => connected,
    _markDisconnected: () => {
      connected = false;
    },
  };
  if (wsEndpoint !== undefined) {
    browser.wsEndpoint = () => wsEndpoint;
  }
  return browser;
}

// ---------------------------------------------------------------------------
// Config + endpoint-file helpers.
// ---------------------------------------------------------------------------

const BASE_URL = "https://splunk.example.com";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: BASE_URL,
    app: "search",
    defaultEarliest: "-15m",
    defaultLatest: "now",
    defaultCount: 100,
    pollIntervalMs: 750,
    maxWaitMs: 120000,
    autoAsyncThresholdMs: 3000,
    userDataDir: "/tmp/does-not-matter",
    headful: true,
    cdpPort: 9223,
    cdpHost: "127.0.0.1",
    ...overrides,
  };
}

/** An in-memory {@link EndpointFileIo} with spy-able operations. */
function makeEndpointFile(initial?: CdpEndpointInfo): {
  io: EndpointFileIo;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  current: () => CdpEndpointInfo | undefined;
} {
  let store: CdpEndpointInfo | undefined = initial;
  const read = vi.fn(async () => store);
  const write = vi.fn(async (info: CdpEndpointInfo) => {
    store = info;
  });
  const remove = vi.fn(async () => {
    store = undefined;
  });
  return {
    io: { read, write, remove },
    read,
    write,
    remove,
    current: () => store,
  };
}

const originPage = () => makePage(`${BASE_URL}/en-US/app/search/search`);

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** A real temp profile dir so the owner path's prepareUserDataDir succeeds. */
async function makeTempUserDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "smcp-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("SessionManager launch(): attach-first / launch-on-miss", () => {
  it("attaches to an existing browser when a handshake is present (no launch)", async () => {
    const page = originPage();
    const context = makeContext({ pages: [page] });
    const browser = makeBrowser([context]);
    const endpoint = makeEndpointFile({
      wsEndpoint: "ws://127.0.0.1:9223/devtools/browser/abc",
      port: 9223,
      pid: 111,
      startedAt: new Date().toISOString(),
    });

    const launchPersistentContext = vi.fn();
    const connectOverCDP = vi.fn(async () => browser as unknown as Browser);

    const session = new SessionManager(makeConfig(), {
      ensureChromium: async () => undefined,
      launchPersistentContext:
        launchPersistentContext as never,
      connectOverCDP: connectOverCDP as never,
      endpointFile: endpoint.io,
    });

    await session.launch();

    expect(connectOverCDP).toHaveBeenCalledTimes(1);
    expect(launchPersistentContext).not.toHaveBeenCalled();
    // Attached (non-owning): close disconnects the browser, not the context.
    await session.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
    // Handshake file is left intact for the owner.
    expect(endpoint.remove).not.toHaveBeenCalled();
    expect(endpoint.current()).toBeDefined();
  });

  it("opens an origin page on attach when none is already present", async () => {
    const offOrigin = makePage("https://other.example.com/");
    const context = makeContext({ pages: [offOrigin] });
    const browser = makeBrowser([context]);
    const endpoint = makeEndpointFile({
      wsEndpoint: "ws://127.0.0.1:9223/devtools/browser/abc",
      port: 9223,
      pid: 111,
      startedAt: new Date().toISOString(),
    });

    const session = new SessionManager(makeConfig(), {
      ensureChromium: async () => undefined,
      connectOverCDP: (async () => browser as unknown as Browser) as never,
      endpointFile: endpoint.io,
    });

    await session.launch();
    // A new page was opened and navigated to the Splunk start URL.
    expect(context.newPage).toHaveBeenCalledTimes(1);
  });

  it("launches an owner when no handshake exists, passing the CDP port arg and writing the handshake", async () => {
    const userDataDir = await makeTempUserDataDir();
    const page = makePage("about:blank");
    const context = makeContext({ pages: [page] });
    const endpoint = makeEndpointFile(undefined);

    const launchPersistentContext = vi.fn(
      async () => context as unknown as BrowserContext,
    );
    const connectOverCDP = vi.fn();
    const resolveWsEndpoint = vi.fn(
      async () => "ws://127.0.0.1:9223/devtools/browser/xyz",
    );

    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      launchPersistentContext: launchPersistentContext as never,
      connectOverCDP: connectOverCDP as never,
      endpointFile: endpoint.io,
      resolveWsEndpoint: resolveWsEndpoint as never,
    });

    await session.launch();

    expect(connectOverCDP).not.toHaveBeenCalled();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    const [dirArg, optsArg] = launchPersistentContext.mock.calls[0]!;
    expect(dirArg).toBe(userDataDir);
    expect(optsArg).toMatchObject({ headless: false });
    expect(optsArg.args).toContain("--remote-debugging-port=9223");
    // Handshake published for later processes to attach.
    expect(endpoint.write).toHaveBeenCalledTimes(1);
    expect(endpoint.current()).toMatchObject({
      wsEndpoint: "ws://127.0.0.1:9223/devtools/browser/xyz",
      port: 9223,
      pid: process.pid,
    });

    // Owner: close tears down the context AND removes the handshake.
    await session.close();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(endpoint.remove).toHaveBeenCalled();
    expect(endpoint.current()).toBeUndefined();
  });

  it("treats a stale handshake (connect fails) as a miss: removes the file and launches an owner", async () => {
    const userDataDir = await makeTempUserDataDir();
    const context = makeContext({ pages: [makePage("about:blank")] });
    const endpoint = makeEndpointFile({
      wsEndpoint: "ws://127.0.0.1:9223/devtools/browser/dead",
      port: 9223,
      pid: 999,
      startedAt: new Date().toISOString(),
    });

    const connectOverCDP = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const launchPersistentContext = vi.fn(
      async () => context as unknown as BrowserContext,
    );

    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      connectOverCDP: connectOverCDP as never,
      launchPersistentContext: launchPersistentContext as never,
      endpointFile: endpoint.io,
      resolveWsEndpoint: (async () => undefined) as never,
      connectTimeoutMs: 50,
    });

    await session.launch();

    expect(connectOverCDP).toHaveBeenCalledTimes(1);
    // Stale file removed before launching the owner.
    expect(endpoint.remove).toHaveBeenCalled();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  it("startup race: re-reads the handshake and attaches when the owner launch loses the profile lock", async () => {
    const userDataDir = await makeTempUserDataDir();
    const attachedPage = originPage();
    const attachedContext = makeContext({ pages: [attachedPage] });
    const attachedBrowser = makeBrowser([attachedContext]);

    // Endpoint file starts empty (first read = miss), then the winning process
    // "writes" it just before our launch throws the profile-lock error.
    const endpoint = makeEndpointFile(undefined);

    const launchPersistentContext = vi.fn(async () => {
      // Simulate: the race winner published the handshake moments before we
      // hit the lock.
      await endpoint.io.write({
        wsEndpoint: "ws://127.0.0.1:9223/devtools/browser/winner",
        port: 9223,
        pid: 222,
        startedAt: new Date().toISOString(),
      });
      throw new Error(
        "browserType.launchPersistentContext: Opening in existing browser session.",
      );
    });
    const connectOverCDP = vi.fn(
      async () => attachedBrowser as unknown as Browser,
    );

    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      launchPersistentContext: launchPersistentContext as never,
      connectOverCDP: connectOverCDP as never,
      endpointFile: endpoint.io,
    });

    await session.launch();

    // Launch was attempted (lost the race), then we attached to the winner.
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(connectOverCDP).toHaveBeenCalledTimes(1);

    // Now an attached (non-owning) session: close disconnects only.
    await session.close();
    expect(attachedBrowser.close).toHaveBeenCalledTimes(1);
    expect(attachedContext.close).not.toHaveBeenCalled();
    // The winner's handshake is left intact.
    expect(endpoint.current()).toBeDefined();
  });

  it("throws a clear error when the profile is busy and re-attach also fails", async () => {
    const userDataDir = await makeTempUserDataDir();
    const endpoint = makeEndpointFile(undefined); // stays empty → re-attach miss

    const launchPersistentContext = vi.fn(async () => {
      throw new Error("Opening in existing browser session.");
    });

    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      launchPersistentContext: launchPersistentContext as never,
      connectOverCDP: (async () => {
        throw new Error("should not be called");
      }) as never,
      endpointFile: endpoint.io,
    });

    await expect(session.launch()).rejects.toThrow(/already in use/i);
  });

  it("launch() is idempotent once attached/launched", async () => {
    const page = originPage();
    const context = makeContext({ pages: [page] });
    const browser = makeBrowser([context]);
    const endpoint = makeEndpointFile({
      wsEndpoint: "ws://127.0.0.1:9223/devtools/browser/abc",
      port: 9223,
      pid: 111,
      startedAt: new Date().toISOString(),
    });
    const connectOverCDP = vi.fn(async () => browser as unknown as Browser);

    const session = new SessionManager(makeConfig(), {
      ensureChromium: async () => undefined,
      connectOverCDP: connectOverCDP as never,
      endpointFile: endpoint.io,
    });

    await session.launch();
    await session.launch();
    expect(connectOverCDP).toHaveBeenCalledTimes(1);
  });

  it("close() is safe to call more than once", async () => {
    const userDataDir = await makeTempUserDataDir();
    const context = makeContext({ pages: [makePage("about:blank")] });
    const endpoint = makeEndpointFile(undefined);
    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      launchPersistentContext: (async () =>
        context as unknown as BrowserContext) as never,
      endpointFile: endpoint.io,
      resolveWsEndpoint: (async () =>
        "ws://127.0.0.1:9223/devtools/browser/xyz") as never,
    });

    await session.launch();
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Self-healing recovery: a dead/wedged browser is transparently re-attached or
// relaunched before the next request, which is then retried exactly once.
// ---------------------------------------------------------------------------

/**
 * An `evaluate` seam returning a healthy 200/JSON raw fetch result — the shape
 * fetchJsonUnqueued expects back from `page.evaluate`.
 */
function healthyEvaluate(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    status: 200,
    redirected: false,
    text: "{}",
    csrfMissing: false,
  }));
}

describe("SessionManager self-healing recovery", () => {
  it("recovers by relaunching when the page has closed", async () => {
    const userDataDir = await makeTempUserDataDir();

    // First owner page: healthy fetch, but we mark it closed after launch to
    // simulate the window being closed/crashing.
    const deadPage = makePage(`${BASE_URL}/en-US/app/search/search`);
    const deadContext = makeContext({ pages: [deadPage] });

    // Second (recovered) owner page: a fresh live page that answers healthily.
    const livePage = makePage(`${BASE_URL}/en-US/app/search/search`);
    const liveContext = makeContext({ pages: [livePage] });

    const launchPersistentContext = vi
      .fn()
      .mockResolvedValueOnce(deadContext as unknown as BrowserContext)
      .mockResolvedValueOnce(liveContext as unknown as BrowserContext);
    // No handshake ever present → recovery relaunches (owner path).
    const endpoint = makeEndpointFile(undefined);
    const connectOverCDP = vi.fn();

    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      launchPersistentContext: launchPersistentContext as never,
      connectOverCDP: connectOverCDP as never,
      endpointFile: endpoint.io,
      resolveWsEndpoint: (async () => undefined) as never,
    });

    await session.launch();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);

    // Window closes: the primary page is now dead.
    deadPage._markClosed();

    const resp = await session.fetchJson({ method: "GET", path: "x" });

    expect(resp.status).toBe(200);
    // Re-acquisition relaunched a fresh owner (no CDP handshake to attach to).
    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(connectOverCDP).not.toHaveBeenCalled();
    // The recovered live page served the retried call.
    expect(livePage.evaluate).toHaveBeenCalledTimes(1);
  });

  it("recovers by re-attaching when a handshake is present", async () => {
    // Owner launches first, then the page dies; a handshake exists so recovery
    // attaches over CDP rather than relaunching.
    const userDataDir = await makeTempUserDataDir();

    const deadPage = makePage(`${BASE_URL}/en-US/app/search/search`);
    const deadContext = makeContext({ pages: [deadPage] });

    const attachedPage = makePage(`${BASE_URL}/en-US/app/search/search`);
    const attachedContext = makeContext({ pages: [attachedPage] });
    const attachedBrowser = makeBrowser([attachedContext]);

    const endpoint = makeEndpointFile(undefined);
    const launchPersistentContext = vi.fn(
      async () => deadContext as unknown as BrowserContext,
    );
    const connectOverCDP = vi.fn(
      async () => attachedBrowser as unknown as Browser,
    );

    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      launchPersistentContext: launchPersistentContext as never,
      connectOverCDP: connectOverCDP as never,
      endpointFile: endpoint.io,
      // Owner launch publishes a handshake; recovery then reads it and attaches.
      resolveWsEndpoint: (async () =>
        "ws://127.0.0.1:9223/devtools/browser/live") as never,
    });

    await session.launch();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    // A handshake was published by the owner launch.
    expect(endpoint.current()).toBeDefined();

    // Window dies.
    deadPage._markClosed();

    const resp = await session.fetchJson({ method: "GET", path: "x" });

    expect(resp.status).toBe(200);
    // Recovery attached over CDP (handshake present) rather than relaunching.
    expect(connectOverCDP).toHaveBeenCalledTimes(1);
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(attachedPage.evaluate).toHaveBeenCalledTimes(1);

    // Attached (non-owning): close disconnects, never tears down the context.
    await session.close();
    expect(attachedBrowser.close).toHaveBeenCalledTimes(1);
    expect(attachedContext.close).not.toHaveBeenCalled();
  });

  it("retries a transport failure exactly once, then rejects", async () => {
    const userDataDir = await makeTempUserDataDir();

    // A live page whose evaluate always throws → a persistent transport error.
    const failingEvaluate = vi.fn(async () => {
      throw new Error("browser automation exploded");
    });
    const page = makePage(
      `${BASE_URL}/en-US/app/search/search`,
      failingEvaluate,
    );
    const context = makeContext({ pages: [page] });

    const launchPersistentContext = vi.fn(
      async () => context as unknown as BrowserContext,
    );
    const endpoint = makeEndpointFile(undefined);

    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      launchPersistentContext: launchPersistentContext as never,
      endpointFile: endpoint.io,
      resolveWsEndpoint: (async () => undefined) as never,
    });

    await session.launch();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);

    await expect(
      session.fetchJson({ method: "GET", path: "x" }),
    ).rejects.toThrow(TransportError);

    // Exactly two attempts: the original + one retry. Not a loop.
    expect(failingEvaluate).toHaveBeenCalledTimes(2);
    // The page stayed live throughout (isClosed false), so recovery did not
    // relaunch — acquisition was bounded to the initial launch.
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  it("does not recover or retry on a non-transport error", async () => {
    const userDataDir = await makeTempUserDataDir();

    // Simulate a state-changing request with no readable CSRF token: the
    // in-page fetch reports csrfMissing, which fetchJsonUnqueued maps to a
    // MissingCsrfTokenError (not a transport failure).
    const csrfMissingEvaluate = vi.fn(async () => ({
      status: 0,
      redirected: false,
      text: "",
      csrfMissing: true,
    }));
    const page = makePage(
      `${BASE_URL}/en-US/app/search/search`,
      csrfMissingEvaluate,
    );
    const context = makeContext({ pages: [page] });

    const launchPersistentContext = vi.fn(
      async () => context as unknown as BrowserContext,
    );
    const endpoint = makeEndpointFile(undefined);

    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      launchPersistentContext: launchPersistentContext as never,
      endpointFile: endpoint.io,
      resolveWsEndpoint: (async () => undefined) as never,
    });

    await session.launch();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);

    await expect(
      session.fetchJson({ method: "POST", path: "x", body: { a: "b" } }),
    ).rejects.toThrow(MissingCsrfTokenError);

    // No retry for a non-transport error.
    expect(csrfMissingEvaluate).toHaveBeenCalledTimes(1);
    // No re-acquisition.
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  it("live browser is a no-op: a normal request does not re-acquire", async () => {
    const userDataDir = await makeTempUserDataDir();

    const page = makePage(`${BASE_URL}/en-US/app/search/search`);
    const context = makeContext({ pages: [page] });

    const launchPersistentContext = vi.fn(
      async () => context as unknown as BrowserContext,
    );
    const connectOverCDP = vi.fn();
    const endpoint = makeEndpointFile(undefined);

    const session = new SessionManager(makeConfig({ userDataDir }), {
      ensureChromium: async () => undefined,
      launchPersistentContext: launchPersistentContext as never,
      connectOverCDP: connectOverCDP as never,
      endpointFile: endpoint.io,
      resolveWsEndpoint: (async () => undefined) as never,
    });

    await session.launch();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);

    const resp = await session.fetchJson({ method: "GET", path: "x" });
    expect(resp.status).toBe(200);

    // Live fast-path: ensureLive did not re-acquire.
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(connectOverCDP).not.toHaveBeenCalled();
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});
