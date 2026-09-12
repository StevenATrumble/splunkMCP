import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Single-execution by default; `npm test` runs `vitest run` (never watch mode).
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
