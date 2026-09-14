/**
 * Package entry surface for the Splunk MCP Server.
 *
 * The runnable MCP stdio entrypoint lives in `src/server.ts` (its `main` is
 * re-exported below for testability). This module re-exports the public surface
 * of every component so the package API is reachable and nothing is orphaned.
 */

export {
  ensureChromiumInstalled,
  resolveChromiumExecutablePath,
  ChromiumMissingError,
  CHROMIUM_INSTALL_HINT,
} from "./startup-guard.js";

export type {
  SearchArgs,
  SearchOutcome,
  ResultPage,
  JobStatus,
  CancelResult,
  CurrentContext,
  ServerInfo,
  SplunkMessage,
  RawRestRequest,
  RawRestResponse,
  SessionHealth,
  PageArgs,
} from "./types.js";

export { loadConfig, ConfigError } from "./config.js";

export type { Config, EnvSource } from "./config.js";

export {
  SplunkMcpError,
  SessionExpiredError,
  SearchError,
  PermissionError,
  ThrottledError,
  TimeoutError,
  TransportError,
  ValidationError,
  NoDataResult,
  isSplunkMcpError,
  SESSION_EXPIRED_HINT,
} from "./errors.js";

export {
  encodeForm,
  normalizeSpl,
  clamp,
  looksLikeLoginHtml,
  tryParseJson,
  form,
} from "./util.js";

export type { ExecMode } from "./util.js";

export {
  Logger,
  logger,
  redactString,
  redactValue,
  REDACTED,
  REDACTED_PAYLOAD,
} from "./log.js";

export type { LogLevel, LogContext, LoggerOptions } from "./log.js";

export { SessionManager, UserDataDirPermissionError } from "./session-manager.js";

export { MissingCsrfTokenError } from "./session-manager.js";

export type {
  SessionManagerDeps,
  LaunchPersistentContext,
  ConnectOverCdp,
  EndpointFileIo,
  CdpEndpointInfo,
} from "./session-manager.js";

export {
  SplunkClient,
  normalize,
  resolveMode,
  HARD_RESULT_CEILING,
} from "./splunk-client.js";

export type { ResolvedMode } from "./splunk-client.js";

export { createToolRouter, SERVER_INFO } from "./tool-router.js";

export { main } from "./server.js";
