# Splunk MCP Server

A self-contained Node.js [MCP](https://modelcontextprotocol.io) server that runs
Splunk searches and reads results against a Splunk Cloud deployment where API
tokens are disabled and the only auth path is interactive Microsoft Entra
(Azure AD) SSO + MFA.

Instead of a token, the server drives an **authenticated browser session**: a
human logs in once through a Playwright-managed Chromium browser, and the server
reuses that session to call Splunk's REST layer via the in-page fetch model
(same-origin `fetch` executed inside the authenticated page, so the `HttpOnly`
session cookie is attached automatically).

See `.kiro/specs/splunk-mcp-server/` for the full requirements and design.

## Requirements

- Node.js 20 or newer
- Chromium (installed automatically via Playwright — see below)

## Install

```bash
npm install
```

`npm install` runs a `postinstall` step that downloads the Chromium browser
binary via `playwright install chromium`. This gives a "just works" setup on
machines with normal network access.

### Restricted-network fallback

If your environment blocks network access during `postinstall` (common in
locked-down corporate setups), the Chromium download will be skipped or fail.
Install the browser explicitly afterwards with:

```bash
npx playwright install chromium
```

You can also re-run it any time via the provided script:

```bash
npm run install:chromium
```

If Chromium is still missing when the server starts, it exits with a clear
error telling you to run `npx playwright install chromium` rather than failing
deep inside the browser launch.

## Build

```bash
npm run build      # compile TypeScript -> dist/
npm run typecheck  # type-check without emitting
```

## Test

Tests run once (single-execution mode), never in watch mode:

```bash
npm test
```

(Watch mode is available for local development via `npm run test:watch`.)

## Run

```bash
npm start          # runs dist/server.js over the MCP stdio transport
```

### Configuration

The server is configured entirely through environment variables (no config
files). All values have documented defaults except where noted; see the design
document for the full list. Example MCP client (`mcp.json`) entry:

```json
{
  "mcpServers": {
    "splunk": {
      "command": "node",
      "args": ["<path>/dist/server.js"],
      "env": {
        "SPLUNK_BASE_URL": "https://hoopp.splunkcloud.com",
        "SPLUNK_APP": "search"
      }
    }
  }
}
```

## Security note

The persistent browser profile (user-data-dir) holds a **live authenticated
session** and is as sensitive as being logged in. It is stored per-user with
owner-only permissions. Use the logout path to clear it.
