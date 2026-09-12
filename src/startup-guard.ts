/**
 * Startup guard: verifies that the Chromium browser binary required by
 * Playwright is present before the server attempts to launch a browser
 * context.
 *
 * Requirements:
 * - 17.4: IF the Chromium browser binary is not present when the server
 *   starts, THEN the server SHALL return an error indicating Chromium must be
 *   installed and SHALL NOT proceed to launch the browser context.
 *
 * This is a stub in task 1.1. It is wired into the server entrypoint in task
 * 6.2 (`src/server.ts`), which calls `ensureChromiumInstalled()` before
 * constructing the `SessionManager`.
 */

import { existsSync } from "node:fs";

/**
 * The documented remediation shown to the user when Chromium is missing. The
 * postinstall step (`playwright install chromium`) normally installs it; the
 * `npx` form is the fallback for restricted networks (Requirement 17.3).
 */
export const CHROMIUM_INSTALL_HINT =
  "Chromium is not installed. Run `npx playwright install chromium` " +
  "(or reinstall dependencies to trigger the postinstall step).";

/**
 * Error raised when the Chromium binary cannot be located. Thrown by the
 * startup guard so the server can surface a clear, actionable message instead
 * of a low-level Playwright launch failure.
 */
export class ChromiumMissingError extends Error {
  override readonly name = "ChromiumMissingError";
  /** This condition is not retryable without installing Chromium. */
  readonly retryable = false;

  constructor(message: string = CHROMIUM_INSTALL_HINT) {
    super(message);
  }
}

/**
 * Resolve the filesystem path to the Chromium executable that Playwright would
 * launch. Returns `undefined` when Playwright cannot resolve a path (e.g. the
 * browsers were never installed).
 *
 * Isolated so tests can exercise `ensureChromiumInstalled` against a stubbed
 * resolver without importing Playwright.
 */
export async function resolveChromiumExecutablePath(): Promise<
  string | undefined
> {
  try {
    const { chromium } = await import("playwright");
    const execPath = chromium.executablePath();
    return execPath && execPath.length > 0 ? execPath : undefined;
  } catch {
    // Playwright not available / unable to resolve a path.
    return undefined;
  }
}

/**
 * Verify the Chromium binary is present. Throws {@link ChromiumMissingError}
 * when the binary cannot be found so the caller (server entrypoint) can abort
 * startup before launching a browser context.
 *
 * @param resolver - Injectable path resolver (defaults to Playwright's
 *   `chromium.executablePath()`); overridable in tests.
 * @param fileExists - Injectable existence check (defaults to `fs.existsSync`).
 */
export async function ensureChromiumInstalled(
  resolver: () => Promise<string | undefined> = resolveChromiumExecutablePath,
  fileExists: (p: string) => boolean = existsSync,
): Promise<void> {
  const execPath = await resolver();
  if (!execPath || !fileExists(execPath)) {
    throw new ChromiumMissingError();
  }
}
