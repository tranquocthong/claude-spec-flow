/**
 * ai-hybrid.cjs — AI operation dispatcher (strangler-fig sub 4/5).
 *
 * Delegates to AIRouter (lib/ai-router.cjs) which implements the full routing
 * logic: aiMode validation, host detection, agent-native emit, and headless
 * fallback. This file is the stable dispatch surface that engine-router.cjs
 * requires (design decision D4, SD §6.3).
 *
 * Execution order:
 *   1. Load config via ai-config.cjs (respects _configFile injection for tests).
 *   2. Build params from args (forward inputContent, tag, context, and all args).
 *   3. Delegate to AIRouter.route(operation, params, config, _inject).
 *
 * The ERR_AI_HOST_REQUIRED error still surfaces from AIRouter (no host + no
 * fallback), so engine-router's existing error-envelope wrapping is unchanged.
 *
 * Public API (stable — engine-router calls dispatch()):
 *   dispatch(operation, args)    → Promise<result>   — primary entry (engine-router)
 *   executeAiOp(operation, args) → Promise<result>   — alias (legacy / direct callers)
 *   _validateArgs(operation, args)                   — exported for direct unit testing
 *
 * _inject usage (passed as args._inject):
 *   { _env }    — override env for host detection (deterministic tests, D2)
 *   { _stdout } — capture spec output in tests (D7)
 *   { _httpPost, _paths } — forwarded to headless-fallback-provider (NFR-002)
 *
 * Zero external dependencies beyond Node built-ins and sibling lib modules.
 */
'use strict';

// ---------------------------------------------------------------------------
// _validateArgs — kept for backward compat with existing unit tests
// ---------------------------------------------------------------------------

/**
 * Required arguments per AI operation. Operations absent from this map have
 * no required argument (e.g. 'analyze-complexity').
 */
const REQUIRED_ARGS = {
  'parse-prd': 'input',
  'expand': 'id',
  'update': 'from',
  'research': 'query',
};

/**
 * Validate that all required arguments for the given operation are present.
 * Throws a descriptive Error (no .code) when a required arg is missing.
 *
 * Exported for direct unit testing of arg validation logic independent of the
 * dispatch path. The router does not call this — callers are responsible for
 * providing required args.
 *
 * @param {string} operation - AI operation name
 * @param {object} args      - argument object from the caller
 * @throws {Error} 'Missing required arg: <name>' when a required arg is absent
 */
function _validateArgs(operation, args) {
  const requiredArg = REQUIRED_ARGS[operation];
  if (requiredArg !== undefined && (args[requiredArg] === undefined || args[requiredArg] === null)) {
    throw new Error(`Missing required arg: ${requiredArg}`);
  }
}

// ---------------------------------------------------------------------------
// dispatch — primary implementation
// ---------------------------------------------------------------------------

/**
 * Dispatch an AI operation by delegating to AIRouter.
 *
 * Config is loaded fresh per call (design decision D3 — no global cache).
 * Host detection and routing logic live entirely in AIRouter.
 *
 * Error codes that may propagate from AIRouter:
 *   ERR_AI_MODE_UNKNOWN  — taskCore.aiMode is an unrecognised value (TC-002)
 *   ERR_AI_HOST_REQUIRED — agent-native with no host and no fallback (TC-007)
 *   ERR_AI_FALLBACK_FAILED — headless fallback HTTP or parse error
 *
 * @param {string} operation - AI operation name (e.g. 'parse-prd', 'expand')
 * @param {object} [args={}] - operation arguments from the MCP tool call or CLI.
 *   May include injection fields for test isolation:
 *     _configFile {string}  — path override for config.json (ai-config.cjs)
 *     _inject     {object}  — { _env, _stdout, _httpPost, _paths } forwarded to AIRouter
 * @returns {Promise<*>}
 * @throws {Error} with .code set; engine-router catches and wraps these errors
 */
async function dispatch(operation, args) {
  const safeArgs = args || {};

  // 1. Load config (respects _configFile injection for test isolation).
  const config = require('./ai-config.cjs').loadConfig(
    safeArgs._configFile ? { _configFile: safeArgs._configFile } : undefined
  );

  // 2. Build params: forward all args; AIRouter picks what it needs.
  const params = {
    tag: safeArgs.tag,
    inputContent: safeArgs.inputContent,
    context: safeArgs.context,
    ...safeArgs,
  };

  // 3. Delegate to AIRouter — all routing/detection logic is there.
  return await require('./ai-router.cjs').route(operation, params, config, safeArgs._inject);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // dispatch is the alias called by engine-router.cjs
  dispatch,
  // executeAiOp is the same function; kept for callers that import it by name
  executeAiOp: dispatch,
  // Exported for direct unit testing of arg validation logic
  _validateArgs,
};
