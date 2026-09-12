import { describe, it, expect } from "vitest";
import {
  ensureChromiumInstalled,
  ChromiumMissingError,
  CHROMIUM_INSTALL_HINT,
} from "./startup-guard.js";

describe("ensureChromiumInstalled", () => {
  it("resolves when the resolver returns a path that exists", async () => {
    await expect(
      ensureChromiumInstalled(
        async () => "/fake/path/to/chromium",
        () => true,
      ),
    ).resolves.toBeUndefined();
  });

  it("throws ChromiumMissingError when no path is resolved", async () => {
    await expect(
      ensureChromiumInstalled(
        async () => undefined,
        () => true,
      ),
    ).rejects.toBeInstanceOf(ChromiumMissingError);
  });

  it("throws ChromiumMissingError when the resolved path does not exist", async () => {
    await expect(
      ensureChromiumInstalled(
        async () => "/fake/path/to/chromium",
        () => false,
      ),
    ).rejects.toBeInstanceOf(ChromiumMissingError);
  });

  it("carries the install hint and is marked non-retryable", () => {
    const err = new ChromiumMissingError();
    expect(err.message).toBe(CHROMIUM_INSTALL_HINT);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("ChromiumMissingError");
  });
});
