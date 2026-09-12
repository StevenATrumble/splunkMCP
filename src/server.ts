#!/usr/bin/env node
/**
 * Runnable MCP stdio entrypoint for the Splunk MCP Server (task 6.2).
 *
 * This module is the CLI the MCP client launches (`node dist/server.js`, or the
 * `splunk-mcp-server` bin). It wires together every component built in tasks
 * 2–5 so nothing is orphaned:
 *
 *   loadConfig (config.ts)
 *        │
 *        ▼
 *   SessionManager (session-manager.ts) ──▶ SplunkClient (splunk-client.ts)
 *        │                                        │
 *        │                                        ▼
 *        │                              createToolRouter (tool-router.ts) ──▶ McpServer
 *        ▼                                        │
 *   Chromium startup guard (startup-guard.ts)     ▼
 *                                          StdioServerTransport (MCP SDK)
 *
 * Startup order and the guarantees it provides:
 * 1. {@link loadConfig} — a {@link ConfigError} (invalid/missing config) is
 *    logged to stderr and the process exits non-zero, refusing to start
 *    (Requirements 13.3, 13.5).
 * 2. {@link ensureChromiumInstalled} — a {@link ChromiumMissingError} is logged
 *    to stderr with the install hint and the process exits non-zero WITHOUT
 *    launching a browser context (Requirement 17.4). `SessionManager.launch`
 *    also guards this, but the explicit early check yields a clear message.
 * 3. Construct the {@link SessionManager} and {@link SplunkClient}, and register
 *    the six tools via {@link createToolRouter}.
 * 4. Launch the persistent browser context (see the launch-timing note below).
 * 5. Connect the {@link StdioServerTransport} and start serving over stdio
 *    (Requirement 17.5).
 *
 * IMPORTANT — stdout is reserved for the MCP transport (Requirement 17.5). All
 * diagnostics go through the redaction-aware {@link logger}, which writes to
 * stderr. Nothing here writes to stdout directly.
 *
 * Launch-timing decision: the browser context is launched eagerly at startup
 * (`session.launch()`), but interactive LOGIN stays on-demand. `launch()` only
 * opens the persistent Chromium context and navigates the single primary page
 * to the Splunk origin — it does not drive SSO/MFA. This is necessary because
 * `SplunkClient`'s REST methods call `session.fetchJson`, which requires a live
 * primary page; if the context were not launched, the very first tool call
 * would fail with a transport error ("Browser page is not available"). Session
 * health and re-login are handled per-operation: state-changing calls flow
 * through `postWithSessionGuard`, which probes for a login redirect / 401 and
 * drives the MyApps → Splunk-tile login flow exactly when a dead session is
 * detected. The persistent user-data-dir means re-auth is usually silent.
 *
 * Requirements: 13.3, 13.5, 17.4, 17.5.
 */

import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
import { logger } from "./log.js";
import { SessionManager } from "./session-manager.js";
import { SplunkClient } from "./splunk-client.js";
import { ChromiumMissingError, ensureChromiumInstalled } from "./startup-guard.js";
import { createToolRouter } from "./tool-router.js";

/**
 * Bring up the server: load and validate config, verify Chromium, wire the
 * components, launch the browser context, and start serving MCP over stdio.
 *
 * On a fatal startup condition (invalid/missing config or a missing Chromium
 * binary), the reason is logged to stderr and the process exits non-zero; the
 * server never proceeds to serve in that case (Requirements 13.3, 13.5, 17.4).
 *
 * @returns A resolved promise once the transport is connected and serving. The
 *   process then stays alive on the stdio transport until it is closed or a
 *   shutdown signal is received.
 */
export async function main(): Promise<void> {
  // 1. Config first (Req 13.3, 13.5): a bad/missing config refuses to start.
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("Invalid configuration; refusing to start.", {
        reason: error.message,
      });
    } else {
      logger.error("Unexpected error loading configuration; refusing to start.", {
        error,
      });
    }
    process.exitCode = 1;
    return;
  }

  // 2. Chromium presence (Req 17.4): fail early and clearly before launching a
  //    browser context. SessionManager.launch guards this too, but checking here
  //    gives an actionable message up front.
  try {
    await ensureChromiumInstalled();
  } catch (error) {
    if (error instanceof ChromiumMissingError) {
      logger.error(error.message);
    } else {
      logger.error("Failed to verify the Chromium installation; refusing to start.", {
        error,
      });
    }
    process.exitCode = 1;
    return;
  }

  // 3. Construct the session + client and register the six tools. Every
  //    component from tasks 2–5 is reachable from here (no orphans).
  const session = new SessionManager(config);
  const client = new SplunkClient(session, config);
  const server = createToolRouter(client);

  // Graceful shutdown wiring is installed before launching anything so an early
  // SIGINT still tears the browser down cleanly.
  installShutdownHandlers(session, server);

  // 4. Launch the persistent browser context (NOT login). This opens the
  //    Chromium context and navigates the primary page to the Splunk origin so
  //    the client's in-page fetch works; login stays on-demand. A missing
  //    Chromium binary or an unsecurable user-data-dir aborts startup cleanly.
  try {
    await session.launch();
  } catch (error) {
    logger.error("Failed to launch the browser session; refusing to start.", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Best-effort cleanup of any partially-created context.
    await session.close().catch(() => {
      /* ignore secondary teardown failures */
    });
    process.exitCode = 1;
    return;
  }

  // 5. Serve over stdio (Req 17.5). stdout belongs to the transport; all logs
  //    go to stderr via the redaction-aware logger.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("Splunk MCP Server is serving over stdio.", {
    baseUrl: config.baseUrl,
    app: config.app,
  });
}

/**
 * Install process-level signal and error handlers for a graceful shutdown.
 *
 * On SIGINT/SIGTERM the MCP server connection is closed and the browser context
 * is torn down before the process exits. Unhandled rejections and uncaught
 * exceptions are logged to stderr (never stdout) so a crash still surfaces a
 * diagnostic through the redaction-aware logger.
 *
 * @param session - The {@link SessionManager} whose browser context to close.
 * @param server - The connected MCP server to close.
 */
function installShutdownHandlers(
  session: SessionManager,
  server: ReturnType<typeof createToolRouter>,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("Shutting down.", { signal });
    // Close the transport/server first so no new tool calls are dispatched,
    // then release the browser. Both are best-effort — a teardown failure must
    // not prevent the process from exiting.
    await server.close().catch((error: unknown) => {
      logger.warn("Error closing the MCP server during shutdown.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await session.close().catch((error: unknown) => {
      logger.warn("Error closing the browser session during shutdown.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled promise rejection.", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on("uncaughtException", (error: unknown) => {
    logger.error("Uncaught exception.", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Detect whether this module is being executed directly as the process
 * entrypoint (as opposed to imported by a test). Compares the resolved module
 * URL against the CLI entry (`process.argv[1]`), which is robust for the ESM
 * `node dist/server.js` invocation.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    // pathToFileURL normalizes OS path separators (Windows backslashes) and
    // drive letters into a canonical file:// URL for a reliable comparison.
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

// Run only when invoked as the entrypoint, so tests can import `main` without
// starting the server. A rejection from `main` (that its own try/catch did not
// handle) is logged to stderr and the process exits non-zero.
if (isMainModule()) {
  main().catch((error: unknown) => {
    logger.error("Fatal error during startup.", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
